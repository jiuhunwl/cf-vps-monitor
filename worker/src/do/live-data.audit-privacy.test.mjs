import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

const sourceIp = '8.8.4.4';
const privateV4 = '10.77.0.5';
const privateV6 = 'fd00::77';
const publicClient = {
  uuid: 'public-fixture', name: 'Public fixture', hidden: false,
  ipv4: sourceIp, ipv6: '', remark: 'ADMIN_PRIVATE_NOTE', public_remark: 'public note',
  tags: 'fixture', traffic_reset_day: 1,
};
const hiddenClient = { ...publicClient, uuid: 'hidden-fixture', name: 'HIDDEN_PRIVATE_NAME', hidden: true, remark: 'HIDDEN_PRIVATE_NOTE' };

async function fixture({ overrides = {} } = {}) {
  const viewers = [false, true].map(includeHidden => createSocket({
    role: 'viewer', clientId: includeHidden ? 'admin-viewer' : 'public-viewer',
    clientName: 'viewer', hidden: false, includeHidden, viewerExpiresAt: Date.now() + 120000,
  }));
  const storage = createDurableState([], viewers.map(viewer => viewer.ws));
  const db = {
    getSettingsByKeys: async () => ({ record_enabled: 'false' }),
    listPublicClientRows: async () => structuredClone([publicClient, hiddenClient]),
    getHistoryStorageRowCounts: async () => ({ records: 0, gpu_records: 0, gpu_snapshots: 0, ping_records: 0, ping_snapshots: 0 }),
    getHistoryStorageBytes: async () => ({ total: 0 }),
    getHistoryStorageUsage: async () => ({ live_rows: 0, live_row_bytes: 0, estimated_live_storage_bytes: 0, allocated_bytes: 0, reusable_bytes: null, measurement: 'live-row-bytes-plus-index-estimate' }),
    insertRecord: async () => {}, updateClient: async () => {},
    // 默认没有任何管理员会话：getUserByUuid 返回 null，hasAdminSession 恒为 false。
    // 需要「真的被放行」的用例必须自带 overrides，并配一条正向对照断言，
    // 否则拿到的只是「cookie 无效」这个平凡结论。
    getUserByUuid: async () => null,
    listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
    fetchAgentUpgradeTasksForClient: async () => [],
    ...overrides,
  };
  const loader = createWorkerLoader({ db, expose: {
    'worker/src/routes/admin.ts': ['syncLiveClientMeta', 'hideAdminClientToken'],
  } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(storage.state, {});
  const env = {
    JWT_SECRET: 'audit-synthetic-secret-at-least-32-bytes',
    LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: request => object.fetch(request) }) },
  };
  const executionCtx = { waitUntil: promise => storage.state.waitUntil(promise), passThroughOnException() {} };
  await object.fetch(new Request('https://do/admin-clients-snapshot', {
    method: 'PUT', body: JSON.stringify({ clients: [publicClient, hiddenClient] }),
  }));
  const app = new Hono();
  app.route('/api', loader.load('worker/src/routes/public.ts').publicRoutes);
  app.route('/api', loader.load('worker/src/routes/websocket.ts').wsRoutes);
  return { object, storage, viewers, loader, env, executionCtx, app };
}

function assertPublicBytes(value, label) {
  const serialized = JSON.stringify(value);
  for (const secret of [sourceIp, privateV4, privateV6, 'ADMIN_PRIVATE_NOTE', 'SYNTHETIC_SECRET', 'HIDDEN_PRIVATE_NAME']) {
    assert.ok(!serialized.includes(secret), `${label} disclosed ${secret}`);
  }
}

/**
 * 管理员受众允许看到隐藏节点名等管理信息，因此不能套用 assertPublicBytes；
 * 但**明文地址**对任何受众都不允许出现。这是本文件的核心不变量。
 */
function assertNoRawAddress(value, label) {
  const serialized = JSON.stringify(value);
  for (const address of [sourceIp, privateV4, privateV6]) {
    assert.ok(!serialized.includes(address), `${label} disclosed the raw address ${address}`);
  }
}

