import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeFixture } from '../test-support/runtime-fixture.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const result = n => ({ command_id: id(n), target_version: 'v2.0.3', from_version: 'v2.0.2',
  final_version: 'v2.0.3', status: 'success', started_at: 1, finished_at: 2 });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function ack(ws, payload) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => { clearTimeout(timer); ws.removeEventListener('message', listener); error ? reject(error) : resolve(value); };
    const listener = event => {
      const value = JSON.parse(event.data);
      if (value.type === 'ack') finish(null, value);
      else if (value.type === 'error') finish(new Error(value.code));
    };
    const timer = setTimeout(() => finish(new Error('Missing receipt ACK')), 15000);
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify(payload));
  });
}

test('native HTTP/WS upgrade receipts reflect SQL acceptance, ownership and timing', { timeout: 120000 }, async t => {
  let mode = 'normal';
  const gate = { started: deferred(), release: deferred() };
  const sockets = [];
  const f = await createRuntimeFixture({ rpcHook: async ({ name, args, phase }) => {
    if (name !== 'cfm_record_agent_upgrade_result' || phase !== 'before') return;
    if (args.input.command_id === id(5) && mode === 'delay') { gate.started.resolve(); await gate.release.promise; }
    if (args.input.command_id === id(6) && mode === 'reject') return Response.json({ error: 'synthetic outage' }, { status: 503 });
  } });
  t.after(async () => { gate.release.resolve(); for (const ws of sockets) { try { ws.close(); } catch {} } await f.close(); });
  const token = 'synthetic-upgrade-receipt-token-'.padEnd(64, '0');
  await f.database.query("insert into clients(uuid,name,token,version) values ('receipt-node','Receipt fixture',$1,'v2.0.3')", [token]);
  await f.database.query("update settings set value='false' where key='record_enabled'");
  for (let n = 1; n <= 6; n++) await f.database.query(
    "insert into agent_upgrade_commands(id,client_uuid,target_version,status) values ($1,$2,'v2.0.3','dispatched')",
    [id(n), n === 4 ? 'foreign-node' : 'receipt-node']);
  const post = body => f.fetch('/api/clients/report', { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify(body) });
  const single = await post({ cpu: 1, version: 'v2.0.3', upgrade_results: [result(1)] });
  assert.equal(single.status, 200);
  assert.deepEqual((await single.json()).accepted_upgrade_ids, [id(1)]);
  const batch = await post({ reports: [
    { cpu: 2, version: 'v2.0.3', upgrade_results: [result(1), result(2)] },
    { cpu: 3, version: 'v2.0.3', upgrade_results: [{ ...result(4), client_uuid: 'foreign-node' }] },
  ] });
  assert.equal(batch.status, 200);
  assert.deepEqual((await batch.json()).accepted_upgrade_ids, [id(1), id(2)]);
  assert.equal((await f.database.query('select status from agent_upgrade_commands where id=$1', [id(4)])).rows[0].status, 'dispatched');
  const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
  const connect = async suffix => {
    const stub = namespace.get(namespace.idFromName(`upgrade-receipts-${suffix}`));
    const response = await stub.fetch('https://do/?role=agent&id=receipt-node', { headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 101);
    response.webSocket.accept(); sockets.push(response.webSocket);
    return response.webSocket;
  };
  const ws = await connect('batch');
  const response = await ack(ws, { type: 'reports', reports: [
    { cpu: 4, version: 'v2.0.3' }, { cpu: 5, version: 'v2.0.3', upgrade_results: [result(3)] },
  ] });
  assert.deepEqual(response.accepted_upgrade_ids, [id(3)]);
  const delayed = await connect('delayed');
  mode = 'delay';
  let done = false;
  const waiting = ack(delayed, { type: 'report', data: { cpu: 6, version: 'v2.0.3', upgrade_results: [result(5)] } }).then(value => { done = true; return value; });
  await gate.started.promise;
  assert.equal(done, false);
  assert.equal((await f.database.query('select status from agent_upgrade_commands where id=$1', [id(5)])).rows[0].status, 'dispatched');
  gate.release.resolve();
  assert.deepEqual((await waiting).accepted_upgrade_ids, [id(5)]);
  mode = 'reject';
  const failed = await post({ cpu: 7, version: 'v2.0.3', upgrade_results: [result(6)] });
  assert.equal(failed.status, 200, 'receipt failure must not misrepresent accepted telemetry');
  assert.deepEqual((await failed.json()).accepted_upgrade_ids, []);
  assert.equal((await f.database.query('select status from agent_upgrade_commands where id=$1', [id(6)])).rows[0].status, 'dispatched');
});
