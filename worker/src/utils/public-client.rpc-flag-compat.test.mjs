import assert from 'node:assert/strict';
import test from 'node:test';
import { toPublicClient, sanitizePublicTags, PUBLIC_CLIENT_FIELDS } from './public-client.ts';

// 数据库层的 cfm_public_clients 已改为剥离原始 ipv4/ipv6、只下发预计算的
// has_ipv4/has_ipv6。toPublicClient 必须同时吃下两种形状，否则新库上
// 所有节点的 IP 标记会静默退化成 false（前端表现为「全部无公网 IP」）。
//
// 反向约束同样重要：只要原始字段还在，就必须以 Worker 现场计算为准，
// 不能采信上游塞进来的布尔值，否则数据库一旦被写入伪造标记就会直接穿透。

const base = { uuid: 'node-1', name: 'Fixture', tags: 'prod' };

test('new database shape: precomputed flags are honoured when raw IPs are absent', () => {
  const client = toPublicClient({ ...base, has_ipv4: true, has_ipv6: false });
  assert.equal(client.has_ipv4, true, 'a precomputed true flag must survive');
  assert.equal(client.has_ipv6, false);
  assert.ok(!Object.hasOwn(client, 'ipv4'), 'raw ipv4 must never reach the public payload');
  assert.ok(!Object.hasOwn(client, 'ipv6'), 'raw ipv6 must never reach the public payload');
});

test('new database shape: an absent or malformed flag degrades to false, never to a leak', () => {
  for (const client of [
    { ...base },
    { ...base, has_ipv4: false, has_ipv6: false },
    { ...base, has_ipv4: 'true' },
    { ...base, has_ipv4: 1 },
    { ...base, has_ipv4: null },
  ]) {
    const result = toPublicClient(client);
    assert.equal(result.has_ipv4, false, `expected false for ${JSON.stringify(client)}`);
    assert.equal(result.has_ipv6, false);
    assert.equal(typeof result.has_ipv4, 'boolean');
  }
});

test('legacy database shape: raw IPs are still evaluated, public and private alike', () => {
  assert.equal(toPublicClient({ ...base, ipv4: '106.52.67.25', ipv6: '' }).has_ipv4, true);
  assert.equal(toPublicClient({ ...base, ipv4: '10.0.0.5', ipv6: 'fe80::1' }).has_ipv4, false, 'RFC1918 must not count as a public address');
  assert.equal(toPublicClient({ ...base, ipv4: '10.0.0.5', ipv6: 'fe80::1' }).has_ipv6, false, 'link-local must not count as a public address');
});

test('a forged flag cannot override a raw private IP', () => {
  const result = toPublicClient({ ...base, ipv4: '10.0.0.5', has_ipv4: true });
  assert.equal(result.has_ipv4, false, 'the raw address wins whenever it is present');
});

test('the public field allowlist never contains raw address material', () => {
  for (const field of ['ipv4', 'ipv6', 'token', 'token_hash', 'remark', 'token_last_used_ip']) {
    assert.ok(!PUBLIC_CLIENT_FIELDS.includes(field), `${field} must not be publicly selectable`);
  }
});

test('IP-shaped tags are stripped from the public payload in both shapes', () => {
  const legacy = toPublicClient({ ...base, tags: 'ipv4;v6;prod-tag', ipv4: '', ipv6: '' });
  const current = toPublicClient({ ...base, tags: 'ipv4;v6;prod-tag', has_ipv4: false, has_ipv6: false });
  assert.equal(legacy.tags, 'prod-tag');
  assert.equal(current.tags, 'prod-tag');
  assert.equal(sanitizePublicTags('ipv6;ip4;ip6;v4;keep'), 'keep');
});
