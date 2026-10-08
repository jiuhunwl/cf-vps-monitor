import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

const OLD = 'synthetic-old-agent-token-'.padEnd(64, '0');
const NEW = 'synthetic-new-agent-token-'.padEnd(64, '1');
const ID = 'session-fixture-node';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.ok(predicate(), 'expected asynchronous boundary was not reached');
}

// Node has no native 101 Response/WebSocketPair. Emulate only platform objects;
// authorization, ordering, retirement and dispatch execute the production DO.
class UpgradeResponse extends Response {
  constructor(body, init = {}) {
    super(body, init.status === 101 ? { ...init, status: 200 } : init);
    if (init.status === 101) {
      Object.defineProperty(this, 'status', { value: 101 });
      this.webSocket = init.webSocket;
    }
  }
}
function fixture({ closeFails = false, sockets = [], manualTimeout = false, realReports = false } = {}) {
  const control = { token: OLD, queries: 0, messages: 0, beforeIdentity: null, metadataWrites: 0 };
  const state = createDurableState([], sockets);
  const pairs = [];
  const db = {
    getClientIdentityByToken: async (_database, token) => {
      control.queries++;
      const row = token === control.token ? { uuid: ID, name: 'Current name', hidden: true, token } : null;
      if (control.beforeIdentity) await control.beforeIdentity();
      return row;
    },
    clientTokenExists: async () => false,
    getClientTokenMeta: async (_database, uuid) => uuid === ID ? { uuid: ID, name: 'Current name', token: control.token } : null,
    rotateClientToken: async (_database, uuid, token) => {
      assert.equal(uuid, ID);
      control.token = token;
      return { uuid: ID, name: 'Current name', hidden: true, token,
        token_hash: await loader.load('worker/src/utils/client.ts').hashAgentToken(token) };
    },
    markClientTokenUsed: async () => {}, insertAuditLog: async () => {},
    getClient: async () => ({ uuid: ID, name: 'Current name', hidden: true, region: '' }),
    updateClient: async () => { control.metadataWrites++; },
    getSettingsByKeys: async () => ({ record_enabled: 'false' }),
  };
  const loader = createWorkerLoader({ db, globals: {
    Response: UpgradeResponse,
    ...(manualTimeout ? { setTimeout: callback => { control.fireTimeout = callback; return 1; }, clearTimeout: () => {} } : {}),
    WebSocketPair: class {
      constructor() {
        const client = createSocket({});
        const server = createSocket({});
        if (closeFails) server.ws.close = () => { throw new Error('synthetic close failure'); };
        pairs.push({ client, server });
        return { 0: client.ws, 1: server.ws };
      }
    },
  } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(state.state, {});
  object.buildAgentPolicy = async () => ({ type: 'policy', synthetic: true });
  if (!realReports) object.handleMessage = async () => { control.messages++; };
  const env = { LIVE_DATA: { idFromName: id => id, get: () => ({ fetch: request => object.fetch(request) }) } };
  const connect = (token = OLD, id = ID) => object.fetch(new Request(`https://do/?role=agent&id=${id}&name=Untrusted&hidden=0`, {
    headers: { Upgrade: 'websocket', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }));
  const remove = () => object.fetch(new Request('https://do/client-remove', {
    method: 'POST', body: JSON.stringify({ uuid: ID, keepMetadata: true }),
  }));
  return { control, db, loader, LiveDataDO, object, state, pairs, env, connect, remove };
}

test('CFVM-004: final DO authorization rejects missing, revoked and wrong-node credentials without replacing a valid socket', async () => {
  const f = fixture();
  assert.equal((await f.connect()).status, 101);
  const original = f.pairs[0].server.ws;
  assert.equal(original.deserializeAttachment().clientName, 'Current name');
  assert.equal(original.deserializeAttachment().hidden, true);
  assert.equal((await f.connect('')).status, 401);
  assert.equal((await f.connect(NEW)).status, 401);
  assert.equal((await f.connect(OLD, 'another-node')).status, 401);
  assert.equal(f.object.sessions.get(ID), original);
  assert.equal(original.readyState, 1);
  await f.state.drain();
});

test('CFVM-004: removal waits for in-flight authorization and retires its socket even when close fails', async () => {
  const f = fixture({ closeFails: true });
  const started = deferred(), release = deferred();
  f.control.beforeIdentity = async () => { started.resolve(); await release.promise; };
  const pending = f.connect();
  await started.promise;
  const before = f.object.agentConnectionOperations.get(ID);
  f.control.token = NEW;
  const removing = f.remove();
  await until(() => f.object.agentConnectionOperations.get(ID) !== before);
  assert.equal((await f.connect(NEW)).status, 429, 'new handshakes cannot overtake queued revocation');
  release.resolve();
  assert.equal((await pending).status, 101);
  assert.equal((await removing).status, 200);
  const old = f.pairs[0].server.ws;
  assert.equal(old.deserializeAttachment().agentAuthVersion, 0);
  await f.object.webSocketMessage(old, JSON.stringify({ type: 'report', data: { cpu: 1 } }));
  assert.equal(f.control.messages, 0);
  const recovered = new f.LiveDataDO(f.state.state, {});
  assert.equal(recovered.sessions.has(ID), false, 'retired accepted socket cannot revive on hibernation recovery');
  f.control.beforeIdentity = null;
  assert.equal((await f.connect(OLD)).status, 401);
  assert.equal((await f.connect(NEW)).status, 101);
  await f.state.drain();
});

test('CFVM-004: credential DB failure leaves an existing connection intact', async () => {
  const f = fixture();
  assert.equal((await f.connect()).status, 101);
  const old = f.pairs[0].server.ws;
  f.control.beforeIdentity = async () => { throw new Error('synthetic database outage'); };
  assert.equal((await f.connect()).status, 503);
  assert.equal(f.object.sessions.get(ID), old);
  assert.equal(old.readyState, 1);
  await f.state.drain();
});

for (const closeFails of [false, true]) {
  test(`CFVM-004: restore retires Agent authority before ${closeFails ? 'a failed' : 'a successful'} close`, async () => {
    const f = fixture({ closeFails });
    assert.equal((await f.connect()).status, 101);
    await f.state.drain();
    const socket = f.pairs[0].server.ws;
    assert.equal(socket.deserializeAttachment().agentAuthVersion, 1);
    const close = socket.close;
    let observedClose;
    socket.close = (code, reason) => {
      observedClose ??= { code, reason, agentAuthVersion: socket.deserializeAttachment().agentAuthVersion };
      return close(code, reason);
    };

    const restored = await f.object.fetch(new Request('https://do/clients-restore', {
      method: 'POST', body: JSON.stringify({ clients: [{ uuid: ID, name: 'Restored node', hidden: false }] }),
    }));
    assert.equal(restored.status, 200);
    assert.deepEqual(observedClose, { code: 1008, reason: 'Client configuration restored', agentAuthVersion: 0 });
    assert.equal(socket.deserializeAttachment().agentAuthVersion, 0);
    assert.equal(f.object.sessions.has(ID), false);
    await f.object.webSocketMessage(socket, JSON.stringify({ type: 'report', data: { cpu: 1 } }));
    assert.equal(f.control.messages, 0, 'a pre-restore connection cannot dispatch reports after revocation');
    const recovered = new f.LiveDataDO(f.state.state, {});
    assert.equal(recovered.sessions.has(ID), false, 'hibernation recovery cannot revive the retired connection');
    await f.state.drain();
  });
}

test('CFVM-004: restore invalidates an authorization result obtained before the restore', async () => {
  const f = fixture();
  const started = deferred(), release = deferred();
  f.control.beforeIdentity = async () => { started.resolve(); await release.promise; };
  const pending = f.connect();
  await started.promise;
  const restored = await f.object.fetch(new Request('https://do/clients-restore', {
    method: 'POST', body: JSON.stringify({ clients: [{ uuid: ID, name: 'Restored node', hidden: false }] }),
  }));
  assert.equal(restored.status, 200);
  release.resolve();
  assert.equal((await pending).status, 409);
  assert.equal(f.state.sockets.length, 0);
});

test('CFVM-004: verified attachments survive report compaction; replaced sockets cannot send queued policies', async () => {
  const f = fixture({ closeFails: true });
  assert.equal((await f.connect()).status, 101);
  await f.state.drain();
  const old = f.pairs[0].server;
  f.object.rememberAgentReportAttachment(old.ws, ID, 'Current name', true, { cpu: 7 }, Date.now());
  assert.equal(old.ws.deserializeAttachment().agentAuthVersion, 1);
  const pendingPolicy = deferred();
  f.object.buildAgentPolicy = () => pendingPolicy.promise;
  const sending = f.object.sendCurrentPolicyToAgent(old.ws, Date.now(), false, false, ID);
  await f.remove();
  const before = old.messages.length;
  pendingPolicy.resolve({ type: 'policy', secret: 'must-not-send' });
  await sending;
  assert.equal(old.messages.length, before);
});

test('CFVM-004: legacy unverified attachments cannot hydrate or dispatch messages', async () => {
  const legacy = createSocket({ role: 'agent', clientId: ID, clientName: 'Legacy', hidden: false });
  const f = fixture({ sockets: [legacy.ws] });
  assert.equal(f.object.sessions.has(ID), false);
  await f.object.webSocketMessage(legacy.ws, '{"type":"ping_result"}');
  assert.equal(f.control.messages, 0);
});

test('CFVM-004: an independently warmed Worker cache cannot authorize a revoked WS or metadata write', async () => {
  const f = fixture();
  const cachedWorker = f.loader.load('worker/src/routes/client.ts');
  assert.equal((await cachedWorker.getAgentClientIdentityByToken(f.loader.database, OLD, f.env))?.uuid, ID);
  const otherWorker = createWorkerLoader({ db: f.db });
  const { adminRoutes } = otherWorker.load('worker/src/routes/admin.ts');
  const rotated = await adminRoutes.fetch(new Request(`https://panel.example.test/clients/${ID}/token/rotate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }), f.env, { waitUntil: promise => f.state.state.waitUntil(promise) });
  assert.equal(rotated.status, 200);
  const { token: currentToken } = await rotated.json();
  // A delayed stale cache snapshot must not become a WS authority either.
  const oldHash = await f.loader.load('worker/src/utils/client.ts').hashAgentToken(OLD);
  await f.object.fetch(new Request('https://do/agent-auth', { method: 'POST',
    body: JSON.stringify({ client: { uuid: ID, name: 'Stale cache', hidden: false, token_hash: oldHash } }),
  }));
  const { wsRoutes } = f.loader.load('worker/src/routes/websocket.ts');
  const response = await wsRoutes.fetch(new Request('https://panel.example.test/clients/report', {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${OLD}`, 'CF-IPCountry': 'US' },
  }), f.env, { waitUntil: promise => f.state.state.waitUntil(promise) });
  assert.equal(response.status, 401);
  assert.equal(f.control.metadataWrites, 0);
  assert.equal((await f.connect(OLD)).status, 401, 'DO also ignores the stale snapshot when called directly');
  assert.equal(f.state.sockets.length, 0);
  assert.equal((await f.connect(currentToken)).status, 101);
  await f.state.drain();
});

test('CFVM-004: query-token compatibility forwards real Bearer credentials and messages do not re-query identity', async () => {
  const f = fixture();
  const { wsRoutes } = f.loader.load('worker/src/routes/websocket.ts');
  const response = await wsRoutes.fetch(new Request(`https://panel.example.test/clients/report?token=${OLD}`, {
    headers: { Upgrade: 'websocket' },
  }), f.env, { waitUntil: promise => f.state.state.waitUntil(promise) });
  assert.equal(response.status, 101);
  assert.equal(f.control.queries, 2);
  const socket = f.pairs[0].server.ws;
  for (let i = 0; i < 3; i++) await f.object.webSocketMessage(socket, '{"type":"report","data":{"cpu":3}}');
  assert.equal(f.control.messages, 3);
  assert.equal(f.control.queries, 2, 'no per-message identity RPC added');
  await f.state.drain();
});


test('CFVM-004: timed-out identity lookup cannot register a late result after releasing the gate', async () => {
  const f = fixture({ manualTimeout: true });
  const started = deferred(), release = deferred();
  f.control.beforeIdentity = async () => { started.resolve(); await release.promise; };
  const pending = f.connect();
  await started.promise;
  f.control.fireTimeout();
  assert.equal((await pending).status, 503);
  assert.equal(f.object.agentConnectionOperations.has(ID), false);
  release.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.state.sockets.length, 0);
  assert.equal(f.object.sessions.has(ID), false);
});