test('AUD-02: all anonymous HTTP and WebSocket live outputs apply the public field boundary', async () => {
  const f = await fixture();
  for (const client of [publicClient, hiddenClient]) {
    const socket = createSocket({ role: 'agent', clientId: client.uuid, clientName: client.name, hidden: client.hidden, sourceIp });
    f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
    await f.object.webSocketMessage(socket.ws, JSON.stringify({ type: 'report', data: {
      cpu: 4, timestamp: Date.now(), ipv4: privateV4, ipv6: privateV6,
      basic_info: { os: 'Linux', ipv4: privateV4, ipv6: privateV6, password: 'SYNTHETIC_SECRET' },
      remark: 'ADMIN_PRIVATE_NOTE', arbitrary_extension: { credential: 'SYNTHETIC_SECRET' },
    } }));
  }
  await f.storage.drain();
  const update = f.viewers[0].messages.find(message => message.type === 'update');
  assert.equal(update?.data.cpu, 4);
  assertPublicBytes(f.viewers[0].messages.filter(message => message.type === 'update'), 'anonymous WS update');
  f.object.sendSnapshot(f.viewers[0].ws);
  assertPublicBytes(f.viewers[0].messages.at(-1), 'anonymous WS snapshot');
  for (const route of ['/api/live', '/api/ws/live', '/api/live/clients', '/api/public/bootstrap?_fresh=1', '/api/public/bootstrap?_fresh=1&include_hidden=1', '/api/live?include_hidden=1']) {
    const response = await f.app.fetch(new Request(`https://monitor.example.test${route}`, {
      headers: { 'CF-Connecting-IP': '1.1.1.1' },
    }), f.env, f.executionCtx);
    assert.equal(response.status, 200, route);
    const body = await response.json();
    assertPublicBytes(body, route);
    const snapshot = body.live || body;
    assert.deepEqual(snapshot.online, [publicClient.uuid]);
    assert.equal(snapshot.data[publicClient.uuid].cpu, 4);
  }
  // 公开 bootstrap 完全不受 include_hidden 影响：首页用不到隐藏节点，所以响应形状
  // 必须与调用方身份无关。`/api/public/bootstrap?include_hidden=1` 与不带该参数的
  // 响应必须字段一致（含 assertPublicBytes 已排除 HIDDEN_PRIVATE_NAME）。
  //
  // 必须用 `_fresh`（真正的强制重算参数）而不是 `fresh`：publicMetadataResponseCache
  // 的键只看路径，普通请求的第二次调用会直接命中第一次的缓存，让这条断言变成恒真。
  const plain = await (await f.app.fetch(new Request('https://monitor.example.test/api/public/bootstrap?_fresh=1'), f.env, f.executionCtx)).json();
  const asked = await (await f.app.fetch(new Request('https://monitor.example.test/api/public/bootstrap?_fresh=1&include_hidden=1'), f.env, f.executionCtx)).json();
  assert.deepEqual(Object.keys(asked).sort(), Object.keys(plain).sort());
  assert.deepEqual(asked.clients.map(client => client.uuid), plain.clients.map(client => client.uuid));
  assert.deepEqual(asked.nodes.map(node => node.uuid), plain.nodes.map(node => node.uuid));
  assert.deepEqual(asked.live.online, plain.live.online, 'include_hidden must not widen the live snapshot');
  assert.ok(!asked.clients.some(client => client.uuid === hiddenClient.uuid), 'the public bootstrap never carries hidden clients');
  // 管理员受众（includeHidden=true）收到的 update 与 snapshot 是
  // /api/public/bootstrap?include_hidden=1 的同一条数据源，此前正是它在放行明文 IP。
  // 允许出现隐藏节点名（assertPublicBytes 不适用），但不允许出现任何明文地址。
  assertNoRawAddress(f.viewers[1].messages.filter(message => message.type === 'update'), 'administrator WS update');
  f.object.sendSnapshot(f.viewers[1].ws);
  const adminSnapshotMessage = f.viewers[1].messages.at(-1);
  assert.equal(adminSnapshotMessage?.type, 'snapshot');
  assertNoRawAddress(adminSnapshotMessage, 'administrator WS snapshot');
  assert.ok(adminSnapshotMessage.data[hiddenClient.uuid], 'hidden nodes must still reach the administrator');
  assert.equal(adminSnapshotMessage.data[publicClient.uuid].has_ipv4, true, 'the administrator still learns IP presence');

  // 管理员受众同样拿不到明文地址。IP 可见性拆成两件事：
  // 「有没有」用 has_ipv4/has_ipv6 布尔表达，明文只走 /api/clients（cfm_admin_clients），
  // 那是真正按管理员鉴权的通道。这样公开响应形状与调用方身份无关。
  const adminSnapshot = f.object.buildSnapshot(true);
  assertNoRawAddress(adminSnapshot, 'administrator snapshot');
  const adminClient = adminSnapshot.data[publicClient.uuid];
  assert.equal(adminClient.has_ipv4, true, 'the administrator still learns that the node has a public IPv4');
  assert.equal(adminClient.ipv4, undefined, 'raw addresses never leave the DO report projection');
  assert.equal(adminClient.ipv6, undefined);
  assert.equal(adminClient.region, undefined, 'Agent/connection-derived region is not an administrative report field');
  // 匿名受众现在也能拿到存在性布尔，它与顶层 clients 已公开的 has_ipv4 等价，不新增暴露面。
  const anonClient = f.object.buildSnapshot(false).data[publicClient.uuid];
  assert.equal(anonClient.has_ipv4, true);
  assert.equal(anonClient.ipv4, undefined);
  await f.storage.drain();
});

