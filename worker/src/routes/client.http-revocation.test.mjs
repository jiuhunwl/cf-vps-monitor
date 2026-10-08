import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

const OLD = 'synthetic-http-old-token-'.padEnd(64, '0');
const NEW = 'synthetic-http-new-token-'.padEnd(64, '1');
const hash = token => `sha256:${createHash('sha256').update(token).digest('hex')}`;
function fixture() {
  const original = { uuid: 'http-node-a', name: 'Original', hidden: false, token: OLD, token_hash: hash(OLD),
    remark: 'PRIVATE_NODE_A', os: 'original-os', ipv4: '192.0.2.10' };
  const control = { row: { ...original }, unavailable: false, fullReads: 0, identityReads: 0, effects: 0, usageWrites: [], usageUnavailable: false, now: Date.now() };
  const current = token => {
    if (control.unavailable) throw new Error('synthetic authentication outage');
    return token === control.row?.token ? structuredClone(control.row) : null;
  };
  const db = {
    getClientByToken: async (_database, token, _fresh, signal) => { control.fullReads++; control.lastSignal = signal; if (signal?.aborted) throw signal.reason; return current(token); },
    getClientIdentityByToken: async (_database, token, _fresh, signal) => {
      control.identityReads++;
      control.lastSignal = signal;
      if (signal?.aborted) throw signal.reason;
      const row = current(token);
      if (!row) return null;
      return { uuid: row.uuid, name: row.name, hidden: row.hidden, token: row.token,
        created_at: row.created_at, token_rotated_at: row.token_rotated_at, token_last_used_ip: row.token_last_used_ip };
    },
    getClientTokenMeta: async (_database, uuid) => uuid === control.row?.uuid ? structuredClone(control.row) : null,
    clientTokenExists: async () => false,
    rotateClientToken: async (_database, uuid, token) => {
      assert.equal(uuid, control.row.uuid);
      control.row = { ...control.row, token, token_hash: hash(token) };
      return structuredClone(control.row);
    },
    markClientTokenUsed: async (_database, uuid) => {
      control.usageWrites.push(uuid);
      if (control.usageUnavailable) throw new Error('synthetic usage write failure');
      return false;
    }, insertAuditLog: async () => {},
  };
  const loader = createWorkerLoader({ db, globals: { Date: class extends Date { static now() { return control.now; } } } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const state = createDurableState();
  const object = new LiveDataDO(state.state, {});
  const env = {
    LIVE_DATA: { idFromName: id => id, get: () => ({ fetch: request => object.fetch(request) }) },
    RATE_LIMIT: { idFromName: id => id, get: () => ({ fetch: async () => Response.json({ allowed: true, remaining: 100 }) }) },
  };
  const workerA = createWorkerLoader({ db });
  const auth = loader.load('worker/src/routes/client.ts');
  const app = new Hono();
  app.post('/full', auth.clientAuth, c => { control.effects++; return c.json(c.get('clientRecord')); });
  app.get('/identity', auth.clientIdentityAuth, c => { control.effects++; return c.json({ uuid: c.get('clientUuid'), name: c.get('clientName'), hidden: c.get('clientHidden') }); });
  const ctx = { waitUntil: task => state.state.waitUntil(task), passThroughOnException() {} };
  const request = (path, token = OLD, signal) => app.fetch(new Request(`https://panel.example.test${path}`, {
    method: path === '/full' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, signal,
  }), env, ctx);
  const writeSnapshot = client => object.fetch(new Request('https://do/agent-auth', {
    method: 'POST', body: JSON.stringify({ client }),
  }));
  const rotate = () => workerA.load('worker/src/routes/admin.ts').adminRoutes.fetch(new Request(`https://panel.example.test/clients/${control.row.uuid}/token/rotate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }), env, ctx);
  return { original, control, db, loader, auth, env, state, request, writeSnapshot, rotate };
}

test('HTTP revocation: independent Worker positives and a late old DO snapshot cannot authorize after rotation', async () => {
  const f = fixture();
  assert.equal((await f.request('/full')).status, 200);
  assert.equal((await f.request('/identity')).status, 200);
  await f.state.drain();
  const rotated = await f.rotate();
  assert.equal(rotated.status, 200);
  const { token } = await rotated.json();
  assert.equal((await f.writeSnapshot(f.original)).status, 200, 'simulate a delayed pre-rotation cache write');
  const effects = f.control.effects;
  assert.equal((await f.request('/full')).status, 401);
  assert.equal((await f.request('/identity')).status, 401);
  assert.equal(f.control.effects, effects, 'revoked requests must not enter their business handler');
  const current = await f.request('/full', token);
  assert.equal(current.status, 200);
  assert.equal(current.headers.get('X-CF-VPS-Monitor-Agent-Auth'), 'db');
  await f.state.drain();
});

test('HTTP revocation: a cold Worker cannot authorize a removed credential from a DO-only snapshot', async () => {
  const f = fixture();
  await f.writeSnapshot(f.original);
  f.control.row = { ...f.original, token: NEW, token_hash: hash(NEW) };
  assert.equal((await f.request('/full')).status, 401);
  assert.equal((await f.request('/identity')).status, 401);
  assert.equal(f.control.effects, 0);
  await f.state.drain();
});

test('HTTP revocation: positive cache does not permit a request during authoritative database failure', async () => {
  const f = fixture();
  assert.equal((await f.request('/full')).status, 200);
  assert.equal((await f.request('/identity')).status, 200);
  await f.state.drain();
  f.control.unavailable = true;
  const effects = f.control.effects;
  for (const path of ['/full', '/identity']) {
    const response = await f.request(path);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(OLD));
  }
  assert.equal(f.control.effects, effects);
});

test('HTTP metadata reuse: current identity overrides cached name/hidden without reading the full row again', async () => {
  const f = fixture();
  assert.equal((await f.request('/full')).status, 200);
  await f.state.drain();
  const fullReads = f.control.fullReads;
  const identityReads = f.control.identityReads;
  f.control.row = { ...f.control.row, name: 'Current administrator name', hidden: true };
  const response = await f.request('/full');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.name, f.control.row.name);
  assert.equal(body.hidden, true);
  assert.equal(body.token, '', 'authorization must not expose plaintext credentials through cached context');
  assert.equal(f.control.fullReads, fullReads);
  assert.equal(f.control.identityReads, identityReads + 1);
  assert.equal(response.headers.get('X-CF-VPS-Monitor-Agent-Auth'), 'db');
  await f.state.drain();
});

test('HTTP metadata reuse: a recycled token must not merge node A metadata into node B', async () => {
  const f = fixture();
  assert.equal((await f.request('/full')).status, 200);
  await f.state.drain();
  f.control.row = { ...f.original, uuid: 'http-node-b', name: 'Node B', remark: 'PRIVATE_NODE_B', os: 'node-b-os', ipv4: '192.0.2.20' };
  const response = await f.request('/full');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.uuid, 'http-node-b');
  assert.equal(body.remark, 'PRIVATE_NODE_B');
  assert.equal(body.os, 'node-b-os');
  assert.ok(!JSON.stringify(body).includes('PRIVATE_NODE_A'));
  await f.state.drain();
});

test('HTTP revocation: creating or restoring a previously rejected credential takes effect without stale denial', async () => {
  for (const path of ['/full', '/identity']) {
    const f = fixture();
    f.control.row = { ...f.original, token: NEW, token_hash: hash(NEW) };
    assert.equal((await f.request(path)).status, 401);
    const reads = f.control.fullReads + f.control.identityReads;
    f.control.row = { ...f.original };
    assert.equal((await f.request(path)).status, 200);
    assert.ok(f.control.fullReads + f.control.identityReads > reads, 'the current database must be consulted after prior rejection');
    await f.state.drain();
  }
});


test('HTTP revocation: all five real protected endpoints reject a stale credential before business processing', async () => {
  const f = fixture();
  assert.equal((await f.request('/full')).status, 200);
  assert.equal((await f.request('/identity')).status, 200);
  await f.state.drain();
  f.control.row = { ...f.original, token: NEW, token_hash: hash(NEW) };
  await f.writeSnapshot(f.original);
  for (const [method, path] of [['POST', '/uploadBasicInfo'], ['POST', '/report'], ['GET', '/policy'], ['GET', '/ping/tasks'], ['POST', '/ping/result']]) {
    const response = await f.auth.clientRoutes.fetch(new Request(`https://panel.example.test${path}`, {
      method, headers: { Authorization: `Bearer ${OLD}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    }), f.env, { waitUntil: task => f.state.state.waitUntil(task) });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  await f.state.drain();
});

test('HTTP authorization: caller cancellation is combined with the deadline and fails closed', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort(new Error('synthetic disconnect'));
  for (const path of ['/full', '/identity']) {
    assert.equal((await f.request(path, OLD, controller.signal)).status, 503);
    assert.equal(f.control.fullReads + f.control.identityReads, 0, 'already-cancelled requests do not reach the database');
  }
  assert.equal(f.control.effects, 0);
});

test('HTTP usage accounting: every request reauthorizes but usage writes are throttled per UUID', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) assert.equal((await f.request('/identity')).status, 200);
  await f.state.drain();
  assert.equal(f.control.identityReads, 3);
  assert.deepEqual(f.control.usageWrites, ['http-node-a']);
  f.control.row = { ...f.original, uuid: 'http-node-b' };
  assert.equal((await f.request('/identity')).status, 200);
  await f.state.drain();
  assert.deepEqual(f.control.usageWrites, ['http-node-a', 'http-node-b']);
});

test('HTTP usage accounting: failed writes retry after a bounded delay rather than a whole fifteen-minute lease', async () => {
  const f = fixture();
  f.control.usageUnavailable = true;
  assert.equal((await f.request('/identity')).status, 200);
  await f.state.drain();
  f.control.now += 29000;
  assert.equal((await f.request('/identity')).status, 200);
  await f.state.drain();
  assert.equal(f.control.usageWrites.length, 1);
  f.control.now += 2000;
  assert.equal((await f.request('/identity')).status, 200);
  await f.state.drain();
  assert.equal(f.control.usageWrites.length, 2);
});

test('HTTP metadata hints: hits do not extend the local metadata TTL indefinitely', async () => {
  const f = fixture();
  assert.equal((await f.request('/full')).status, 200);
  await f.state.drain();
  f.control.row = { ...f.original, os: 'updated-os' };
  await f.writeSnapshot(f.control.row);
  f.control.now += 119000;
  assert.equal((await (await f.request('/full')).json()).os, 'original-os');
  f.control.now += 2000;
  assert.equal((await (await f.request('/full')).json()).os, 'updated-os');
  await f.state.drain();
});


test('HTTP metadata reuse: same UUID with a new lifecycle cannot reuse the previous incarnation metadata', async () => {
  const f = fixture();
  assert.equal((await f.request('/full')).status, 200);
  await f.state.drain();
  const fullReads = f.control.fullReads;
  f.control.row = { ...f.original, created_at: '2026-10-06T00:00:00Z', token_rotated_at: '2026-10-06T01:00:00Z',
    remark: 'NEW_INCARNATION', os: 'new-host-os' };
  const response = await f.request('/full');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.remark, 'NEW_INCARNATION');
  assert.equal(body.os, 'new-host-os');
  assert.equal(f.control.fullReads, fullReads + 1);
  await f.state.drain();
});

test('HTTP authorization: a principal change between identity and full lookup fails closed', async () => {
  const f = fixture();
  f.db.getClientByToken = async () => ({ ...f.original, uuid: 'different-principal', remark: 'DO_NOT_MERGE' });
  const response = await f.request('/full');
  assert.equal(response.status, 401);
  assert.equal(f.control.effects, 0);
  assert.equal(f.control.usageWrites.length, 0);
});


test('HTTP authorization: late successful lookup after cancellation cannot enter the business handler', async () => {
  for (const path of ['/full', '/identity']) {
    const f = fixture();
    const controller = new AbortController();
    const cancelThenReturn = async () => {
      controller.abort(new Error('synthetic late cancellation'));
      return structuredClone(f.original);
    };
    if (path === '/full') f.db.getClientByToken = cancelThenReturn;
    else f.db.getClientIdentityByToken = cancelThenReturn;
    assert.equal((await f.request(path, OLD, controller.signal)).status, 503);
    assert.equal(f.control.effects, 0);
    assert.equal(f.control.usageWrites.length, 0);
  }
});
