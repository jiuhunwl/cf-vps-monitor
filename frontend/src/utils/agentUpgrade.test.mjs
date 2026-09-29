import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_UPGRADE_BATCH_SIZE,
  UNKNOWN_UPGRADE_FAILURE,
  UPGRADE_FAILURE_CODES,
  canRetryUpgradePhase,
  compareAgentVersions,
  countUpgradableTargets,
  createAgentUpgrade,
  describeSkipReason,
  describeUpgradeFailure,
  failureExplanation,
  fetchUpgradeRelease,
  fetchUpgradeStatus,
  hasPendingCommands,
  isAgentDowngrade,
  isAgentUpToDate,
  isPendingStatus,
  isTerminalStatus,
  mergeUpgradeCommands,
  normalizeAgentVersion,
  partitionUpgradeTargets,
  phaseFromCommandStatus,
  planBatches,
  pollUpgradeStatus,
  runUpgradeWaves,
  transitionUpgradePhase,
  upgradeStatusDisplay,
} from './agentUpgrade.ts';

/* ------------------------------------------------------------------ */
/* 版本规范化与比较                                                    */
/* ------------------------------------------------------------------ */

test('normalizeAgentVersion 统一补 `v` 前缀，保证跨形态可比', () => {
  assert.equal(normalizeAgentVersion('1.0.2'), 'v1.0.2');
  assert.equal(normalizeAgentVersion('v1.0.2'), 'v1.0.2');
  assert.equal(normalizeAgentVersion('  v1.4.2  '), 'v1.4.2');
  assert.equal(normalizeAgentVersion(''), '');
  assert.equal(normalizeAgentVersion(undefined), '');
  assert.equal(normalizeAgentVersion('revision-abc'), 'revision-abc');
});

test('isAgentUpToDate 依赖两侧规范化，v1.0.2 与 1.0.2 判为相同', () => {
  assert.equal(isAgentUpToDate('1.0.2', 'v1.0.2'), true);
  assert.equal(isAgentUpToDate('v1.0.2', 'v1.0.3'), false);
  assert.equal(isAgentUpToDate('', 'v1.0.2'), false);
  assert.equal(isAgentUpToDate('v1.0.2', null), false);
});

test('compareAgentVersions 按数值段比较，而非字典序', () => {
  assert.equal(compareAgentVersions('v1.4.2', 'v1.4.10') < 0, true);
  assert.equal(compareAgentVersions('v1.4.10', 'v1.4.2') > 0, true);
  assert.equal(compareAgentVersions('1.4.2', 'v1.4.2'), 0);
  assert.equal(compareAgentVersions('v1.5.0', 'v1.4.9') > 0, true);
});

test('isAgentDowngrade 仅在目标低于当前且不相等时为真', () => {
  assert.equal(isAgentDowngrade('v1.4.3', 'v1.4.2'), true);
  assert.equal(isAgentDowngrade('v1.4.2', 'v1.4.3'), false);
  assert.equal(isAgentDowngrade('v1.4.2', 'v1.4.2'), false);
  assert.equal(isAgentDowngrade('', 'v1.4.2'), false);
});

/* ------------------------------------------------------------------ */
/* 预分组                                                             */
/* ------------------------------------------------------------------ */

test('partitionUpgradeTargets 区分将升级 / 已最新跳过 / 降级', () => {
  const nodes = [
    { uuid: 'a', name: 'A', version: '1.0.2' },   // 已最新 → 跳过
    { uuid: 'b', name: 'B', version: '1.0.1' },   // 将升级
    { uuid: 'c', name: 'C', version: '' },        // 版本未知 → 将升级
    { uuid: 'd', name: 'D', version: '1.0.9' },   // 目标更低 → 降级
  ];
  const partition = partitionUpgradeTargets(nodes, 'v1.0.2');
  assert.deepEqual(partition.toUpgrade.map((n) => n.uuid), ['b', 'c', 'd']);
  assert.deepEqual(partition.skipped.map((n) => n.uuid), ['a']);
  assert.deepEqual(partition.downgrades.map((n) => n.uuid), ['d']);
  assert.equal(countUpgradableTargets(nodes, 'v1.0.2'), 3);
});

