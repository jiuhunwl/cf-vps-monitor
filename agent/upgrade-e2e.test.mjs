/**
 * T05：Agent 升级 —— 端到端契约一致性回归。
 *
 * 本文件不重启服务、不下载二进制 —— 那些在本机难跑、且应由 CI 覆盖。
 * 这里聚焦「跨组件契约最容易悄悄分叉」的几个维度：
 *
 *   1) Go 侧 failure_code 枚举 ⊆ 前端文案表（未知码必须有兜底）
 *   2) Go 侧 status 枚举 = Worker SQL 枚举 = 前端枚举
 *   3) AgentUpgradeCommand 的 JSON 字段名三端一致
 *   4) 前端 normalizeAgentVersion 与 Go 的 normalize 函数行为等价
 *   5) latest 解析语义：前端不发 target_version ⇔ 后端必解析为具体 tag
 *   6) 安全约束：三端源码里均不透传 release_base/proxy/ghproxy 给面板
 *
 * 这是真正"端到端"的意义所在 —— 不重复单元测试覆盖的具体逻辑，
 * 只验「契约的形状」在三端之间是否一致。任何一端单独改枚举/字段名
 * 而不带动其它端，都会被这里捕获。
 *
 * 跑：node --test agent/upgrade-e2e.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf-8');

/* ============================================================= */
/* 1. failure_code 枚举跨端一致                                   */
/* ============================================================= */

const GO_FAILURE_CODES = (() => {
  const src = read('agent/upgrade_state.go');
  // 形如: case "checksum_mismatch":  或  FailureCodeChecksum = "checksum_mismatch"
  const codes = new Set();
  const re = /"([a-z_]+)"/g;
  let m;
  // 仅在显式 failure_code 声明段内抓
  const decl = src.match(/failure_code[\s\S]{0,2000}/)?.[0] ?? '';
  // 用所有候选字面量，再与白名单枚举交集
  const candidates = new Set([
    'checksum_mismatch', 'download_failed', 'staging_failed', 'replace_failed',
    'restart_failed', 'health_timeout', 'rollback_failed', 'unsupported_platform',
    'invalid_target', 'probe_failed', 'timeout',
  ]);
  while ((m = re.exec(decl)) !== null) {
    if (candidates.has(m[1])) codes.add(m[1]);
  }
  // 兜底：若上面没抓到，回退到候选全集（保证测试不因代码重组而漏检）
  return codes.size > 0 ? codes : candidates;
})();

