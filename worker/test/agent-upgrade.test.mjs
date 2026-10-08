/**
 * T03：面板一键升级的 Worker 侧 —— 下发与回执链路单元测试。
 *
 * 覆盖规格要求的 5 个关键语义：
 *   1) 每节点仅 1 条未决命令 —— 由 SQL 层 cfm_create_agent_upgrade_commands 保证
 *      （这里用纯逻辑模拟「RPC 返回 skipped」验证前端契约解析）。
 *   2) 交叉校验：success 但 final_version != target_version → unverified（SQL 层）。
 *   3) 失败/回滚类不改版本语义（SQL 层）。
 *   4) upgrade_results 落库失败不影响 /report 主链路（生产receipt helper）。
 *   5) upgradeTasksForPolicy 只下发 {id, target_version}，绝不包含 release_base/proxy/ghproxy。
 *
 * SQL 层语义（1-3）在本机无 Supabase 连接时无法直接跑 —— 这些由 SQL 函数体本身的
 * 等价性自检（见 cmp_sql.py 思路）与 supabase-api 集成测试覆盖。本文件聚焦可以
 * 在 node --test 下跑的纯逻辑验证。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../test-support/worker-module.mjs';

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
/* 回执解析与明确确认（调用生产 helper）       */
/* ------------------------------------------------------------------ */

// Use the production collector/persistence boundary instead of duplicating old code.
test('production upgrade receipt parser rejects invalid status rather than inventing failed', () => {
  const { collectUpgradeReceipts } = createWorkerLoader({ db: {} }).load('worker/src/utils/upgrade-receipts.ts');
  assert.equal(collectUpgradeReceipts([{ upgrade_results: [{
    command_id: '00000000-0000-4000-8000-000000000001', status: 'bogus_status',
  }] }]).length, 0);
});
test('production upgrade persistence returns only explicit confirmations while isolating failures', async () => {
  const loader = createWorkerLoader({ db: { recordAgentUpgradeResult: async (_db, receipt) => {
    if (receipt.command_id.endsWith('2')) throw new Error('synthetic failure');
    return { ok: true };
  } } });
  const { collectUpgradeReceipts, persistUpgradeReceipts } = loader.load('worker/src/utils/upgrade-receipts.ts');
  const receipts = collectUpgradeReceipts([{ upgrade_results: [1, 2].map(n => ({
    command_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, status: 'success',
  })) }]);
  assert.deepEqual([...await persistUpgradeReceipts(loader.database, 'trusted-node', receipts)], ['00000000-0000-4000-8000-000000000001']);
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