test('partitionUpgradeTargets 在目标版本未知时不跳过任何节点', () => {
  const nodes = [{ uuid: 'a', version: 'v1.0.2' }, { uuid: 'b', version: '' }];
  const partition = partitionUpgradeTargets(nodes, null);
  assert.equal(partition.skipped.length, 0);
  assert.equal(partition.toUpgrade.length, 2);
});

/* ------------------------------------------------------------------ */
/* 分波边界（默认每批 5）                                              */
/* ------------------------------------------------------------------ */

test('planBatches 覆盖 0 / 1 / 5 / 6 / 13 个节点的边界', () => {
  assert.equal(DEFAULT_UPGRADE_BATCH_SIZE, 5);
  assert.deepEqual(planBatches([]), []);
  assert.deepEqual(planBatches(['a']), [['a']]);
  assert.deepEqual(planBatches(['a', 'b', 'c', 'd', 'e']), [['a', 'b', 'c', 'd', 'e']]);
  assert.deepEqual(planBatches(['1', '2', '3', '4', '5', '6']), [['1', '2', '3', '4', '5'], ['6']]);
  const thirteen = Array.from({ length: 13 }, (_, i) => `n${i}`);
  assert.deepEqual(planBatches(thirteen).map((batch) => batch.length), [5, 5, 3]);
});

test('planBatches 支持自定义批量并兜底非法值', () => {
  assert.deepEqual(planBatches(['a', 'b', 'c'], { batchSize: 2 }).map((b) => b.length), [2, 1]);
  assert.deepEqual(planBatches(['a', 'b', 'c'], { batchSize: 0 }).map((b) => b.length), [1, 1, 1]);
  assert.deepEqual(planBatches(['a', 'b'], { batchSize: -3 }).map((b) => b.length), [1, 1]);
});

/* ------------------------------------------------------------------ */
/* 状态机                                                             */
/* ------------------------------------------------------------------ */

test('状态机按设计迁移，非法迁移返回 null', () => {
  assert.equal(transitionUpgradePhase('idle', 'confirm'), 'confirming');
  assert.equal(transitionUpgradePhase('confirming', 'cancel'), 'idle');
  assert.equal(transitionUpgradePhase('confirming', 'dispatch'), 'dispatching');
  assert.equal(transitionUpgradePhase('dispatching', 'queued'), 'queued');
  assert.equal(transitionUpgradePhase('queued', 'start'), 'running');
  assert.equal(transitionUpgradePhase('running', 'success'), 'success');
  // failed / rolled_back 可重试回到 dispatching
  assert.equal(transitionUpgradePhase('failed', 'retry'), 'dispatching');
  assert.equal(transitionUpgradePhase('rolled_back', 'retry'), 'dispatching');
  // 终态不可重试
  assert.equal(transitionUpgradePhase('success', 'retry'), null);
  assert.equal(transitionUpgradePhase('unverified', 'retry'), null);
  assert.equal(canRetryUpgradePhase('failed'), true);
  assert.equal(canRetryUpgradePhase('rolled_back'), true);
  assert.equal(canRetryUpgradePhase('unverified'), false);
});

test('phaseFromCommandStatus 把 dispatched 归入等待阶段', () => {
  assert.equal(phaseFromCommandStatus('queued'), 'queued');
  assert.equal(phaseFromCommandStatus('dispatched'), 'queued');
  assert.equal(phaseFromCommandStatus('running'), 'running');
  assert.equal(phaseFromCommandStatus('rolled_back'), 'rolled_back');
});

test('未决状态判定覆盖 queued/dispatched/running', () => {
  assert.equal(isPendingStatus('queued'), true);
  assert.equal(isPendingStatus('dispatched'), true);
  assert.equal(isPendingStatus('running'), true);
  assert.equal(isPendingStatus('success'), false);
  assert.equal(isTerminalStatus('unverified'), true);
  assert.equal(hasPendingCommands([{ status: 'success' }, { status: 'running' }]), true);
  assert.equal(hasPendingCommands([{ status: 'success' }, { status: 'failed' }]), false);
});

/* ------------------------------------------------------------------ */
/* 状态 → 展示映射（unverified / rolled_back 必须各自独立）           */
/* ------------------------------------------------------------------ */

