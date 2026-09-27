import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

// 「第一位观众到来」是匿名可达的：观众连接由公开的 /api/ws/live-token 签发，
// 任何人连上再断开就能把观众数打回 0，从而反复制造 0 -> 1 跃迁。
// 每次跃迁原先都会让**全网节点立刻上报一轮**（report_now: true），于是
// 一个公开的 viewer 连接就能持续消耗所有节点的上报配额与 DO 的 CPU。
// 这里把「催报」限制成时间窗内只认第一次；跃迁本身仍然广播（mode 照常切 active）。
const T0 = 1_700_000_000_000;
const AGENT_REPORT_NOW_MIN_INTERVAL_MS = 30_000;

async function fixture() {
  const db = {
    getAllSettings: async () => ({ record_enabled: 'false' }),
    getSettingsByKeys: async () => ({ record_enabled: 'false' }),
    getSetting: async () => null,
    listPingTasks: async () => [],
    listWebsiteMonitors: async () => [],
    listAgentWebsiteProbeTasks: async () => [],
    insertAuditLog: async () => {},
  };
  const loader = createWorkerLoader({ db });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const state = createDurableState();
  const object = new LiveDataDO(state.state, {});

  // 一个在线的节点会话，用来观察下发到节点的 policy 消息。
  const agent = createSocket({ role: 'agent', clientId: 'node-a', clientName: 'Node A', hidden: false });
  object.registerSession(agent.ws, agent.ws.deserializeAttachment());
  // 一位在线的观众，让 mode 判定为 active（否则 report_now 恒为 false，断言会失去意义）。
  const viewer = createSocket({
    role: 'viewer',
    clientId: 'viewer-1',
    clientName: 'Viewer',
    hidden: false,
    viewerExpiresAt: T0 + 60 * 60_000,
  });
  object.registerSession(viewer.ws, viewer.ws.deserializeAttachment());

  const lastPolicy = () => agent.messages.filter(message => message.type === 'policy').at(-1);
  return { object, lastPolicy };
}

test('AUD-10 cycling anonymous viewers cannot repeatedly fan out an immediate report to every Agent', async () => {
  const f = await fixture();

  // 前置条件：真正的第一位观众到来，催报仍然生效。
  await f.object.broadcastAgentPolicy(T0, true);
  assert.equal(f.lastPolicy().mode, 'active', 'precondition: an online viewer keeps the Agent in active mode');
  assert.equal(f.lastPolicy().report_now, true, 'precondition: the first wake-up still asks the fleet to report immediately');

  // 观众断线（1 -> 0）之后重新连上（0 -> 1）：调用方看到的又是「第一位观众」。
  await f.object.broadcastAgentPolicy(T0 + 1_000, true);
  assert.equal(f.lastPolicy().report_now, false,
    'a re-created 0 -> 1 viewer transition inside the window must not re-wake the whole fleet');
  await f.object.broadcastAgentPolicy(T0 + 5_000, true);
  assert.equal(f.lastPolicy().report_now, false, 'the amplification must stay bounded no matter how often the viewer cycles');
  // 窗口内的跃迁仍然要如实广播 mode，否则节点会一直按空闲频率上报。
  assert.equal(f.lastPolicy().mode, 'active');

  await f.object.broadcastAgentPolicy(T0 + AGENT_REPORT_NOW_MIN_INTERVAL_MS + 1_000, true);
  assert.equal(f.lastPolicy().report_now, true, 'once the window has elapsed the wake-up is allowed again');
});
