-- =====================================================================
-- cf-vps-monitor 升级前自检（只读，不改任何数据）
--
-- 用途：在再次执行 UPGRADE_ALL_safe.sql 之前确认当前库的状态
-- 看完结果自己判断要不要继续，这个脚本本身不会改任何东西
-- =====================================================================

-- ① 当前迁移版本标记（升级目标终值：postgres-2026-07-09-webhook-notifications）
select
  coalesce(
    (select value from public.settings where key = 'schema_bootstrap_version'),
    '(未写入版本标记，可能是全新库或未通过 /db-init 初始化)'
  ) as 当前版本标记,
  case
    when to_regclass('cfm_internal.setup_migrations') is null
      then 'cfm_internal 不存在（手动执行 SQL 不会有登记记录，属正常）'
    else (select count(*)::text || ' 条已登记' from cfm_internal.setup_migrations)
  end as 迁移登记表;

-- ② cfm_public_clients 函数当前返回的字段（这是泄露的关键）
-- 直接看定义里是否还 SELECT ipv4/ipv6
select
  case
    when pg_get_functiondef('public.cfm_public_clients()'::regprocedure) ~ 'ipv4,\s*ipv6'
      then '❌ 仍返回 ipv4/ipv6（旧版本，需要重新执行 UPGRADE_ALL_safe.sql）'
    when pg_get_functiondef('public.cfm_public_clients()'::regprocedure) ~ 'has_ipv4'
      then '✅ 已是修复后版本（has_ipv4 替代 ipv4）'
    else '⚠️ 函数不存在或被改写过，请人工检查'
  end as cfm_public_clients_状态,
  case
    when pg_get_functiondef('public.cfm_public_clients()'::regprocedure) ~ 'has_ipv4'
      then '无需重复执行升级'
    else '建议执行 UPGRADE_ALL_safe.sql（幂等，重复执行不会报错）'
  end as 建议;

-- ③ 节点数据完整性快速核对（行数 + 最新数据时间）
select
  (select count(*) from clients) as 节点总数,
  (select count(*) from records where time > now() - interval '1 hour') as 最近1小时记录数,
  (select count(*) from users) as 用户数,
  (select max(time) from records) as 最新一条记录时间;
