import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeFixture } from '../test-support/runtime-fixture.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function receipt(ws, expectedType, payload) {
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      clearTimeout(timeout);
      ws.removeEventListener('message', listener);
      if (error) reject(error); else resolve(result);
    };
    const listener = event => {
      const message = JSON.parse(event.data);
      if (message.type === expectedType) finish(null, message);
      else if (message.type === 'error') finish(new Error(message.code));
    };
    const timeout = setTimeout(() => finish(new Error(`Missing ${expectedType}`)), 10000);
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify(payload));
  });
}

test('native WS backpressure retains ACKed background work and does not block another node', { timeout: 90000 }, async t => {
  const gate = { started: deferred(), release: deferred() };
  const sockets = [];
  const f = await createRuntimeFixture({ rpcHook: async ({ name, args, phase }) => {
    if (name === 'cfm_agent_upgrade_tasks' && phase === 'before' && args.input_client === 'pressure-a') {
      gate.started.resolve();
      await gate.release.promise;
    }
  } });
  t.after(async () => {
    gate.release.resolve();
    for (const ws of sockets) { try { ws.close(); } catch {} }
    await f.close();
  });
  const tokenA = 'synthetic-pressure-a-'.padEnd(64, 'a');
  const tokenB = 'synthetic-pressure-b-'.padEnd(64, 'b');
  await f.database.query("insert into clients(uuid,name,token) values ('pressure-a','A',$1),('pressure-b','B',$2)", [tokenA, tokenB]);
  await f.database.query("update settings set value='false' where key='record_enabled'");
  const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
  const stub = namespace.get(namespace.idFromName('pressure-native'));
  const connect = async (uuid, token) => {
    const response = await stub.fetch(`https://do/?role=agent&id=${uuid}`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 101);
    response.webSocket.accept();
    sockets.push(response.webSocket);
    return response.webSocket;
  };
  const a = await connect('pressure-a', tokenA);
  const b = await connect('pressure-b', tokenB);
  await gate.started.promise;
  const messages = [];
  a.addEventListener('message', event => messages.push(JSON.parse(event.data)));
  await receipt(a, 'ack', { type: 'report', data: { cpu: 1, timestamp: Date.now() } });
  await receipt(a, 'ack', { type: 'report', data: { cpu: 2, timestamp: Date.now() } });
  const rejection = await receipt(a, 'error', { type: 'report', data: { cpu: 3, timestamp: Date.now() } });
  assert.equal(rejection.code, 'REPORT_BACKPRESSURE');
  assert.equal(messages.filter(message => message.type === 'ack').length, 2);
  const snapshot = await (await stub.fetch('https://do/live?include_hidden=1')).json();
  assert.equal(snapshot.last_known['pressure-a'].cpu, 2, 'refused third report must not update accepted state');
  assert.equal((await receipt(b, 'ack', { type: 'report', data: { cpu: 12, timestamp: Date.now() } })).type, 'ack');
});
