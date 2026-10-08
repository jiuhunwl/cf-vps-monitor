import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applyApplicationMigrations, createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

async function asRole(database, role, action) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await database.exec('set role ' + role);
  try { return await action(); }
  finally { await database.exec('reset role'); }
}

async function manualUpgradeSection() {
  const sql = await readFile(new URL('../../../../supabase/tools/UPGRADE_ALL_safe.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('create table if not exists agent_upgrade_commands (');
  const grant = 'grant execute on function public.cfm_expire_agent_upgrade_commands(timestamptz, int) to service_role;';
  const endGrant = sql.indexOf(grant, start);
  assert.ok(start >= 0 && endGrant > start, 'the manual upgrade contains the complete Agent RPC section');
  const notification = "notify pgrst, 'reload schema';";
  const end = sql.indexOf(notification, endGrant + grant.length);
  assert.ok(end >= endGrant, 'the upgrade refreshes the API schema cache after its RPCs');
  return sql.slice(start, end + notification.length);
}

for (const mode of ['bundled migrations', 'manual upgrade section']) {
  test('Agent upgrade schema restores its RPC and restricts command authority: ' + mode, { timeout: 180000 }, async () => {
    const database = await createTestDatabase({ migrate: false });
    try {
      await database.exec(`
        create table public.unrelated_upgrade_data (id integer primary key);
        grant select on public.unrelated_upgrade_data to anon;
        alter default privileges in schema public grant all on tables to public, anon, authenticated;
        alter default privileges in schema public revoke all on tables from service_role;
      `);
      await applyApplicationMigrations(database);
      if (mode === 'manual upgrade section') {
        // Reproduce an older catalog and permissive table only inside this fixture.
        await database.exec(`
          drop function public.cfm_create_agent_upgrade_commands(jsonb);
          alter table public.agent_upgrade_commands disable row level security;
          alter table public.agent_upgrade_commands no force row level security;
          grant all on public.agent_upgrade_commands to public, anon, authenticated;
          revoke all on public.agent_upgrade_commands from service_role;
        `);
        assert.equal((await database.query("select to_regprocedure('public.cfm_create_agent_upgrade_commands(jsonb)')::text as signature")).rows[0].signature, null);
        await database.exec('begin; set local search_path = public;\n' + await manualUpgradeSection() + '\ncommit;');
      }
      const catalog = (await database.query(`
        select c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
          has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon_access,
          has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') as authenticated_access,
          has_table_privilege('service_role', c.oid, 'select') as service_select,
          has_table_privilege('service_role', c.oid, 'insert') as service_insert,
          has_table_privilege('service_role', c.oid, 'update') as service_update,
          has_table_privilege('service_role', c.oid, 'delete') as service_delete
        from pg_class c where c.oid = 'public.agent_upgrade_commands'::regclass
      `)).rows[0];
      assert.deepEqual(catalog, { rls: true, force_rls: true, anon_access: false,
        authenticated_access: false, service_select: true, service_insert: true, service_update: true, service_delete: true });
      const signature = (await database.query(`select proargnames from pg_proc
        where oid = 'public.cfm_create_agent_upgrade_commands(jsonb)'::regprocedure`)).rows[0];
      assert.deepEqual(signature.proargnames, ['input'], 'PostgREST can match the Worker input argument');
      for (const role of ['anon', 'authenticated']) {
        await assert.rejects(asRole(database, role, () => database.query('select * from public.agent_upgrade_commands')), error => error.code === '42501');
        await assert.rejects(asRole(database, role, () => database.query("insert into public.agent_upgrade_commands(client_uuid, target_version) values ('fixture-node', 'v2.0.4')")), error => error.code === '42501');
      }
      await database.exec("insert into public.clients(uuid, name) values ('fixture-node', 'Fixture')");
      const created = await asRole(database, 'service_role', () => rpc(database, 'cfm_create_agent_upgrade_commands', {
        input: { client_uuids: ['fixture-node'], target_version: 'v2.0.4', requested_by: 'synthetic-admin' },
      }));
      assert.equal(created.created, 1, 'the intended backend can queue upgrades without permissive defaults');
      assert.equal(created.commands[0].client_uuid, 'fixture-node');
      if (mode === 'bundled migrations') await applyApplicationMigrations(database);
      else await database.exec('begin; set local search_path = public;\n' + await manualUpgradeSection() + '\ncommit;');
      assert.equal((await database.query('select count(*)::int as count from public.agent_upgrade_commands')).rows[0].count, 1, 'rerunning the upgrade preserves commands');
      assert.equal((await database.query("select has_table_privilege('anon', 'public.unrelated_upgrade_data', 'select') as allowed")).rows[0].allowed, true, 'unrelated schema access remains intact');
    } finally {
      await database.close();
    }
  });
}