test('CFVM-004: a late frame from a replaced socket cannot invalidate the new socket report lifecycle', async () => {
  const f = fixture({ closeFails: true });
  assert.equal((await f.connect()).status, 101);
  const old = f.pairs[0].server.ws;
  assert.equal((await f.connect()).status, 101);
  const started = deferred(), release = deferred();
  const current = f.object.runClientReport(ID, async lifecycle => {
    started.resolve(); await release.promise;
    f.object.assertReportCurrent(lifecycle);
  });
  await started.promise;
  await f.object.webSocketMessage(old, '{"type":"report","data":{"cpu":99}}');
  release.resolve();
  await current;
  assert.equal(f.control.messages, 0);
  await f.state.drain();
});


test('CFVM-004: real report persistence interrupted by removal cannot acknowledge or revive its session', async () => {
  const f = fixture({ closeFails: true, realReports: true });
  assert.equal((await f.connect()).status, 101);
  const socket = f.pairs[0].server;
  await f.object.webSocketMessage(socket.ws, JSON.stringify({ type: 'report', data: { cpu: 5, timestamp: Date.now() } }));
  await f.state.drain();
  assert.ok(socket.messages.some(message => message.type === 'ack'), 'legitimate report must exercise the real ACK path');
  assert.equal(socket.ws.deserializeAttachment().agentAuthVersion, 1);
  const started = deferred(), release = deferred();
  const originalPut = f.state.state.storage.put;
  f.state.state.storage.put = async (key, value) => {
    if (key === `http-live:${ID}`) { started.resolve(); await release.promise; }
    return originalPut(key, value);
  };
  const pending = f.object.webSocketMessage(socket.ws, JSON.stringify({ type: 'report', data: { cpu: 6, timestamp: Date.now() } }));
  await started.promise;
  const ackCount = socket.messages.filter(message => message.type === 'ack').length;
  assert.equal((await f.remove()).status, 200);
  release.resolve();
  await pending;
  await f.state.drain();
  assert.equal(socket.messages.filter(message => message.type === 'ack').length, ackCount);
  assert.equal(socket.ws.deserializeAttachment().agentAuthVersion, 0);
  assert.equal(f.object.sessions.has(ID), false);
  const snapshot = await (await f.object.fetch(new Request('https://do/live?include_hidden=1'))).json();
  assert.ok(!snapshot.online.includes(ID));
});
