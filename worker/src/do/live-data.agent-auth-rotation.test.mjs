import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';
import { hashAgentToken } from '../utils/client.ts';

// 「重置 Token」必须让旧 Token 立即失效。这条链路有两层缓存：Worker 进程内的
// agentAuthCache（按 token hash 索引，120s TTL，由 invalidateAgentClientAuthCache 清理）
// 和 DO 里的 agent-auth 快照（按 uuid -> hash 索引，持久化，无 TTL）。
// 前者按 uuid 失效是对的；后者原先只写不回收，会在轮换后留下一个删不掉的孤儿快照，
// 使旧 Token 永久保持有效 —— 因为 client.ts 的 DO 查询早于 DB 查询，命中即直接放行。
const OLD_TOKEN = 'audit-rotation-old-agent-token-00000000001';
const NEW_TOKEN = 'audit-rotation-new-agent-token-00000000002';
const UUID = 'node-a';

async function fixture() {
  const clients = [{
    uuid: UUID,
    name: 'Node A',
    hidden: false,
    token: OLD_TOKEN,
    token_hash: await hashAgentToken(OLD_TOKEN),
  }];
  const db = {
    clientTokenExists: async () => false,
    getClientTokenMeta: async (_db, uuid) => clients.find(client => client.uuid === uuid) || null,
    rotateClientToken: async (_db, uuid, token) => {
      const client = clients.find(row => row.uuid === uuid);
      if (!client) return null;
      client.token = token;
      client.token_hash = await hashAgentToken(token);
      return { ...client };
    },
    getClientByToken: async (_db, token) => clients.find(client => client.token === token) || null,
    getClientIdentityByToken: async (_db, token) => clients.find(client => client.token === token) || null,
    markClientTokenUsed: async () => false,
    insertAuditLog: async () => {},
  };

  const loader = createWorkerLoader({ db });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const state = createDurableState();
  const object = new LiveDataDO(state.state, {});
  const env = {
    LIVE_DATA: {
      idFromName: id => id,
      get: () => ({ fetch: request => object.fetch(request) }),
    },
  };
  const executionCtx = { waitUntil: job => state.state.waitUntil(job), passThroughOnException() {} };
  const doRequest = (path, body) => object.fetch(new Request(`https://do${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  return {
    db,
    loader,
    state,
    env,
    executionCtx,
    doRequest,
    clientRoutes: loader.load('worker/src/routes/client.ts'),
    adminRoutes: loader.load('worker/src/routes/admin.ts').adminRoutes,
  };
}

test('AUD-07 superseding an Agent credential retires the previous snapshot for that uuid', async () => {
  const f = await fixture();
  const oldHash = await hashAgentToken(OLD_TOKEN);
  const newHash = await hashAgentToken(NEW_TOKEN);
  const snapshot = tokenHash => ({ client: { uuid: UUID, name: 'Node A', hidden: false, token_hash: tokenHash } });

  assert.equal((await f.doRequest('/agent-auth', snapshot(oldHash))).status, 200);
  assert.equal((await f.doRequest('/agent-auth/lookup', { token_hash: oldHash })).status, 200,
    'precondition: the original credential resolves from the snapshot store');

  // 只做「写新」、不做「回收旧」就是轮换路径下会真实发生的那一步：轮换时 disconnect 与
  // upsert 是两个独立 fetch，谁先到 DO 不可控；一旦 upsert 先落地，uuid 索引就指向新 hash，
  // 之后按 uuid 删除只会删掉新快照，旧 hash 的快照再也没有任何索引指向它。
  assert.equal((await f.doRequest('/agent-auth', snapshot(newHash))).status, 200);
  assert.equal((await f.doRequest('/agent-auth/lookup', { token_hash: newHash })).status, 200);
  assert.equal((await f.doRequest('/agent-auth/lookup', { token_hash: oldHash })).status, 404,
    'the uuid -> hash index is one-to-one: the superseded hash must be reclaimed by the writer, otherwise a rotated Agent token stays valid forever');

  // 索引本身必须仍然完好，否则按 uuid 的删除会连带留在孤岛上的新快照也删不掉。
  assert.equal((await f.doRequest('/agent-auth/remove', { uuid: UUID })).status, 200);
  assert.equal((await f.doRequest('/agent-auth/lookup', { token_hash: newHash })).status, 404);
  assert.equal((await f.doRequest('/agent-auth/lookup', { token_hash: oldHash })).status, 404);
});

test('AUD-08 rotating a client token through the admin route revokes the old Agent credential', async () => {
  const f = await fixture();
  await f.doRequest('/agent-auth', {
    client: { uuid: UUID, name: 'Node A', hidden: false, token_hash: await hashAgentToken(OLD_TOKEN) },
  });

  const before = await f.clientRoutes.getAgentClientByToken(f.loader.database, OLD_TOKEN, f.env);
  assert.equal(before?.uuid, UUID, 'precondition: the old credential is currently valid while DO metadata is present');

  const response = await f.adminRoutes.fetch(new Request(`https://panel.synthetic.test/clients/${UUID}/token/rotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }), f.env, f.executionCtx);
  assert.equal(response.status, 200, await response.clone().text());
  const { token: newToken } = await response.json();
  await f.state.drain();

  assert.equal(await f.clientRoutes.getAgentClientByToken(f.loader.database, OLD_TOKEN, f.env), null,
    'the revoked token must stop authenticating as soon as the rotation returns, not only after the Durable Object restarts');
  assert.equal((await f.clientRoutes.getAgentClientByToken(f.loader.database, newToken, f.env))?.uuid, UUID,
    'the freshly issued credential must authenticate');
});


for (const failure of ['network', 'http']) {
  test(`CFVM-004 token rotation reports partial failure when disconnect ${failure} fails`, async () => {
    const f = await fixture();
    const originalGet = f.env.LIVE_DATA.get;
    f.env.LIVE_DATA.get = id => {
      const original = originalGet(id);
      return { fetch: request => {
        if (new URL(request.url).pathname === '/client-remove') {
          if (failure === 'network') return Promise.reject(new Error('synthetic disconnect failure'));
          return Promise.resolve(Response.json({ error: 'synthetic unavailable' }, { status: 503 }));
        }
        return original.fetch(request);
      } };
    };
    const response = await f.adminRoutes.fetch(new Request(`https://panel.synthetic.test/clients/${UUID}/token/rotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }), f.env, f.executionCtx);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'AGENT_TOKEN_REVOCATION_PENDING');
    assert.equal(body.token_rotated, true, 'database mutation is not misrepresented as rolled back');
    assert.equal(Object.hasOwn(body, 'token'), false);
    await f.state.drain();
  });
}


test('CFVM-004 absent rotation result cannot be reported as a successful token change', async () => {
  const f = await fixture();
  f.db.rotateClientToken = async () => null;
  const response = await f.adminRoutes.fetch(new Request(`https://panel.synthetic.test/clients/${UUID}/token/rotate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }), f.env, f.executionCtx);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.code, 'AGENT_TOKEN_ROTATION_UNCONFIRMED');
  assert.equal(Object.hasOwn(body, 'token'), false);
  await f.state.drain();
});
