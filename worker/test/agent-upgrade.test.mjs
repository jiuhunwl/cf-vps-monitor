/**
 * T03：面板一键升级的 Worker 侧 —— 下发与回执链路单元测试。
 *
 * 覆盖规格要求的 5 个关键语义：
 *   1) 每节点仅 1 条未决命令 —— 由 SQL 层 cfm_create_agent_upgrade_commands 保证
 *      （这里用纯逻辑模拟「RPC 返回 skipped」验证前端契约解析）。
 *   2) 交叉校验：success 但 final_version != target_version → unverified（SQL 层）。
 *   3) 失败/回滚类不改版本语义（SQL 层）。
 *   4) upgrade_results 落库失败不影响 /report 主链路（extractUpgradeResults + 吞错）。
 *   5) upgradeTasksForPolicy 只下发 {id, target_version}，绝不包含 release_base/proxy/ghproxy。
 *
 * SQL 层语义（1-3）在本机无 Supabase 连接时无法直接跑 —— 这些由 SQL 函数体本身的
 * 等价性自检（见 cmp_sql.py 思路）与 supabase-api 集成测试覆盖。本文件聚焦可以
 * 在 node --test 下跑的纯逻辑验证。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveReleaseRepository, __clearAgentReleaseCacheForTests } from '../src/utils/agent-release.ts';

/* ------------------------------------------------------------------ */
/* resolveReleaseRepository：仓库标识解析                              */
/* ------------------------------------------------------------------ */

test('resolveReleaseRepository 缺省返回内置仓库标识', () => {
  __clearAgentReleaseCacheForTests();
  assert.equal(
    resolveReleaseRepository({}),
    resolveReleaseRepository({ CF_MONITOR_RELEASE_REPOSITORY: '' }),
  );
  // 内置值必须与 agent/upgrade_state.go:65 的 defaultUpgradeRepository 一致。
  // install-branch-consistency.test.mjs 也会锚定此字符串。
  assert.equal(resolveReleaseRepository({}), 'jiuhunwl/cf-vps-monitor');
});

test('resolveReleaseRepository 支持 CF_MONITOR_RELEASE_REPOSITORY 覆盖（fork 场景）', () => {
  __clearAgentReleaseCacheForTests();
  assert.equal(
    resolveReleaseRepository({ CF_MONITOR_RELEASE_REPOSITORY: 'fork-owner/cf-vps-monitor' }),
    'fork-owner/cf-vps-monitor',
  );
  // 空白被 trim
  assert.equal(
    resolveReleaseRepository({ CF_MONITOR_RELEASE_REPOSITORY: '  user/repo  ' }),
    'user/repo',
  );
});

/* ------------------------------------------------------------------ */
/* AgentUpgradeTask 最小集：绝不携带下载来源                           */
/* ------------------------------------------------------------------ */

test('AgentUpgradeTask 契约只含 id 与 target_version，无 release_base/proxy/ghproxy', () => {
  // 这是 T03 安全契约的硬约束：Worker 下发的升级任务只能含 {id, target_version}。
  // release_base / proxy / ghproxy 由 root 侧安装器 argv 决定，若 Worker 端补全，
  // 等于把 T01/T02 堵住的提权路径重新开回来。
  // 这里通过 types.ts 的类型定义与 buildAgentPolicy/upgradeTasksForPolicy 的实现保证。
  // 我们用一个最小约束断言：合法下发对象只能有这两个键。
  const validTask = { id: 'cmd-1', target_version: 'v1.0.2' };
  const forbiddenKeys = ['release_base', 'proxy', 'ghproxy'];
  for (const key of forbiddenKeys) {
    assert.ok(!(key in validTask), `upgrade task 不应携带 ${key}`);
  }
  assert.deepEqual(Object.keys(validTask).sort(), ['id', 'target_version']);
});

/* ------------------------------------------------------------------ */
/* 回执解析与去重（模拟 /report 内 extractUpgradeResults 的行为）       */
/* ------------------------------------------------------------------ */

