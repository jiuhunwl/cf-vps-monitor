import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const result = (id = ID) => ({ command_id: id, target_version: 'v2.0.3', from_version: 'v2.0.2',
  final_version: '', status: 'success', started_at: 1, finished_at: 2 });
function fixture(record) {
  const calls = [];
  const loader = createWorkerLoader({ db: { recordAgentUpgradeResult: async (_database, value, signal) => {
    calls.push(value);
    assert.ok(signal instanceof AbortSignal);
    return record(value);
  } } });
  return { ...loader.load('worker/src/utils/upgrade-receipts.ts'), calls, database: loader.database };
}

test('upgrade receipts: raw, wrapped and batch reports preserve version fallback and deduplicate', async () => {
  const f = fixture(async () => ({ ok: true, idempotent: true, status: 'unverified' }));
  const first = { version: 'v2.0.3', upgrade_results: [result()] };
  const second = { type: 'report', data: { version: 'v2.0.4', upgrade_results: [result(OTHER)] } };
  const receipts = f.collectUpgradeReceipts([first, second], { reports: [first, second], upgrade_results: [result()] , version: 'v2.0.3' });
  assert.equal(receipts.length, 2);
  const ids = await f.persistUpgradeReceipts(f.database, 'trusted-node', receipts);
  assert.deepEqual([...ids], [ID, OTHER]);
  assert.deepEqual(f.calls.map(value => value.final_version), ['v2.0.3', 'v2.0.4']);
  assert.ok(f.calls.every(value => value.client_uuid === 'trusted-node'));
});

test('upgrade receipts: only literal RPC ok true acknowledges an ID', async () => {
  for (const answer of [undefined, null, {}, { ok: false }, { ok: 'true' }]) {
    const f = fixture(async () => answer);
    assert.deepEqual([...await f.persistUpgradeReceipts(f.database, 'trusted-node', [result()])], []);
  }
  const f = fixture(async () => { throw new Error('synthetic database failure'); });
  assert.deepEqual([...await f.persistUpgradeReceipts(f.database, 'trusted-node', [result()])], []);
});

test('upgrade receipts: partial failure preserves unconfirmed IDs and cannot change result ownership', async () => {
  const f = fixture(async value => ({ ok: value.command_id === ID }));
  const receipts = f.collectUpgradeReceipts([{ upgrade_results: [ { ...result(), client_uuid: 'foreign-node' }, result(OTHER) ] }]);
  assert.deepEqual([...await f.persistUpgradeReceipts(f.database, 'trusted-node', receipts)], [ID]);
  assert.ok(f.calls.every(value => value.client_uuid === 'trusted-node'));
});

test('upgrade receipts: malformed, conflicting, local-CLI and excessive receipts earn no confirmation', () => {
  const f = fixture(async () => ({ ok: true }));
  for (const raw of [ { ...result(), status: 'running' }, { ...result(), command_id: 'cli-local-only' },
    { ...result(), reason: 'x'.repeat(4097) }, { ...result(), finished_at: Infinity } ]) {
    assert.equal(f.collectUpgradeReceipts([{ upgrade_results: [raw] }]).length, 0);
  }
  assert.equal(f.collectUpgradeReceipts([{ upgrade_results: [result(), { ...result(), status: 'failed' }] }]).length, 0);
  assert.equal(f.collectUpgradeReceipts([{ upgrade_results: Array.from({ length: 65 }, () => result()) }]).length, 0);
});

test('upgrade receipts: completion waits for persistence and supports idempotent replies without an id field', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { await gate; return { ok: true, idempotent: true }; });
  let completed = false;
  const pending = f.persistUpgradeReceipts(f.database, 'trusted-node', [result()]).then(ids => { completed = true; return ids; });
  await Promise.resolve();
  assert.equal(completed, false);
  release();
  assert.deepEqual([...await pending], [ID]);
});


test('upgrade receipts: legacy top-level batch receipts retain the final report version fallback', () => {
  const f = fixture(async () => ({ ok: true }));
  const reports = [{ cpu: 1, version: 'v2.0.3' }];
  const collected = f.collectUpgradeReceipts(reports, { reports, upgrade_results: [result()] });
  assert.equal(collected[0].final_version, 'v2.0.3');
});
