// 临时脚本：从 UPGRADE_ALL_safe.sql 解析 v2.0.3 完整对象契约，生成只读诊断 SQL
// 用法：node scripts/gen-diagnose-sql.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sql = readFileSync(join(root, 'supabase/migrations/UPGRADE_ALL_safe.sql'), 'utf8');

// 去掉行注释，避免误匹配
const clean = sql.replace(/--[^\n]*/g, '');

const tables = new Map(); // table -> Set(column)
const indexes = new Map(); // "name|schema" -> true
const functions = new Map(); // "schema.name" -> true
const constraints = new Set(); // table.constraint

// --- create table if not exists <name> ( ... ) ---
{
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m;
  while ((m = re.exec(clean))) {
    const name = m[1].toLowerCase();
    const open = clean.indexOf('(', m.index + m[0].length - 1);
    let depth = 0;
    let j = open;
    for (; j < clean.length; j++) {
      const ch = clean[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = clean.slice(open + 1, j);
    const items = splitTopLevel(body);
    const cols = tables.get(name) ?? new Set();
    for (const raw of items) {
      const item = raw.trim();
      if (!item) continue;
      const first = item.split(/\s+/)[0].replace(/"/g, '').toLowerCase();
      if (/^(constraint|primary|unique|check|foreign|exclude|like|period)$/.test(first)) continue;
      cols.add(first);
    }
    tables.set(name, cols);
  }
}

// --- alter table <t> add column if not exists <c> ---
{
  const re = /alter\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+add\s+column\s+if\s+not\s+exists\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(clean))) {
    const t = m[1].toLowerCase();
    const c = m[2].toLowerCase();
    if (!tables.has(t)) tables.set(t, new Set());
    tables.get(t).add(c);
  }
}

// --- create [unique] index [if not exists] <name> [on schema.table] ---
{
  const re = /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s+on\s+(?:([a-z_][a-z0-9_]*)\.)?[a-z_]/gi;
  let m;
  while ((m = re.exec(clean)))
    indexes.set(`${m[1].toLowerCase()}|${(m[2] ?? 'public').toLowerCase()}`);
}

// --- create or replace function [schema.]<name> ---
{
  const re = /create\s+or\s+replace\s+function\s+(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(clean))) functions.set(`${(m[1] ?? 'public').toLowerCase()}.${m[2].toLowerCase()}`);
}

// --- 命名约束（逐语句匹配，禁止跨语句漂移）---
{
  // 先把 clean 切成语句（跳过 $$ 函数体内部），再逐句找 alter table X ... add constraint Y
  const statements = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < clean.length; i++) {
    const two = clean.slice(i, i + 2);
    if (two === '$$') {
      inDollar = !inDollar;
      cur += two;
      i++;
      continue;
    }
    if (clean[i] === ';' && !inDollar) {
      statements.push(cur);
      cur = '';
    } else {
      cur += clean[i];
    }
  }
  if (cur.trim()) statements.push(cur);

  for (const stmt of statements) {
    const tbl = /alter\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)/i.exec(stmt);
    if (!tbl) continue;
    const adds = stmt.matchAll(/add\s+constraint\s+([a-z_][a-z0-9_]*)/gi);
    for (const a of adds) constraints.add(`${tbl[1].toLowerCase()}.${a[1].toLowerCase()}`);
  }
}

function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ---- 组装 VALUES ----
const rows = [];
rows.push(`    ('schema', null, 'public')`);
rows.push(`    ('schema', null, 'cfm_internal')`);
for (const t of [...tables.keys()].sort()) rows.push(`    ('table', null, '${t}')`);
for (const [t, cols] of [...tables.entries()].sort())
  for (const c of [...cols].sort()) rows.push(`    ('column', '${t}', '${c}')`);
for (const i of [...indexes.keys()].sort()) {
  const [name, nsp] = i.split('|');
  rows.push(`    ('index', '${nsp}', '${name}')`);
}
for (const f of [...functions.keys()].sort()) {
  const [nsp, name] = f.split('.');
  rows.push(`    ('function', '${nsp}', '${name}')`);
}
for (const c of [...constraints].sort()) {
  const [t, n] = c.split('.');
  rows.push(`    ('constraint', '${t}', '${n}')`);
}

const total = rows.length;