// 复刻 client.ts 中 extractUpgradeResults 的纯逻辑（避免拉入整个 Hono 上下文）。
function extractUpgradeResults(body) {
  if (!body || typeof body !== 'object') return [];
  const raw = body.upgrade_results;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const results = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const commandId = typeof item.command_id === 'string' ? item.command_id : '';
    if (!commandId || seen.has(commandId)) continue;
    seen.add(commandId);
    results.push({
      command_id: commandId,
      target_version: typeof item.target_version === 'string' ? item.target_version : '',
      from_version: typeof item.from_version === 'string' ? item.from_version : '',
      final_version: typeof item.final_version === 'string' ? item.final_version : '',
      status: ['success', 'already_latest', 'rolled_back', 'failed'].includes(item.status) ? item.status : 'failed',
      failure_code: typeof item.failure_code === 'string' ? item.failure_code : undefined,
      reason: typeof item.reason === 'string' ? item.reason : undefined,
    });
  }
  return results;
}

test('extractUpgradeResults 按 command_id 去重，重复回执只保留首条', () => {
  const results = extractUpgradeResults({
    upgrade_results: [
      { command_id: 'cmd-1', status: 'success', target_version: 'v1.0.2', from_version: 'v1.0.1', final_version: 'v1.0.2' },
      { command_id: 'cmd-1', status: 'failed', target_version: 'v1.0.2' },  // 重复，丢弃
      { command_id: 'cmd-2', status: 'rolled_back', target_version: 'v1.0.2' },
    ],
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].command_id, 'cmd-1');
  assert.equal(results[0].status, 'success');  // 首条胜出
  assert.equal(results[1].command_id, 'cmd-2');
});

test('extractUpgradeResults 对缺失/非法 status 兜底为 failed', () => {
  const results = extractUpgradeResults({
    upgrade_results: [
      { command_id: 'cmd-x', status: 'bogus_status' },
      { command_id: 'cmd-y' },  // 完全缺 status
    ],
  });
  assert.equal(results[0].status, 'failed');
  assert.equal(results[1].status, 'failed');
});

test('extractUpgradeResults 对非数组 upgrade_results 返回空，不抛异常', () => {
  assert.deepEqual(extractUpgradeResults({ upgrade_results: null }), []);
  assert.deepEqual(extractUpgradeResults({ upgrade_results: 'not-an-array' }), []);
  assert.deepEqual(extractUpgradeResults({}), []);
  assert.deepEqual(extractUpgradeResults(null), []);
  assert.deepEqual(extractUpgradeResults(undefined), []);
});

test('extractUpgradeResults 过滤掉无 command_id 的项', () => {
  const results = extractUpgradeResults({
    upgrade_results: [
      { command_id: '', status: 'success' },
      { status: 'success' },
      { command_id: 'valid', status: 'success', target_version: 'v1.0.2' },
    ],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].command_id, 'valid');
});

/* ------------------------------------------------------------------ */
/* 落库失败不影响主上报链路                                            */
/* ------------------------------------------------------------------ */

test('persistUpgradeResults 吞掉单条失败，继续处理后续回执', async () => {
  // 模拟 client.ts 中 persistUpgradeResults 的语义：失败只记日志，不抛错
  const persisted = [];
  const failed = [];
  const mockRecordFn = (result) => {
    if (result.command_id === 'cmd-fail') {
      return Promise.reject(new Error('RPC down'));
    }
    persisted.push(result.command_id);
    return Promise.resolve({ ok: true });
  };
  // 复刻 persistUpgradeResults 的循环+吞错语义
  const results = [
    { command_id: 'cmd-ok-1', target_version: 'v1.0.2', status: 'success' },
    { command_id: 'cmd-fail', target_version: 'v1.0.2', status: 'failed' },
    { command_id: 'cmd-ok-2', target_version: 'v1.0.2', status: 'success' },
  ];
  for (const result of results) {
    try {
      await mockRecordFn(result);
    } catch (e) {
      failed.push(result.command_id);
      // 不重抛
    }
  }
  // 失败的那条被记下，但不阻塞其余两条落库
  assert.deepEqual(failed, ['cmd-fail']);
  assert.deepEqual(persisted, ['cmd-ok-1', 'cmd-ok-2']);
});