test('unverified、rolled_back、failed 三者文案与颜色互不相同', () => {
  const success = upgradeStatusDisplay('success');
  const unverified = upgradeStatusDisplay('unverified');
  const rolledBack = upgradeStatusDisplay('rolled_back');
  const failed = upgradeStatusDisplay('failed');

  assert.notEqual(unverified.label, rolledBack.label);
  assert.notEqual(unverified.label, failed.label);
  assert.notEqual(rolledBack.label, failed.label);
  // unverified 的可信度依赖后端交叉校验，必须显著区别于 success
  assert.notEqual(unverified.label, success.label);
  assert.notEqual(unverified.color, success.color);
  assert.notEqual(rolledBack.label, success.label);

  // rolled_back 与 failed 虽然都可重试，但语义色不同
  assert.equal(failed.retryable, true);
  assert.equal(rolledBack.retryable, true);
  assert.notEqual(failed.color, rolledBack.color);

  // 已最新是正常终态，不应报错色
  assert.notEqual(upgradeStatusDisplay('already_latest').color, 'red');
  assert.equal(upgradeStatusDisplay('already_latest').pending, false);
});

test('未知状态兜底到 idle 展示，不抛异常', () => {
  const display = upgradeStatusDisplay('does_not_exist');
  assert.equal(display.phase, 'idle');
  assert.ok(display.label.length > 0);
});

/* ------------------------------------------------------------------ */
/* 失败文案                                                           */
/* ------------------------------------------------------------------ */

test('失败文案模板命中 checksum_mismatch 并附带当前运行版本', () => {
  const text = describeUpgradeFailure({ failure_code: 'checksum_mismatch', from_version: '1.4.2' });
  assert.match(text, /升级失败：校验和不匹配/);
  assert.match(text, /节点仍以 v1\.4\.2 正常运行/);
});

test('failure_code 全枚举都有人话解释，未知码有兜底且绝不留空 / 不甩原始码', () => {
  for (const code of UPGRADE_FAILURE_CODES) {
    const explanation = failureExplanation(code);
    assert.ok(explanation.length > 0, `${code} 的解释不应为空`);
    assert.notEqual(explanation, code, `${code} 不应直接回显原始码`);
  }
  // 未知码 + 无原因 → 兜底文案
  const unknown = describeUpgradeFailure({ failure_code: 'totally_unknown_code', from_version: 'v1.0.0' });
  assert.match(unknown, new RegExp(UNKNOWN_UPGRADE_FAILURE.slice(0, 6)));
  assert.doesNotMatch(unknown, /totally_unknown_code/);
  // 未知码 + 有可读原因 → 采用原因
  assert.equal(failureExplanation('unknown_code', '磁盘空间不足'), '磁盘空间不足');
  // 未知码 + 原因为原始码本身 → 仍兜底
  assert.equal(failureExplanation('unknown_code', 'unknown_code'), UNKNOWN_UPGRADE_FAILURE);
});

test('unsupported_platform 给出「先手动跑脚本」的引导而非仅「不支持」', () => {
  const text = describeUpgradeFailure({ failure_code: 'unsupported_platform', from_version: 'v0.9.0' });
  assert.match(text, /手动执行一次安装脚本升级/);
  assert.match(text, /面板驱动/);
  assert.doesNotMatch(text, /unsupported_platform/);
});

test('回滚/重启类失败提示确认节点状态，而非断言仍在运行', () => {
  const text = describeUpgradeFailure({ failure_code: 'rollback_failed', from_version: 'v1.4.2' });
  assert.match(text, /请确认节点是否仍以 v1\.4\.2 正常运行/);
});

test('describeSkipReason 覆盖全部跳过原因', () => {
  for (const reason of ['already_latest', 'already_pending', 'not_found', 'invalid_target']) {
    assert.ok(describeSkipReason(reason).length > 0);
  }
});

/* ------------------------------------------------------------------ */
/* 状态合并                                                           */
/* ------------------------------------------------------------------ */