const out = `-- =====================================================================
-- cf-vps-monitor 数据库状态诊断（纯只读，可反复执行，不会修改任何数据）
--
-- 用法：Supabase SQL Editor -> New query -> 整段粘贴执行
-- 看结果：
--   ① 版本标记速查（schema_bootstrap_version / 迁移登记数）
--   ② 对象契约核对（表/列/索引/函数/约束，列出所有「缺失」项）
--   ③ 关键列属性核对（存在但属性不对也会出问题，如 records.load 仍为 NOT NULL）
--
-- 判定：
--   - 全部 OK            -> 数据库已是最新，无需执行 UPGRADE_ALL_safe.sql
--   - 有「缺失」           -> 执行 supabase/migrations/UPGRADE_ALL_safe.sql 后再跑一次本脚本
--  本文件由官方迁移文件解析生成，共 ${total} 个检查项
-- =====================================================================

-- ① 版本标记速查 -------------------------------------------------------
-- 注意：CASE 未命中分支里的表引用也会在解析期被分析，空库会直接报错，
-- 因此这里用 pg_temp 动态函数把表名解析推迟到运行时（只读，会话结束自动消失）。
create or replace function pg_temp.diag_versions()
returns table (schema_bootstrap_version text, setup_migrations text)
language plpgsql
as $$
declare
  settings_value text;
  migrations_value text;
begin
  if to_regclass('public.settings') is not null then
    execute 'select coalesce((select value from public.settings where key = ''schema_bootstrap_version''), ''(未写入版本标记)'')'
      into settings_value;
  else
    settings_value := 'settings 表不存在（数据库未初始化）';
  end if;
  if to_regclass('cfm_internal.setup_migrations') is not null then
    execute 'select count(*)::text || '' 条迁移已登记'' from cfm_internal.setup_migrations'
      into migrations_value;
  else
    migrations_value := 'cfm_internal 不存在：从未通过 Worker /db-init 初始化（手动执行 SQL 无此记录，属正常）';
  end if;
  return query select settings_value, migrations_value;
end $$;

select * from pg_temp.diag_versions();

-- ② 对象契约核对 -------------------------------------------------------
with expected(kind, tbl, obj) as (
  values
${rows.join(',\n')}
),
checked as (
  select
    e.kind,
    case when e.kind in ('column', 'constraint') then e.tbl || '.' || e.obj else e.obj end as obj,
    case
      when e.kind = 'schema' then exists (
        select 1 from pg_namespace n where n.nspname = e.obj)
      when e.kind = 'table' then exists (
        select 1 from information_schema.tables t
        where t.table_schema = 'public' and t.table_name = e.obj)
      when e.kind = 'column' then exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.obj)
      when e.kind = 'index' then exists (
        select 1 from pg_class i join pg_namespace n on n.oid = i.relnamespace
        where n.nspname = coalesce(e.tbl, 'public') and i.relname = e.obj and i.relkind = 'i')
      when e.kind = 'function' then exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname = e.obj and n.nspname = coalesce(e.tbl, 'public'))
      when e.kind = 'constraint' then exists (
        select 1 from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = e.tbl and k.conname = e.obj)
      else false
    end as ok
  from expected e
)
select
  case when ok then 'OK' else '缺失' end as 状态,
  kind as 类型,
  obj as 对象
from checked
order by ok, case kind when 'schema' then 0 when 'table' then 1 when 'column' then 2 when 'index' then 3 when 'constraint' then 4 else 5 end, obj;

-- ③ 关键列属性核对 -----------------------------------------------------
select 检查项, case when 通过 then 'OK' else '不符合' end as 状态
from (
  select 'records.load / records.temp 允许 NULL（老库为 NOT NULL，新版探针上报 null 会插入失败）' as 检查项,
    not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'records'
        and c.column_name in ('load', 'temp') and c.is_nullable = 'NO') as 通过
  union all
  select 'clients.traffic_limit_type 默认值为 sum',
    exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'clients'
        and c.column_name = 'traffic_limit_type' and c.column_default like '%sum%')
  union all
  select 'clients.traffic_reset_day 默认值为 1',
    exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'clients'
        and c.column_name = 'traffic_reset_day' and c.column_default like '%1%')
  union all
  select 'offline_notifications.grace_period 默认值为 360',
    exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'offline_notifications'
        and c.column_name = 'grace_period' and c.column_default like '%360%')
  union all
  select 'login_rate_limits.failure_revision 有默认值',
    exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'login_rate_limits'
        and c.column_name = 'failure_revision' and c.column_default is not null)
  union all
  select 'clients_token_hash_key 唯一约束存在（token_hash 唯一）',
    exists (
      select 1 from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'clients' and k.conname = 'clients_token_hash_key')
  union all
  select 'users_totp_state_consistent 约束存在（2FA 状态一致性）',
    exists (
      select 1 from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'users' and k.conname = 'users_totp_state_consistent')
  union all
  select 'users_recovery_code_hashes_array 约束存在（恢复码数量限制）',
    exists (
      select 1 from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'users' and k.conname = 'users_recovery_code_hashes_array')
  union all
  select 'website_monitors_method_check 约束包含 TCP（TCP 监控）',
    exists (
      select 1 from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'website_monitors'
        and k.conname = 'website_monitors_method_check'
        and pg_get_constraintdef(k.oid) like '%TCP%')
) t
order by 通过, 检查项;
`;

writeFileSync(join(root, 'supabase/migrations/DIAGNOSE_db_state.sql'), out);
const t = [...tables.entries()].map(([k, v]) => `${k}(${v.size})`).join(' ');
console.log(`tables: ${tables.size} ${t}`);
console.log(`columns: ${[...tables.values()].reduce((a, s) => a + s.size, 0)}`);
console.log(`indexes: ${indexes.size}`);
console.log(`functions: ${functions.size}`);
console.log(`constraints: ${constraints.size}`);
console.log(`total checks: ${total}`);
