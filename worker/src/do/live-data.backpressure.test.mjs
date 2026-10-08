import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';
import { PendingIngressBudget } from '../utils/pending-ingress-budget.ts';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.ok(predicate(), 'expected asynchronous boundary');
}
function fixture(limits = {}, globals = {}) {
  const state = createDurableState();
  const { LiveDataDO } = createWorkerLoader({ db: {
    getSettingsByKeys: async () => ({ record_enabled: 'false' }), insertAuditLog: async () => {},
  }, globals }).load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(state.state, {});
  const budget = new PendingIngressBudget({ perClientMessages: 2, perClientBytes: 1024, globalMessages: 3, globalBytes: 2048, ...limits });
  object.agentPendingIngress = budget;
  object.buildAgentPolicy = async () => ({ type: 'policy' });
  const socket = id => {
    const result = createSocket({ role: 'agent', agentAuthVersion: 1, clientId: id, clientName: id, hidden: false });
    object.registerSession(result.ws, result.ws.deserializeAttachment());
    return result;
  };
  return { object, budget, state, socket };
}

test('WS admission: startup wait is charged before parsing and refuses global overflow without ACK', async () => {
  let parsed = 0;
  const f = fixture({ globalMessages: 2 }, { JSON: { stringify: JSON.stringify, parse: value => { parsed++; return JSON.parse(value); } } });
  const startup = deferred();
  f.object.httpClientsReady = startup.promise;
  f.object.handleMessage = async () => {};
  const a = f.socket('a'), b = f.socket('b'), c = f.socket('c');
  const before = parsed;
  const first = f.object.webSocketMessage(a.ws, '{}');
  const second = f.object.webSocketMessage(b.ws, '{}');
  assert.equal(f.budget.snapshot().messages, 2);
  assert.equal(parsed, before);
  await f.object.webSocketMessage(c.ws, '{}');
  assert.equal(parsed, before);
  assert.ok(c.messages.some(message => message.code === 'REPORT_BACKPRESSURE'));
  assert.ok(!c.messages.some(message => message.type === 'ack'));
  assert.equal(c.ws.deserializeAttachment().agentAuthVersion, 0);
  startup.resolve();
  await Promise.all([first, second]);
  assert.equal(f.budget.snapshot().messages, 0);
});

test('WS admission: oversized strings are rejected before encoding or startup awaits', async () => {
  const f = fixture({}, { TextEncoder: class { encode() { throw new Error('oversized input must not be encoded'); } } });
  f.object.httpClientsReady = deferred().promise;
  const a = f.socket('a');
  await f.object.webSocketMessage(a.ws, 'x'.repeat(512 * 1024 + 1));
  assert.ok(a.messages.some(message => message.code === 'REPORT_TOO_LARGE'));
  assert.equal(f.budget.snapshot().messages, 0);
});

test('WS admission: UTF-8 and binary ceilings apply before JSON parsing', async () => {
  for (const payload of ['é'.repeat(256 * 1024 + 1), new ArrayBuffer(512 * 1024 + 1)]) {
    const f = fixture();
    const a = f.socket('a');
    let handled = false;
    f.object.handleMessage = async () => { handled = true; };
    await f.object.webSocketMessage(a.ws, payload);
    assert.equal(handled, false);
    assert.equal(f.budget.snapshot().messages, 0);
    assert.ok(a.messages.some(message => message.code === 'REPORT_TOO_LARGE'));
  }
});

test('WS admission: policy, history and network jobs retain the real report reservation after ACK', async () => {
  const f = fixture();
  const policy = deferred(), history = deferred(), network = deferred();
  f.object.sendCurrentPolicyToAgent = () => policy.promise;
  f.object.persistReportsSequential = () => history.promise;
  f.object.syncNetworkMetadataFromReport = () => network.promise;
  const a = f.socket('a');
  const pending = f.object.webSocketMessage(a.ws, '{"cpu":3}');
  await until(() => a.messages.some(message => message.type === 'ack'));
  assert.equal(f.budget.snapshot().messages, 1);
  policy.resolve(); history.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.budget.snapshot().messages, 1, 'network descendant still holds payload');
  network.resolve();
  await pending;
  await f.state.drain();
  assert.equal(f.budget.snapshot().messages, 0);
});

test('WS admission: standalone ping and nested background work cannot escape the lease', async () => {
  const f = fixture();
  const first = deferred(), nested = deferred();
  f.object.persistPingResult = () => first.promise.then(() => {
    f.object.runBackground('ping_persistence', nested.promise);
  });
  const a = f.socket('a');
  const pending = f.object.webSocketMessage(a.ws, '{"type":"ping_result","results":[]}');
  await until(() => f.budget.snapshot().messages === 1);
  first.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.budget.snapshot().messages, 1);
  nested.resolve();
  await pending;
  await f.state.drain();
  assert.equal(f.budget.snapshot().messages, 0);
});

test('WS admission: malformed input and rejected background work release all capacity', async () => {
  const f = fixture();
  const a = f.socket('a');
  await f.object.webSocketMessage(a.ws, '{bad-json');
  assert.equal(f.budget.snapshot().messages, 0);
  f.object.handleMessage = async () => { f.object.runBackground('ping_persistence', Promise.reject(new Error('synthetic failure'))); };
  await f.object.webSocketMessage(a.ws, '{}');
  await f.state.drain();
  assert.deepEqual(f.budget.snapshot(), { messages: 0, bytes: 0, clients: 0 });
});

test('WS admission: reconnecting a UUID does not erase outstanding reservations', async () => {
  const f = fixture({ perClientMessages: 1 });
  const startup = deferred();
  f.object.httpClientsReady = startup.promise;
  f.object.handleMessage = async () => {};
  const old = f.socket('same');
  const pending = f.object.webSocketMessage(old.ws, '{}');
  const replacement = f.socket('same');
  await f.object.webSocketMessage(replacement.ws, '{}');
  assert.ok(replacement.messages.some(message => message.code === 'REPORT_BACKPRESSURE'));
  assert.equal(f.budget.snapshot().messages, 1);
  startup.resolve();
  await pending;
  assert.equal(f.budget.snapshot().messages, 0);
});


for (const reports of [[], Array.from({ length: 301 }, () => ({ cpu: 1 })), [{ cpu: 1 }, null]]) {
  test(`WS and internal HTTP batches (${reports.length}) are rejected before prefix persistence`, async () => {
    const f = fixture({ perClientBytes: 1024 * 1024, globalBytes: 4 * 1024 * 1024 });
    const a = f.socket('a');
    let written = 0;
    f.object.updateClientReport = async () => { written++; return { cpu: 1 }; };
    await f.object.webSocketMessage(a.ws, JSON.stringify({ type: 'reports', reports }));
    assert.ok(a.messages.some(message => message.code === 'REPORT_REJECTED'));
    assert.ok(!a.messages.some(message => message.type === 'ack'));
    const response = await f.object.fetch(new Request('https://do/client-report', {
      method: 'POST', body: JSON.stringify({ uuid: 'a', reports }),
    }));
    assert.equal(response.status, 400);
    assert.equal(written, 0);
    assert.equal(f.budget.snapshot().messages, 0);
  });
}