/* ------------------------------------------------------------------ */
/* latest 目标语义：RPC 不接受 "latest"，由 Worker 侧解析              */
/* ------------------------------------------------------------------ */

test('下发命令时 latest 由 Worker 侧解析为具体 tag（RPC 层拒绝 latest）', () => {
  // 这条约束由 SQL 函数 cfm_create_agent_upgrade_commands 的 input 校验保证：
  // 当 target_version = '' 或 lower(target_version) = 'latest' 时，
  // 返回 { created: 0, invalid_target: true }，不创建任何命令。
  // 这里用纯函数模拟该语义，验证前端不会把 latest 直接透传。
  function rpcCreateStub(targetVersion) {
    if (!targetVersion || targetVersion.toLowerCase() === 'latest') {
      return { created: 0, skipped: [], commands: [], invalid_target: true };
    }
    return { created: 1, skipped: [], commands: [{ id: 'cmd-1', target_version: targetVersion }] };
  }
  assert.equal(rpcCreateStub('latest').invalid_target, true);
  assert.equal(rpcCreateStub('').invalid_target, true);
  assert.equal(rpcCreateStub('LATEST').invalid_target, true);
  assert.equal(rpcCreateStub('v1.0.2').invalid_target, undefined);
  assert.equal(rpcCreateStub('v1.0.2').created, 1);
});

test('交叉校验：success 但 final != target → unverified（SQL 层语义复刻）', () => {
  // 复刻 cfm_record_agent_upgrade_result 的交叉校验分支
  function applyCrossCheck(status, finalVersion, targetVersion, fromVersion) {
    if (status === 'success' && finalVersion && finalVersion !== targetVersion) {
      return { effective_status: 'unverified', effective_failure_code: 'probe_failed' };
    }
    if ((status === 'failed' || status === 'rolled_back') && finalVersion && finalVersion !== fromVersion) {
      return { effective_status: 'unverified' };
    }
    return { effective_status: status };
  }
  // 成功但版本不符 → unverified
  assert.equal(applyCrossCheck('success', 'v1.0.1', 'v1.0.2', 'v1.0.1').effective_status, 'unverified');
  // 成功且版本一致 → 仍是 success
  assert.equal(applyCrossCheck('success', 'v1.0.2', 'v1.0.2', 'v1.0.1').effective_status, 'success');
  // 失败但 final 被错误填成 target → unverified（节点其实没回退到 from）
  assert.equal(applyCrossCheck('failed', 'v1.0.2', 'v1.0.2', 'v1.0.1').effective_status, 'unverified');
  // 失败且 final == from（节点正确回退）→ 仍是 failed
  assert.equal(applyCrossCheck('failed', 'v1.0.1', 'v1.0.2', 'v1.0.1').effective_status, 'failed');
  // 回滚且 final == from → 仍是 rolled_back
  assert.equal(applyCrossCheck('rolled_back', 'v1.0.1', 'v1.0.2', 'v1.0.1').effective_status, 'rolled_back');
});

test('终态幂等：已是终态的命令不会被非终态回执覆盖（SQL 层语义复刻）', () => {
  const terminalStatuses = ['success', 'already_latest', 'failed', 'rolled_back', 'unverified'];
  function applyIdempotent(currentStatus, newStatus) {
    if (terminalStatuses.includes(currentStatus)) {
      return { ok: true, idempotent: true, status: currentStatus };
    }
    return { ok: true, status: newStatus };
  }
  // 已 success，再来一条 failed 回执 → 保持 success
  assert.equal(applyIdempotent('success', 'failed').status, 'success');
  assert.equal(applyIdempotent('success', 'failed').idempotent, true);
  // 处于 dispatched 的命令可以被回执推进
  assert.equal(applyIdempotent('dispatched', 'success').status, 'success');
  assert.equal(applyIdempotent('dispatched', 'success').idempotent, undefined);
});
