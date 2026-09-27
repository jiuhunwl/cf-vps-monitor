import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const projectRef = 'abcdefghijklmnopqrst';

function request(env) {
  const { setupRoutes } = createWorkerLoader({ db: {} }).load('worker/src/routes/setup.ts');
  return setupRoutes.fetch(new Request('https://panel.example.test/database/init', {
    headers: { 'CF-Connecting-IP': '1.1.1.1' },
  }), env, { waitUntil() {}, passThroughOnException() {} });
}

/**
 * 这个 GET 在 index.ts 的 canServeWithoutDatabaseStartup 白名单里（数据库未就绪时也要能
 * 打开初始化页），所以无法按「管理员是否已存在」降级 —— 它对匿名访问者永远可达。
 * 完整 project ref 足以拼出 `https://<ref>.supabase.co`，而部署者刻意不公开该地址
 * （.gitignore 忽略 .dev.vars*，deploy-cloudflare.mjs 也让 CI 不必配它）。
 */
test('AUD-06: the anonymous init probe never discloses a routable Supabase project ref', async () => {
  const response = await request({ SUPABASE_URL: `https://${projectRef}.supabase.co`, SUPABASE_SECRET_KEY: 'sb_secret_synthetic' });
  assert.equal(response.status, 200);
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.ok(!serialized.includes(projectRef), 'the full project ref must never reach an anonymous caller');
  assert.ok(!serialized.includes('.supabase.co'), 'nor anything that resolves to the project host');
  assert.equal(body.project_ref, undefined, 'the disclosed field must be gone, not merely renamed around');

  // 仍然要能让操作者确认 worker 指向的是哪个项目。
  assert.equal(body.ok, true);
  assert.equal(typeof body.migration_count, 'number');
  assert.equal(typeof body.project_ref_hint, 'string');
  assert.equal(body.project_ref_hint.startsWith(projectRef.slice(0, 4)), true);
  assert.equal(body.project_ref_hint.endsWith(projectRef.slice(-2)), true);
  assert.ok(body.project_ref_hint.length < projectRef.length, 'the hint must stay shorter than the ref');
  assert.ok(!body.project_ref_hint.includes(projectRef.slice(4, -2)), 'the middle of the ref stays hidden');
});

test('AUD-06: an unconfigured deployment reports the failure without inventing a hint', async () => {
  for (const env of [
    { SUPABASE_SECRET_KEY: 'sb_secret_synthetic' },
    { SUPABASE_URL: 'https://PROJECT_REF.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_synthetic' },
  ]) {
    const response = await request(env);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.project_ref_hint, null);
    assert.ok(!JSON.stringify(body).includes('PROJECT_REF'));
  }
});