/**
 * 公开 bootstrap 的响应形状必须与调用方身份无关。
 *
 * 这条用例刻意构造**真实有效**的管理员会话，而不是「带上一个坏 cookie」：
 * 坏 cookie 下 hasAdminSession 恒为 false，新旧实现都会通过，断言没有判别力。
 * 所以先用同一枚 cookie 打在 /api/live/clients 上做正向对照——它必须真的放行隐藏节点；
 * 确认放行之后，再断言同一个 include_hidden=1 打在 bootstrap 上什么也不多给。
 */
test('AUD-04: an authenticated administrator session does not change the public bootstrap response', async () => {
  const admin = { uuid: 'admin-fixture', username: 'auditor', session_version: 1 };
  const f = await fixture({ overrides: {
    getUserByUuid: async (_database, uuid) => (uuid === admin.uuid ? { ...admin } : null),
  } });
  const { generateToken } = f.loader.load('worker/src/auth/jwt.ts');
  const sessionCookie = `cf_monitor_session=${await generateToken(admin.uuid, admin.username, admin.session_version, f.env)}`;
  const fetchAs = (route, withSession) => f.app.fetch(new Request(`https://monitor.example.test${route}`, {
    headers: { 'CF-Connecting-IP': '1.1.1.1', ...(withSession ? { Cookie: sessionCookie } : {}) },
  }), f.env, f.executionCtx);

  for (const client of [publicClient, hiddenClient]) {
    const socket = createSocket({ role: 'agent', clientId: client.uuid, clientName: client.name, hidden: client.hidden, sourceIp });
    f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
    await f.object.webSocketMessage(socket.ws, JSON.stringify({ type: 'report', data: { cpu: 4, timestamp: Date.now(), ipv4: privateV4, ipv6: privateV6 } }));
  }
  await f.storage.drain();

  // 正向对照：会话必须真的有效，否则下面的等价性断言是同义反复。
  const anonymousLive = await (await fetchAs('/api/live/clients?include_hidden=1', false)).json();
  const administratorLive = await (await fetchAs('/api/live/clients?include_hidden=1', true)).json();
  assert.ok(!anonymousLive.online.includes(hiddenClient.uuid), 'include_hidden alone must not widen an anonymous live snapshot');
  assert.ok(administratorLive.online.includes(hiddenClient.uuid), 'the fixture session must actually be accepted, otherwise this test cannot tell the fix from the bug');
  assertNoRawAddress([anonymousLive, administratorLive], 'live clients');

  // 同一枚有效会话、同一个 include_hidden=1，bootstrap 必须与匿名逐字段一致。
  // 用 _fresh 强制重算，绕开 publicMetadataResponseCache —— 它的键只看路径（bootstrap 的
  // 允许参数集为空），命中缓存会让这条断言在任何实现下都通过，从而失去判别力。
  const anonymous = await (await fetchAs('/api/public/bootstrap?_fresh=1&include_hidden=1', false)).json();
  const administrator = await (await fetchAs('/api/public/bootstrap?_fresh=1&include_hidden=1', true)).json();
  assertPublicBytes(anonymous, 'anonymous bootstrap');
  assertPublicBytes(administrator, 'administrator bootstrap');
  const shapeOf = body => ({
    keys: Object.keys(body).sort(),
    clients: (body.clients || []).map(client => client.uuid),
    nodes: (body.nodes || []).map(node => node.uuid),
    online: body.live?.online || [],
    // 逐节点字段集合也必须一致：泄露往往只表现为「多了几个字段」。
    liveFields: Object.keys(body.live?.data?.[publicClient.uuid] || {}).sort(),
  });
  assert.deepEqual(shapeOf(administrator), shapeOf(anonymous), 'the public bootstrap must not vary with the caller identity');
  assert.ok(!shapeOf(administrator).clients.includes(hiddenClient.uuid), 'the public bootstrap never carries hidden clients');
  assert.ok(!shapeOf(administrator).online.includes(hiddenClient.uuid), 'the public bootstrap never carries a hidden live node');
  // 存在性信息保留，明文地址仍然没有。
  assert.equal(administrator.live.data[publicClient.uuid].has_ipv4, true);
  assert.equal(administrator.live.data[publicClient.uuid].ipv4, undefined);
  assert.equal(administrator.live.data[publicClient.uuid].ipv6, undefined);
  await f.storage.drain();
});