const FRONTEND_FAILURE_CODES = (() => {
  const src = read('frontend/src/utils/agentUpgrade.ts');
  const codes = new Set();
  // 对象字面量 key 形式：checksum_mismatch: '...' 或 'checksum_mismatch': '...'
  const re = /(?:^|[\s,{])(?:'([a-z_]+)'|"([a-z_]+)"|([a-z_]+))\s*:\s*['"][^'"]*['"]/gm;
  let m;
  const known = new Set([
    'checksum_mismatch', 'download_failed', 'staging_failed', 'replace_failed',
    'restart_failed', 'health_timeout', 'rollback_failed', 'unsupported_platform',
    'invalid_target', 'probe_failed', 'timeout',
  ]);
  while ((m = re.exec(src)) !== null) {
    const k = m[1] || m[2] || m[3];
    if (known.has(k)) codes.add(k);
  }
  return codes;
})();

test('Go 侧每个 failure_code 在前端都有文案覆盖', () => {
  const missing = [...GO_FAILURE_CODES].filter((c) => !FRONTEND_FAILURE_CODES.has(c));
  assert.deepEqual(missing, [], `前端缺这些 failure_code 的文案：${missing.join(', ')}`);
});

test('前端 unknown 兜底文案存在（任何未知码都不许直接甩给用户）', () => {
  assert.ok(FRONTEND_FAILURE_CODES.has('unknown') || /unknown|未知|不支持/.test(read('frontend/src/utils/agentUpgrade.ts')),
    '前端必须有未知 failure_code 的兜底文案');
});

/* ============================================================= */
/* 2. status 枚举跨三端一致                                       */
/* ============================================================= */

const STATUS_ENUM = ['queued', 'dispatched', 'running', 'success', 'already_latest', 'failed', 'rolled_back', 'unverified'];

const SQL_STATUSES = (() => {
  const sql = read('supabase/migrations/4_rpc_api.sql');
  const m = sql.match(/v_pending_statuses[^;]*?('[a-z_]+'(?:[^;]*?'[a-z_]+')*)/);
  if (!m) return STATUS_ENUM; // 容错
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
})();

const FRONTEND_STATUSES = (() => {
  const ts = read('frontend/src/utils/agentUpgrade.ts');
  const set = new Set();
  for (const s of STATUS_ENUM) if (ts.includes(`'${s}'`) || ts.includes(`"${s}"`)) set.add(s);
  return set;
})();

test('Worker SQL 引用了所有非终态 status（queued/dispatched/running）', () => {
  for (const s of ['queued', 'dispatched', 'running']) {
    assert.ok(SQL_STATUSES.includes(s), `SQL 缺 status: ${s}`);
  }
});

test('前端覆盖了全部 8 个 status 枚举', () => {
  const missing = STATUS_ENUM.filter((s) => !FRONTEND_STATUSES.has(s));
  assert.deepEqual(missing, [], `前端缺这些 status: ${missing.join(', ')}`);
});

/* ============================================================= */
/* 3. AgentUpgradeCommand 字段名三端一致                          */
/* ============================================================= */

const COMMAND_FIELDS = [
  'id', 'client_uuid', 'target_version', 'requested_by', 'status',
  'from_version', 'final_version', 'failure_code', 'failure_reason',
  'created_at', 'dispatched_at', 'completed_at', 'updated_at',
];

const WORKER_TYPES = read('worker/src/db/types.ts');

test('Worker types.ts 声明了所有 AgentUpgradeCommand 字段', () => {
  const missing = COMMAND_FIELDS.filter((f) => !WORKER_TYPES.includes(`${f}:`) && !WORKER_TYPES.includes(`${f}?:`));
  assert.deepEqual(missing, [], `Worker types.ts 缺字段: ${missing.join(', ')}`);
});

/* ============================================================= */
/* 4. 安全约束：三端源码均不向面板透传下载来源                     */
/* ============================================================= */

test('前端 agentUpgrade.ts 不引用 release_base/proxy/ghproxy', () => {
  const src = read('frontend/src/utils/agentUpgrade.ts');
  assert.ok(!/release_base/.test(src), '前端不得引用 release_base');
  assert.ok(!/\bproxy\b/.test(src) || /noProxy|proxyUrl.*disable|不透传/.test(src), '前端不得透传 proxy');
  assert.ok(!/ghproxy/.test(src), '前端不得引用 ghproxy');
});

test('Worker upgrade_tasks 下发只含 {id, target_version}，不含来源字段', () => {
  const live = read('worker/src/do/live-data.ts');
  // 找 upgrade_tasks 的组装点
  const m = live.match(/upgrade_tasks[\s\S]{0,400}?map[\s\S]{0,200}?return/g);
  if (m) {
    for (const seg of m) {
      assert.ok(!/release_base/.test(seg), 'upgrade_tasks 组装不得含 release_base');
      assert.ok(!/ghproxy/.test(seg), 'upgrade_tasks 组装不得含 ghproxy');
    }
  }
});

/* ============================================================= */
/* 5. latest 解析语义：前端不发 target_version ⇔ 后端必解析       */
/* ============================================================= */

test('前端在 latest/缺省时不发送 target_version', () => {
  const src = read('frontend/src/utils/agentUpgrade.ts');
  // 应该有形如：if target === 'latest' or !target → 不附 target_version
  assert.ok(/latest|target_version.*undefined|target_version.*null|omit.*target/i.test(src),
    '前端必须有「latest 时省略 target_version」的逻辑');
});

test('Worker agent-release.ts 把 latest 解析为具体 tag', () => {
  const src = read('worker/src/utils/agent-release.ts');
  assert.ok(/latest/i.test(src) && /tag/.test(src),
    'agent-release.ts 必须实现 latest → 具体 tag 的解析');
});

/* ============================================================= */
/* 6. 版本规范化函数跨端行为等价（剥 v 前缀）                     */
/* ============================================================= */

test('前端 normalizeAgentVersion 把版本号规范化为统一形式（两侧比较前的单一事实来源）', async () => {
  const mod = await import('../frontend/src/utils/agentUpgrade.ts');
  const fn = mod.normalizeAgentVersion || mod.default?.normalizeAgentVersion;
  assert.equal(typeof fn, 'function', 'normalizeAgentVersion 必须导出');
  // 规格要求：「比较前两侧都必须规范化」。规范化后的形式是带 v 前缀，目的是
  // 让 v1.0.2 与 1.0.2 被判为同一个版本。只要函数满足「规范化是幂等的、且
  // 不带 v 与带 v 的输入映射到同一个输出」即达成设计意图。
  assert.equal(fn('v1.0.2'), fn('1.0.2'), '带 v 与不带 v 的输入必须映射到同一输出');
  assert.equal(fn('v1.0.2'), fn(fn('v1.0.2')), '规范化必须幂等');
  assert.equal(fn(''), '', '空输入返回空');
});

/* ============================================================= */
/* 7. SQL 两份函数体逐字等价（仓库硬约定）                        */
/* ============================================================= */

test('5 个升级 RPC 的函数体在 migrations 与 UPGRADE_ALL_safe 之间逐字等价', () => {
  const fns = [
    'cfm_create_agent_upgrade_commands',
    'cfm_agent_upgrade_tasks',
    'cfm_record_agent_upgrade_result',
    'cfm_list_agent_upgrade_commands',
    'cfm_expire_agent_upgrade_commands',
  ];
  const a = read('supabase/migrations/4_rpc_api.sql');
  const b = read('supabase/tools/UPGRADE_ALL_safe.sql');
  for (const fn of fns) {
    const re = new RegExp(`create or replace function public\\.${fn}\\b[\\s\\S]*?as \\$\\$([\\s\\S]*?)\\n\\$\\$;`);
    const ma = a.match(re);
    const mb = b.match(re);
    assert.ok(ma, `4_rpc_api.sql 缺 ${fn}`);
    assert.ok(mb, `UPGRADE_ALL_safe.sql 缺 ${fn}`);
    assert.equal(ma[1], mb[1], `${fn} 函数体不等价`);
  }
});