test('mergeUpgradeCommands 按 client_uuid 覆盖更新且不破坏原对象', () => {
  const current = { a: { client_uuid: 'a', status: 'queued' } };
  const next = mergeUpgradeCommands(current, [
    { client_uuid: 'a', status: 'running' },
    { client_uuid: 'b', status: 'queued' },
  ]);
  assert.equal(next.a.status, 'running');
  assert.equal(next.b.status, 'queued');
  assert.equal(current.a.status, 'queued'); // 原对象未被就地修改
  assert.equal(mergeUpgradeCommands(next, []), next);
});

/* ------------------------------------------------------------------ */
/* 轮询器                                                             */
/* ------------------------------------------------------------------ */

test('轮询仅在存在未决命令时进行：全终态只请求一次', async () => {
  let calls = 0;
  const commands = await pollUpgradeStatus({
    ids: ['c1'],
    fetchStatus: async () => { calls += 1; return [{ id: 'c1', client_uuid: 'a', status: 'success' }]; },
    sleep: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(commands[0].status, 'success');
});

test('轮询持续到终态，期间按 interval 休眠', async () => {
  let calls = 0;
  const sleeps = [];
  const commands = await pollUpgradeStatus({
    ids: ['c1'],
    fetchStatus: async () => {
      calls += 1;
      return [{ id: 'c1', client_uuid: 'a', status: calls >= 3 ? 'failed' : 'running' }];
    },
    sleep: async (ms) => { sleeps.push(ms); },
    intervalMs: 1234,
  });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1234, 1234]);
  assert.equal(commands[0].status, 'failed');
});

test('轮询可取消：取消后不再发起请求也不泄漏定时器', async () => {
  let calls = 0;
  let cancelled = false;
  const commands = await pollUpgradeStatus({
    ids: ['c1'],
    fetchStatus: async () => {
      calls += 1;
      if (calls >= 2) cancelled = true; // 第二轮返回后触发取消
      return [{ id: 'c1', client_uuid: 'a', status: 'running' }];
    },
    sleep: async () => {},
    isCancelled: () => cancelled,
  });
  // 第一轮 + 第二轮共 2 次；第三轮开始前检测到取消即停止
  assert.equal(calls, 2);
  assert.equal(commands[0].status, 'running');
});

test('轮询在 ids 为空时可立即返回且不请求', async () => {
  let calls = 0;
  const commands = await pollUpgradeStatus({
    ids: [],
    fetchStatus: async () => { calls += 1; return []; },
    sleep: async () => {},
  });
  assert.deepEqual(commands, []);
  assert.equal(calls, 0);
});

/* ------------------------------------------------------------------ */
/* 分波驱动：失败不阻塞后续波次                                        */
/* ------------------------------------------------------------------ */

test('单个节点失败不阻塞后续波次', async () => {
  const dispatched = [];
  const seen = [];
  await runUpgradeWaves({
    batches: [['a', 'b'], ['c']],
    dispatch: async (uuids) => {
      dispatched.push(uuids);
      return uuids.map((uuid) => ({ id: `cmd-${uuid}`, client_uuid: uuid, status: uuid === 'a' ? 'failed' : 'success' }));
    },
    fetchStatus: async (ids) => ids.map((id) => {
      const uuid = id.replace('cmd-', '');
      return { id, client_uuid: uuid, status: uuid === 'a' ? 'failed' : 'success' };
    }),
    sleep: async () => {},
    onCommands: (commands) => { for (const c of commands) seen.push(`${c.client_uuid}:${c.status}`); },
  });
  assert.deepEqual(dispatched, [['a', 'b'], ['c']]);
  assert.ok(seen.includes('a:failed'));
  assert.ok(seen.includes('c:success'));
});

test('整批下发抛错也不阻塞后续波次，并通过 onError 上报', async () => {
  const dispatched = [];
  const errors = [];
  await runUpgradeWaves({
    batches: [['a'], ['b']],
    dispatch: async (uuids) => {
      dispatched.push(uuids);
      if (uuids[0] === 'a') throw new Error('网络错误');
      return uuids.map((uuid) => ({ id: `cmd-${uuid}`, client_uuid: uuid, status: 'success' }));
    },
    fetchStatus: async (ids) => ids.map((id) => ({ id, client_uuid: id.replace('cmd-', ''), status: 'success' })),
    sleep: async () => {},
    onError: (error, context) => errors.push({ message: error.message, batchIndex: context.batchIndex }),
  });
  assert.deepEqual(dispatched, [['a'], ['b']]);
  assert.deepEqual(errors, [{ message: '网络错误', batchIndex: 0 }]);
});