test('AUD-03: metadata updates isolate public and administrative audiences', async () => {
  const f = await fixture();
  const { syncLiveClientMeta, hideAdminClientToken } = f.loader.load('worker/src/routes/admin.ts');
  for (const client of [publicClient, hiddenClient, { ...publicClient, hidden: true }]) {
    await syncLiveClientMeta({ env: f.env }, hideAdminClientToken({
      ...client, token: 'SYNTHETIC_SECRET', token_hash: 'SYNTHETIC_SECRET',
      token_last_used_ip: privateV4, arbitrary_extension: 'SYNTHETIC_SECRET',
    }));
    await f.storage.drain();
  }
  const publicEvents = f.viewers[0].messages.filter(message => message.type === 'metadata_changed');
  assertPublicBytes(publicEvents, 'anonymous metadata');
  assert.ok(!JSON.stringify(publicEvents).includes('HIDDEN_PRIVATE_NOTE'));
  const publicUpserts = publicEvents.flatMap(message => message.clients?.upsert || []);
  assert.ok(publicUpserts.some(client => client.uuid === publicClient.uuid && client.public_remark === 'public note'));
  assert.ok(!publicUpserts.some(client => client.hidden || client.uuid === hiddenClient.uuid));
  assert.ok(publicEvents.some(message => message.clients?.remove?.includes(publicClient.uuid)), 'public-to-hidden transition removes visible client');
  const adminUpserts = f.viewers[1].messages.flatMap(message => message.clients?.upsert || []);
  assert.ok(adminUpserts.some(client => client.uuid === hiddenClient.uuid && client.remark === 'HIDDEN_PRIVATE_NOTE'));
  assert.ok(!JSON.stringify(adminUpserts).includes('SYNTHETIC_SECRET'), 'agent credentials are never sent to viewers');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const action of ['hide', 'remove', 'rename']) {
  test(`AUD-03: a stale handshake cannot undo administrator ${action}`, async () => {
    const f = await fixture();
    const updated = { ...publicClient, name: 'CURRENT_ADMIN_NAME', hidden: action === 'hide' };
    await f.object.fetch(new Request(`https://do/client-${action === 'remove' ? 'remove' : 'meta'}`, {
      method: 'POST', body: JSON.stringify(action === 'remove'
        ? { uuid: publicClient.uuid }
        : { uuid: publicClient.uuid, name: updated.name, hidden: updated.hidden, client: updated }),
    }));
    const before = f.viewers[0].messages.length;
    const agent = createSocket({ role: 'agent', clientId: publicClient.uuid, clientName: publicClient.name, hidden: false });
    f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());
    await f.object.webSocketMessage(agent.ws, JSON.stringify({ type: 'report', data: { cpu: 6 } }));
    await f.storage.drain();
    const snapshot = f.object.buildSnapshot(false);
    const events = f.viewers[0].messages.slice(before).filter(message => message.type === 'update');
    if (action === 'rename') {
      assert.deepEqual(snapshot.online, [publicClient.uuid]);
      assert.equal(events.at(-1)?.name, 'CURRENT_ADMIN_NAME');
    } else {
      assert.deepEqual(snapshot.online, []);
      assert.equal(events.length, 0);
    }
    if (action === 'remove') assert.deepEqual(f.object.buildSnapshot(true).online, []);
  });
}

