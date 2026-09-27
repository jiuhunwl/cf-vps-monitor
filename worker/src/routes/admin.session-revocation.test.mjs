import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';
import { hashPassword } from '../auth/password.ts';

// 改密会轮换 session_version，从而让旧 cookie 失效。但 hasAdminSession 在验签之后会先查
// 边缘缓存里键在 session_version 上的「已鉴权」标记，命中就**完全跳过** DB 校验 ——
// 于是只要没人删掉旧版本的标记，被轮换掉的 cookie 仍会在这段 TTL 内继续放行。
// 改用户名与登出都会删，改密这条路原先漏了。
const UUID = 'admin-uuid-fixture';
const USERNAME = 'auditor';
const OLD_PASSWORD = 'Audit-Old-Password-2026';
const NEW_PASSWORD = 'Audit-New-Password-2026';
const OLD_SESSION_VERSION = 3;
const NEW_SESSION_VERSION = 4;

// 被测试的模块跑在 vm 沙箱里，`caches` 不在沙箱默认全局上（所以这里必须显式注入，
// 否则被测代码里的 `typeof caches === 'undefined'` 守卫会让整条逻辑静默空转）。
function createCacheStub() {
  const store = new Map();
  const cache = {
    default: {
      match: async request => (store.has(request.url) ? new Response(store.get(request.url)) : undefined),
      put: async (request, response) => { store.set(request.url, await response.text()); },
      delete: async request => store.delete(request.url),
    },
  };
  return { cache, store };
}

function sessionMarkerKey(userId, sessionVersion) {
  return `https://cf-monitor.internal/cache/admin-session/${encodeURIComponent(userId)}/${sessionVersion}`;
}

async function fixture(cache) {
  const passwd = await hashPassword(OLD_PASSWORD);
  const user = { uuid: UUID, username: USERNAME, passwd, session_version: OLD_SESSION_VERSION };
  const db = {
    getUserByUsername: async () => ({ ...user }),
    updateUserPasswordAndRotateSession: async () => ({ ...user, session_version: NEW_SESSION_VERSION }),
    insertAuditLog: async () => {},
  };
  const loader = createWorkerLoader({ db, globals: { caches: cache } });
  const { adminRoutes } = loader.load('worker/src/routes/admin.ts');
  // 生产环境里 userId / username 由鉴权中间件写入上下文，这里补上等价的一层。
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId', UUID);
    c.set('username', USERNAME);
    await next();
  });
  app.route('/api/admin', adminRoutes);
  return {
    app,
    env: { JWT_SECRET: 's'.repeat(40) },
    executionCtx: { waitUntil: () => {}, passThroughOnException() {} },
  };
}

test('AUD-09 changing the admin password drops the edge-cached marker of the superseded session version', async () => {
  const { cache, store } = createCacheStub();
  const f = await fixture(cache);
  // 前置条件：改密前那次请求已经让旧版本号下出现了一条「已鉴权」标记。
  store.set(sessionMarkerKey(UUID, OLD_SESSION_VERSION), '1');

  const response = await f.app.fetch(new Request('https://panel.synthetic.test/api/admin/account/chpasswd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_password: OLD_PASSWORD, new_password: NEW_PASSWORD }),
  }), f.env, f.executionCtx);
  assert.equal(response.status, 200, await response.clone().text());

  assert.equal(store.has(sessionMarkerKey(UUID, OLD_SESSION_VERSION)), false,
    'the marker keyed on the revoked session version must be dropped, otherwise hasAdminSession keeps accepting the rotated-away cookie for the whole edge-cache TTL without ever consulting the database');
  assert.equal(store.has(sessionMarkerKey(UUID, NEW_SESSION_VERSION)), false,
    'password change must not fabricate a marker for the new version: that decision belongs to a real authenticated request');
});
