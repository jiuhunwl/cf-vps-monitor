-- =====================================================================
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
--  本文件由官方迁移文件解析生成，共 392 个检查项
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
    ('schema', null, 'public'),
    ('schema', null, 'cfm_internal'),
    ('table', null, 'audit_logs'),
    ('table', null, 'clients'),
    ('table', null, 'expiry_notifications'),
    ('table', null, 'gpu_records'),
    ('table', null, 'gpu_snapshots'),
    ('table', null, 'load_notifications'),
    ('table', null, 'login_rate_limits'),
    ('table', null, 'offline_notifications'),
    ('table', null, 'ping_records'),
    ('table', null, 'ping_snapshots'),
    ('table', null, 'ping_tasks'),
    ('table', null, 'records'),
    ('table', null, 'settings'),
    ('table', null, 'theme_assets'),
    ('table', null, 'themes'),
    ('table', null, 'users'),
    ('table', null, 'website_checks'),
    ('table', null, 'website_monitors'),
    ('column', 'audit_logs', 'action'),
    ('column', 'audit_logs', 'detail'),
    ('column', 'audit_logs', 'id'),
    ('column', 'audit_logs', 'level'),
    ('column', 'audit_logs', 'time'),
    ('column', 'audit_logs', 'user'),
    ('column', 'clients', 'arch'),
    ('column', 'clients', 'auto_renewal'),
    ('column', 'clients', 'billing_cycle'),
    ('column', 'clients', 'cpu_cores'),
    ('column', 'clients', 'cpu_name'),
    ('column', 'clients', 'created_at'),
    ('column', 'clients', 'currency'),
    ('column', 'clients', 'disk_total'),
    ('column', 'clients', 'expired_at'),
    ('column', 'clients', 'gpu_name'),
    ('column', 'clients', 'group'),
    ('column', 'clients', 'hidden'),
    ('column', 'clients', 'ipv4'),
    ('column', 'clients', 'ipv6'),
    ('column', 'clients', 'kernel_version'),
    ('column', 'clients', 'mem_total'),
    ('column', 'clients', 'name'),
    ('column', 'clients', 'os'),
    ('column', 'clients', 'price'),
    ('column', 'clients', 'public_remark'),
    ('column', 'clients', 'region'),
    ('column', 'clients', 'remark'),
    ('column', 'clients', 'sort_order'),
    ('column', 'clients', 'swap_total'),
    ('column', 'clients', 'tags'),
    ('column', 'clients', 'token'),
    ('column', 'clients', 'token_hash'),
    ('column', 'clients', 'token_last_used_at'),
    ('column', 'clients', 'token_last_used_ip'),
    ('column', 'clients', 'token_rotated_at'),
    ('column', 'clients', 'traffic_limit'),
    ('column', 'clients', 'traffic_limit_type'),
    ('column', 'clients', 'traffic_reset_day'),
    ('column', 'clients', 'updated_at'),
    ('column', 'clients', 'uuid'),
    ('column', 'clients', 'version'),
    ('column', 'clients', 'virtualization'),
    ('column', 'expiry_notifications', 'advance_days'),
    ('column', 'expiry_notifications', 'client'),
    ('column', 'expiry_notifications', 'enable'),
    ('column', 'expiry_notifications', 'last_notified'),
    ('column', 'gpu_records', 'client'),
    ('column', 'gpu_records', 'device_index'),
    ('column', 'gpu_records', 'device_name'),
    ('column', 'gpu_records', 'id'),
    ('column', 'gpu_records', 'mem_total'),
    ('column', 'gpu_records', 'mem_used'),
    ('column', 'gpu_records', 'temperature'),
    ('column', 'gpu_records', 'time'),
    ('column', 'gpu_records', 'utilization'),
    ('column', 'gpu_snapshots', 'client'),
    ('column', 'gpu_snapshots', 'devices_json'),
    ('column', 'gpu_snapshots', 'id'),
    ('column', 'gpu_snapshots', 'time'),
    ('column', 'load_notifications', 'clients'),
    ('column', 'load_notifications', 'id'),
    ('column', 'load_notifications', 'interval_min'),
    ('column', 'load_notifications', 'last_notified'),
    ('column', 'load_notifications', 'metric'),
    ('column', 'load_notifications', 'name'),
    ('column', 'load_notifications', 'ratio'),
    ('column', 'load_notifications', 'threshold'),
    ('column', 'login_rate_limits', 'bucket'),
    ('column', 'login_rate_limits', 'failure_revision'),
    ('column', 'login_rate_limits', 'failures'),
    ('column', 'login_rate_limits', 'first_failed_at'),
    ('column', 'login_rate_limits', 'last_failed_at'),
    ('column', 'login_rate_limits', 'locked_until'),
    ('column', 'offline_notifications', 'client'),
    ('column', 'offline_notifications', 'enable'),
    ('column', 'offline_notifications', 'grace_period'),
    ('column', 'offline_notifications', 'last_notified'),
    ('column', 'ping_records', 'client'),
    ('column', 'ping_records', 'id'),
    ('column', 'ping_records', 'task_id'),
    ('column', 'ping_records', 'time'),
    ('column', 'ping_records', 'value'),
    ('column', 'ping_snapshots', 'batch_hash'),
    ('column', 'ping_snapshots', 'client'),
    ('column', 'ping_snapshots', 'id'),
    ('column', 'ping_snapshots', 'time'),
    ('column', 'ping_snapshots', 'values_json'),
    ('column', 'ping_tasks', 'all_clients'),
    ('column', 'ping_tasks', 'clients'),
    ('column', 'ping_tasks', 'id'),
    ('column', 'ping_tasks', 'interval_sec'),
    ('column', 'ping_tasks', 'name'),
    ('column', 'ping_tasks', 'sort_order'),
    ('column', 'ping_tasks', 'target'),
    ('column', 'ping_tasks', 'type'),
    ('column', 'records', 'client'),
    ('column', 'records', 'connections'),
    ('column', 'records', 'connections_udp'),
    ('column', 'records', 'cpu'),
    ('column', 'records', 'disk'),
    ('column', 'records', 'disk_total'),
    ('column', 'records', 'gpu'),
    ('column', 'records', 'id'),
    ('column', 'records', 'load'),
    ('column', 'records', 'net_in'),
    ('column', 'records', 'net_out'),
    ('column', 'records', 'net_total_down'),
    ('column', 'records', 'net_total_up'),
    ('column', 'records', 'process_count'),
    ('column', 'records', 'ram'),
    ('column', 'records', 'ram_total'),
    ('column', 'records', 'swap'),
    ('column', 'records', 'swap_total'),
    ('column', 'records', 'temp'),
    ('column', 'records', 'time'),
    ('column', 'records', 'uptime'),
    ('column', 'settings', 'key'),
    ('column', 'settings', 'value'),
    ('column', 'theme_assets', 'content_base64'),
    ('column', 'theme_assets', 'content_type'),
    ('column', 'theme_assets', 'created_at'),
    ('column', 'theme_assets', 'path'),
    ('column', 'theme_assets', 'size_bytes'),
    ('column', 'theme_assets', 'theme_short'),
    ('column', 'themes', 'author'),
    ('column', 'themes', 'config_json'),
    ('column', 'themes', 'created_at'),
    ('column', 'themes', 'custom_css'),
    ('column', 'themes', 'description'),
    ('column', 'themes', 'manifest_json'),
    ('column', 'themes', 'name'),
    ('column', 'themes', 'preview_path'),
    ('column', 'themes', 'short'),
    ('column', 'themes', 'style_path'),
    ('column', 'themes', 'updated_at'),
    ('column', 'themes', 'url'),
    ('column', 'themes', 'version'),
    ('column', 'users', 'created_at'),
    ('column', 'users', 'passwd'),
    ('column', 'users', 'password_changed_at'),
    ('column', 'users', 'recovery_code_hashes'),
    ('column', 'users', 'session_version'),
    ('column', 'users', 'totp_enabled_at'),
    ('column', 'users', 'totp_last_used_step'),
    ('column', 'users', 'totp_secret_enc'),
    ('column', 'users', 'updated_at'),
    ('column', 'users', 'username'),
    ('column', 'users', 'uuid'),
    ('column', 'website_checks', 'checked_at'),
    ('column', 'website_checks', 'config_revision'),
    ('column', 'website_checks', 'effective_reason'),
    ('column', 'website_checks', 'effective_status'),
    ('column', 'website_checks', 'error'),
    ('column', 'website_checks', 'id'),
    ('column', 'website_checks', 'latency_ms'),
    ('column', 'website_checks', 'monitor_id'),
    ('column', 'website_checks', 'ok'),
    ('column', 'website_checks', 'raw_status_code'),
    ('column', 'website_checks', 'source_client'),
    ('column', 'website_checks', 'source_type'),
    ('column', 'website_checks', 'status_code'),
    ('column', 'website_monitors', 'agent_probe_clients'),
    ('column', 'website_monitors', 'agent_probe_limit'),
    ('column', 'website_monitors', 'agent_probe_mode'),
    ('column', 'website_monitors', 'agent_probe_status_enabled'),
    ('column', 'website_monitors', 'config_revision'),
    ('column', 'website_monitors', 'created_at'),
    ('column', 'website_monitors', 'down_since'),
    ('column', 'website_monitors', 'enabled'),
    ('column', 'website_monitors', 'expected_status_max'),
    ('column', 'website_monitors', 'expected_status_min'),
    ('column', 'website_monitors', 'grace_period_sec'),
    ('column', 'website_monitors', 'hidden'),
    ('column', 'website_monitors', 'hide_url'),
    ('column', 'website_monitors', 'id'),
    ('column', 'website_monitors', 'interval_sec'),
    ('column', 'website_monitors', 'last_checked_at'),
    ('column', 'website_monitors', 'last_effective_reason'),
    ('column', 'website_monitors', 'last_error'),
    ('column', 'website_monitors', 'last_failure_at'),
    ('column', 'website_monitors', 'last_latency_ms'),
    ('column', 'website_monitors', 'last_notified_at'),
    ('column', 'website_monitors', 'last_raw_status_code'),
    ('column', 'website_monitors', 'last_status_code'),
    ('column', 'website_monitors', 'last_success_at'),
    ('column', 'website_monitors', 'method'),
    ('column', 'website_monitors', 'name'),
    ('column', 'website_monitors', 'sort_order'),
    ('column', 'website_monitors', 'status'),
    ('column', 'website_monitors', 'timeout_sec'),
    ('column', 'website_monitors', 'updated_at'),
    ('column', 'website_monitors', 'url'),
    ('index', 'public', 'idx_audit_logs_time'),
    ('index', 'public', 'idx_clients_sort_order'),
    ('index', 'public', 'idx_gpu_records_client_time'),
    ('index', 'public', 'idx_gpu_records_time'),
    ('index', 'public', 'idx_gpu_snapshots_client_time'),
    ('index', 'public', 'idx_gpu_snapshots_time'),
    ('index', 'public', 'idx_login_rate_limits_last_failed'),
    ('index', 'cfm_internal', 'idx_notification_delivery_retired'),
    ('index', 'public', 'idx_ping_records_client_task_time'),
    ('index', 'public', 'idx_ping_records_time'),
    ('index', 'public', 'idx_ping_snapshots_client_time'),
    ('index', 'public', 'idx_ping_snapshots_delivery'),
    ('index', 'public', 'idx_ping_snapshots_time'),
    ('index', 'public', 'idx_ping_snapshots_values_json'),
    ('index', 'public', 'idx_ping_tasks_sort_order'),
    ('index', 'public', 'idx_records_client_time'),
    ('index', 'public', 'idx_records_time'),
    ('index', 'public', 'idx_website_checks_monitor_source_time'),
    ('index', 'public', 'idx_website_checks_monitor_time'),
    ('index', 'public', 'idx_website_checks_revision_source_time'),
    ('index', 'public', 'idx_website_monitors_due'),
    ('index', 'public', 'idx_website_monitors_sort_order'),
    ('function', 'cfm_internal', 'notification_delivery_entity_exists'),
    ('function', 'cfm_internal', 'notification_delivery_token_matches'),
    ('function', 'cfm_internal', 'retire_client_notification_deliveries'),
    ('function', 'cfm_internal', 'retire_entity_notification_deliveries'),
    ('function', 'cfm_internal', 'retire_notification_deliveries'),
    ('function', 'cfm_internal', 'rotate_website_config_revision'),
    ('function', 'public', 'cfm_admin_clients'),
    ('function', 'public', 'cfm_agent_client_by_token'),
    ('function', 'public', 'cfm_agent_client_identity_by_token'),
    ('function', 'public', 'cfm_agent_website_probe_tasks'),
    ('function', 'public', 'cfm_audit_logs_paged'),
    ('function', 'public', 'cfm_backup_configuration_snapshot'),
    ('function', 'public', 'cfm_bounded_storage_row_counts'),
    ('function', 'public', 'cfm_claim_notification_delivery'),
    ('function', 'public', 'cfm_cleanup_notification_delivery_state'),
    ('function', 'public', 'cfm_cleanup_orphan_client_data'),
    ('function', 'public', 'cfm_clear_all_records'),
    ('function', 'public', 'cfm_clear_client_records'),
    ('function', 'public', 'cfm_clear_login_rate_limits'),
    ('function', 'public', 'cfm_clear_observed_login_failures'),
    ('function', 'public', 'cfm_client'),
    ('function', 'public', 'cfm_client_capacity_counts'),
    ('function', 'public', 'cfm_client_create_conflict'),
    ('function', 'public', 'cfm_client_exists'),
    ('function', 'public', 'cfm_client_ids'),
    ('function', 'public', 'cfm_client_token_exists'),
    ('function', 'public', 'cfm_client_token_meta'),
    ('function', 'public', 'cfm_client_visibility'),
    ('function', 'public', 'cfm_clients_by_ids'),
    ('function', 'public', 'cfm_complete_notification_delivery'),
    ('function', 'public', 'cfm_consume_recovery_code'),
    ('function', 'public', 'cfm_consume_totp_step'),
    ('function', 'public', 'cfm_create_client'),
    ('function', 'public', 'cfm_create_initial_admin'),
    ('function', 'public', 'cfm_create_load_notification'),
    ('function', 'public', 'cfm_create_ping_task'),
    ('function', 'public', 'cfm_create_user'),
    ('function', 'public', 'cfm_create_website_monitor'),
    ('function', 'public', 'cfm_delete_clients'),
    ('function', 'public', 'cfm_delete_load_notification'),
    ('function', 'public', 'cfm_delete_login_rate_limits_before'),
    ('function', 'public', 'cfm_delete_old_audit_logs'),
    ('function', 'public', 'cfm_delete_old_ping_records'),
    ('function', 'public', 'cfm_delete_old_records'),
    ('function', 'public', 'cfm_delete_old_website_checks'),
    ('function', 'public', 'cfm_delete_ping_task'),
    ('function', 'public', 'cfm_delete_theme'),
    ('function', 'public', 'cfm_delete_user_if_matches'),
    ('function', 'public', 'cfm_delete_website_monitor'),
    ('function', 'public', 'cfm_disable_user_totp'),
    ('function', 'public', 'cfm_due_website_monitors'),
    ('function', 'public', 'cfm_enable_user_totp'),
    ('function', 'public', 'cfm_ensure_initial_admin'),
    ('function', 'public', 'cfm_expired_row_counts'),
    ('function', 'public', 'cfm_expiry_notification'),
    ('function', 'public', 'cfm_expiry_notifications'),
    ('function', 'public', 'cfm_gpu_records'),
    ('function', 'public', 'cfm_gpu_records_cursor'),
    ('function', 'public', 'cfm_gpu_records_paged'),
    ('function', 'public', 'cfm_history_storage_bytes'),
    ('function', 'public', 'cfm_history_storage_counts'),
    ('function', 'public', 'cfm_history_storage_usage'),
    ('function', 'public', 'cfm_insert_audit_log'),
    ('function', 'public', 'cfm_insert_gpu_snapshot'),
    ('function', 'public', 'cfm_insert_monitor_record'),
    ('function', 'public', 'cfm_insert_ping_snapshot'),
    ('function', 'public', 'cfm_latest_record_times'),
    ('function', 'public', 'cfm_latest_record_times_for_clients'),
    ('function', 'public', 'cfm_latest_records'),
    ('function', 'public', 'cfm_load_metric_window_stats'),
    ('function', 'public', 'cfm_load_notification'),
    ('function', 'public', 'cfm_load_notifications'),
    ('function', 'public', 'cfm_login_rate_limit'),
    ('function', 'public', 'cfm_login_rate_limits'),
    ('function', 'public', 'cfm_login_user'),
    ('function', 'public', 'cfm_mark_client_token_used'),
    ('function', 'public', 'cfm_mark_expiry_notification_sent'),
    ('function', 'public', 'cfm_mark_load_notification_sent'),
    ('function', 'public', 'cfm_mark_offline_notification_sent'),
    ('function', 'public', 'cfm_mark_website_monitor_notified'),
    ('function', 'public', 'cfm_offline_notification'),
    ('function', 'public', 'cfm_offline_notifications'),
    ('function', 'public', 'cfm_ping_records'),
    ('function', 'public', 'cfm_ping_records_cursor'),
    ('function', 'public', 'cfm_ping_records_for_tasks'),
    ('function', 'public', 'cfm_ping_records_paged'),
    ('function', 'public', 'cfm_ping_task'),
    ('function', 'public', 'cfm_ping_task_estimate_rows'),
    ('function', 'public', 'cfm_prune_client_references'),
    ('function', 'public', 'cfm_public_clients'),
    ('function', 'public', 'cfm_public_ping_tasks'),
    ('function', 'public', 'cfm_public_settings'),
    ('function', 'public', 'cfm_public_website_monitor'),
    ('function', 'public', 'cfm_public_websites'),
    ('function', 'public', 'cfm_recent_records'),
    ('function', 'public', 'cfm_record_login_failures'),
    ('function', 'public', 'cfm_record_website_check'),
    ('function', 'public', 'cfm_records_range'),
    ('function', 'public', 'cfm_records_range_cursor'),
    ('function', 'public', 'cfm_records_range_limited'),
    ('function', 'public', 'cfm_records_range_paged'),
    ('function', 'public', 'cfm_recover_single_admin'),
    ('function', 'public', 'cfm_reorder_clients'),
    ('function', 'public', 'cfm_reorder_ping_tasks'),
    ('function', 'public', 'cfm_reorder_website_monitors'),
    ('function', 'public', 'cfm_replace_user_recovery_codes'),
    ('function', 'public', 'cfm_restore_backup_data'),
    ('function', 'public', 'cfm_rotate_client_token'),
    ('function', 'public', 'cfm_rotate_user_session'),
    ('function', 'public', 'cfm_scheduled_clients'),
    ('function', 'public', 'cfm_scheduled_clients_by_ids'),
    ('function', 'public', 'cfm_set_expiry_notifications'),
    ('function', 'public', 'cfm_set_login_rate_limit'),
    ('function', 'public', 'cfm_set_login_rate_limits'),
    ('function', 'public', 'cfm_set_offline_notifications'),
    ('function', 'public', 'cfm_set_settings'),
    ('function', 'public', 'cfm_set_website_monitor_enabled'),
    ('function', 'public', 'cfm_set_website_monitor_visibility'),
    ('function', 'public', 'cfm_settings_by_keys'),
    ('function', 'public', 'cfm_storage_row_counts'),
    ('function', 'public', 'cfm_theme'),
    ('function', 'public', 'cfm_theme_asset'),
    ('function', 'public', 'cfm_themes'),
    ('function', 'public', 'cfm_try_claim_audit_throttle'),
    ('function', 'public', 'cfm_update_client'),
    ('function', 'public', 'cfm_update_client_returning'),
    ('function', 'public', 'cfm_update_clients_hidden'),
    ('function', 'public', 'cfm_update_load_notification'),
    ('function', 'public', 'cfm_update_ping_task'),
    ('function', 'public', 'cfm_update_theme_settings'),
    ('function', 'public', 'cfm_update_user_password'),
    ('function', 'public', 'cfm_update_user_password_rotate_session'),
    ('function', 'public', 'cfm_update_user_username'),
    ('function', 'public', 'cfm_update_user_username_rotate_session'),
    ('function', 'public', 'cfm_update_website_monitor'),
    ('function', 'public', 'cfm_upsert_theme'),
    ('function', 'public', 'cfm_user_by_uuid'),
    ('function', 'public', 'cfm_users_count'),
    ('function', 'public', 'cfm_validate_admin_session'),
    ('function', 'public', 'cfm_website_checks'),
    ('function', 'public', 'cfm_website_monitor'),
    ('function', 'public', 'cfm_website_monitors'),
    ('constraint', 'clients', 'clients_token_hash_key'),
    ('constraint', 'clients', 'clients_traffic_reset_day_check'),
    ('constraint', 'gpu_records', 'gpu_records_client_fkey'),
    ('constraint', 'gpu_snapshots', 'gpu_snapshots_client_fkey'),
    ('constraint', 'ping_records', 'ping_records_client_fkey'),
    ('constraint', 'ping_records', 'ping_records_task_fkey'),
    ('constraint', 'ping_snapshots', 'ping_snapshots_client_fkey'),
    ('constraint', 'records', 'records_client_fkey'),
    ('constraint', 'users', 'users_recovery_code_hashes_array'),
    ('constraint', 'users', 'users_totp_state_consistent'),
    ('constraint', 'website_checks', 'website_checks_source_client_fkey'),
    ('constraint', 'website_checks', 'website_checks_source_type_check'),
    ('constraint', 'website_monitors', 'website_monitors_agent_probe_limit_check'),
    ('constraint', 'website_monitors', 'website_monitors_agent_probe_mode_check'),
    ('constraint', 'website_monitors', 'website_monitors_method_check')
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