for (const kind of ['basic', 'network']) {
  for (const action of ['hide', 'remove', 'rename']) {
    test(`AUD-03: in-flight ${kind} metadata cannot undo an administrator ${action}`, async () => {
      const started = deferred();
      const release = deferred();
      const f = await fixture({ overrides: { updateClient: async () => {
        started.resolve();
        await release.promise;
      } } });
      const pending = kind === 'basic'
        ? f.object.syncBasicInfoFromReport(publicClient.uuid, publicClient.name, false, { basic_info: { os: 'Fresh OS after await' } })
        : f.object.syncNetworkMetadataFromReport(publicClient.uuid, publicClient.name, false, { region: 'Fixture City, US' }, Date.now());
      try {
        await started.promise;
        const updated = { ...publicClient, name: 'ADMIN_RENAMED', hidden: action === 'hide', updated_at: '2026-09-06T14:00:00.000Z' };
        const response = await f.object.fetch(new Request(`https://do/${action === 'remove' ? 'client-remove' : 'client-meta'}`, {
          method: 'POST', body: JSON.stringify(action === 'remove'
            ? { uuid: publicClient.uuid }
            : { uuid: publicClient.uuid, name: updated.name, hidden: updated.hidden, client: updated }),
        }));
        assert.equal(response.status, 200);
        const beforePublic = f.viewers[0].messages.length;
        const beforeAdmin = f.viewers[1].messages.length;
        release.resolve();
        await pending;
        await f.storage.drain();
        const snapshot = await (await f.object.fetch(new Request('https://do/admin-clients-snapshot'))).json();
        const stored = snapshot.clients.find(client => client.uuid === publicClient.uuid);
        const publicUpserts = f.viewers[0].messages.slice(beforePublic).flatMap(message => message.clients?.upsert || []);
        if (action === 'remove') {
          assert.equal(stored, undefined, 'an old Agent completion must not resurrect removed metadata');
          assert.ok(snapshot.removed.includes(publicClient.uuid), 'the deletion marker must survive');
          assert.ok(!f.viewers[1].messages.slice(beforeAdmin).flatMap(message => message.clients?.upsert || []).some(client => client.uuid === publicClient.uuid));
        } else {
          assert.equal(stored.hidden, updated.hidden, 'the current administrator visibility wins');
          assert.equal(stored.name, 'ADMIN_RENAMED', 'Agent metadata cannot restore an old administrator name');
          assert.equal(stored.updated_at, updated.updated_at);
        }
        if (action !== 'rename') {
          assert.ok(!publicUpserts.some(client => client.uuid === publicClient.uuid), 'a hidden/deleted node must not reappear in anonymous updates');
        } else {
          assert.ok(publicUpserts.every(client => client.uuid !== publicClient.uuid || client.name === 'ADMIN_RENAMED'));
        }
      } finally {
        release.resolve();
        await pending;
        await f.storage.drain();
      }
    });
  }
}