test('波次驱动在取消后停止推进', async () => {
  const dispatched = [];
  await runUpgradeWaves({
    batches: [['a'], ['b'], ['c']],
    dispatch: async (uuids) => { dispatched.push(uuids); return uuids.map((uuid) => ({ id: `cmd-${uuid}`, client_uuid: uuid, status: 'success' })); },
    fetchStatus: async (ids) => ids.map((id) => ({ id, client_uuid: id.replace('cmd-', ''), status: 'success' })),
    sleep: async () => {},
    isCancelled: () => dispatched.length >= 2,
  });
  assert.deepEqual(dispatched, [['a'], ['b']]);
});

/* ------------------------------------------------------------------ */
/* API 封装（注入 mock apiFetch）                                      */
/* ------------------------------------------------------------------ */

test('createAgentUpgrade 组装 body 并解析扁平信封', async () => {
  const calls = [];
  const fakeFetch = async (path, options) => {
    calls.push({ path, options });
    return {
      success: true,
      target_version: 'v1.0.2',
      created: 2,
      skipped: [{ client_uuid: 'z', reason: 'already_latest' }],
      commands: [{ id: 'c1', client_uuid: 'a' }, { id: 'c2', client_uuid: 'b' }],
    };
  };
  const res = await createAgentUpgrade(fakeFetch, ['a', 'b'], 'v1.0.2');
  assert.equal(calls[0].path, '/admin/agents/upgrade');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { uuids: ['a', 'b'], target_version: 'v1.0.2' });
  assert.equal(res.created, 2);
  assert.equal(res.commands.length, 2);
  assert.equal(res.skipped[0].reason, 'already_latest');
});

test('createAgentUpgrade 对 latest / 缺省目标不发送 target_version', async () => {
  const bodies = [];
  const fakeFetch = async (_path, options) => {
    bodies.push(JSON.parse(options.body));
    return { success: true, commands: [] };
  };
  await createAgentUpgrade(fakeFetch, ['a'], 'latest');
  await createAgentUpgrade(fakeFetch, ['a']);
  assert.deepEqual(bodies[0], { uuids: ['a'] });
  assert.deepEqual(bodies[1], { uuids: ['a'] });
});

test('createAgentUpgrade 在 success:false 时抛出后端 error 文本', async () => {
  await assert.rejects(
    () => createAgentUpgrade(async () => ({ success: false, error: '目标版本无效' }), ['a'], 'v0'),
    /目标版本无效/,
  );
});

test('fetchUpgradeStatus 去重后拼 ids 查询串并返回命令', async () => {
  let captured = '';
  const fakeFetch = async (path) => {
    captured = path;
    return { success: true, commands: [{ id: 'c1', client_uuid: 'a', status: 'running' }] };
  };
  const commands = await fetchUpgradeStatus(fakeFetch, ['c1', 'c1', '']);
  assert.equal(captured, `/admin/agents/upgrade/status?ids=${encodeURIComponent('c1')}`);
  assert.equal(commands.length, 1);
});

test('fetchUpgradeStatus 空 ids 时短路、不请求', async () => {
  let calls = 0;
  const commands = await fetchUpgradeStatus(async () => { calls += 1; return { success: true, commands: [] }; }, []);
  assert.deepEqual(commands, []);
  assert.equal(calls, 0);
});

test('fetchUpgradeRelease 解析最新版本并可空', async () => {
  const withVersion = await fetchUpgradeRelease(async () => ({ success: true, latest_version: 'v1.0.2', published_at: '2025-01-01T00:00:00Z' }));
  assert.equal(withVersion.latest_version, 'v1.0.2');
  const empty = await fetchUpgradeRelease(async () => ({ success: true, latest_version: null, published_at: null }));
  assert.equal(empty.latest_version, null);
  // 后端若回显缓存标记则透传
  const cached = await fetchUpgradeRelease(async () => ({ success: true, latest_version: 'v1.0.2', cached: true }));
  assert.equal(cached.cached, true);
});
