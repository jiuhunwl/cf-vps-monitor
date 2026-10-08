import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const user = { uuid: 'fixture-admin', username: 'fixture-admin', session_version: 1 };
const snapshot = {
  online: ['fixture-node'], count: 1,
  data: { 'fixture-node': { cpu: 17, timestamp: 12345 } },
};

function fixture({ allowed = true, sessionUser = user } = {}) {
  const forwarded = [];
  const cached = new Map();
  const cacheWrites = [];
  const jobs = [];
  const loader = createWorkerLoader({
    db: { getUserByUuid: async (_database, id) => id === user.uuid ? sessionUser : null },
    globals: {
      caches: { default: {
        match: async request => cached.get(request.url)?.clone(),
        put: async (request, response) => {
          cacheWrites.push(request.url);
          cached.set(request.url, response.clone());
        },
      } },
    },
  });
  const { publicRoutes, generateToken } = loader.load('worker/src/routes/public.ts');
  const env = {
    JWT_SECRET: 'synthetic-live-proxy-test-secret-000000000000',
    LIVE_DATA: {
      idFromName: name => { assert.equal(name, 'global'); return name; },
      get: () => ({ fetch: async request => {
        forwarded.push(request);
        return Response.json(snapshot);
      } }),
    },
    RATE_LIMIT: {
      idFromName: name => name,
      get: () => ({ fetch: async () => Response.json({
        allowed, remaining: allowed ? 179 : 0, retry_after: 60,
      }) }),
    },
  };
  return {
    forwarded, cached, cacheWrites,
    async adminCookie() {
      return `cf_monitor_session=${await generateToken(user.uuid, user.username, user.session_version, env)}`;
    },
    async request(query = '', headers = {}) {
      const response = await publicRoutes.fetch(
        new Request(`https://panel.example.test/live${query}`, { headers }),
        env,
        { waitUntil: job => jobs.push(job), passThroughOnException() {} },
      );
      while (jobs.length) await Promise.all(jobs.splice(0));
      return response;
    },
  };
}

function assertSnapshotRequest(request, includeHidden = false) {
  assert.equal(request.url, `https://do/live${includeHidden ? '?include_hidden=1' : ''}`);
  assert.equal(request.method, 'GET');
  assert.equal(request.body, null);
  assert.deepEqual([...request.headers], [], 'no external headers may enter the internal snapshot request');
}

for (const upgrade of ['websocket', 'WebSocket']) {
  test(`CFVM-001: ${upgrade} headers and agent identity cannot cross the public snapshot boundary`, async () => {
    const f = fixture();
    const response = await f.request(
      '?role=agent&id=fixture-node&hidden=1&viewer_ip=synthetic&viewer_ttl_ms=999999&include_hidden=true',
      { Upgrade: upgrade, Connection: 'Upgrade', 'Sec-WebSocket-Protocol': 'synthetic', Authorization: 'Bearer synthetic-agent-token' },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot, 'retain the full snapshot response shape');
    assert.equal(f.forwarded.length, 1);
    assertSnapshotRequest(f.forwarded[0]);
  });
}

for (const cookie of ['', 'cf_monitor_session=invalid-fixture-token']) {
  test(`CFVM-001: ${cookie ? 'invalid' : 'missing'} session cannot forward include_hidden`, async () => {
    const f = fixture();
    const response = await f.request('?include_hidden=1&role=viewer&id=fixture-node', { Cookie: cookie });
    assert.equal(response.status, 200);
    assert.equal(f.forwarded.length, 1);
    assertSnapshotRequest(f.forwarded[0]);
    assert.match(response.headers.get('Cache-Control'), /^public,/);
  });
}

test('CFVM-001: authenticated hidden snapshot remains private and strips all other input', async () => {
  const f = fixture();
  const cookie = await f.adminCookie();
  const response = await f.request('?include_hidden=1&role=agent&id=fixture-node', {
    Cookie: cookie, Upgrade: 'websocket', 'X-Untrusted': 'synthetic',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
  assert.equal(f.forwarded.length, 1);
  assertSnapshotRequest(f.forwarded[0], true);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.ok(!f.cacheWrites.some(url => new URL(url).pathname === '/live'), 'private snapshots must not be stored in the public cache');
});

test('CFVM-001: even an administrator must request the exact include_hidden=1 value', async () => {
  const f = fixture();
  const response = await f.request('?include_hidden=true', { Cookie: await f.adminCookie() });
  assert.equal(response.status, 200);
  assert.equal(f.forwarded.length, 1);
  assertSnapshotRequest(f.forwarded[0]);
  assert.match(response.headers.get('Cache-Control'), /^public,/);
});
test('CFVM-001: a valid signed token for a removed administrator cannot include hidden nodes', async () => {
  const f = fixture({ sessionUser: null });
  const response = await f.request('?include_hidden=1', { Cookie: await f.adminCookie() });
  assert.equal(response.status, 200);
  assert.equal(f.forwarded.length, 1);
  assertSnapshotRequest(f.forwarded[0]);
});

test('CFVM-001: normal public snapshot cache hit avoids another DO request', async () => {
  const f = fixture();
  const first = await f.request();
  assert.deepEqual(await first.json(), snapshot);
  assertSnapshotRequest(f.forwarded[0]);
  const second = await f.request();
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), snapshot);
  assert.equal(second.headers.get('X-CF-VPS-Monitor-Public-Cache'), 'edge-hit');
  assert.equal(f.forwarded.length, 1);
});

test('CFVM-001: public rate limit still rejects before forwarding or reading cached snapshots', async () => {
  const f = fixture({ allowed: false });
  f.cached.set('https://panel.example.test/live', Response.json(snapshot));
  const response = await f.request();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.forwarded.length, 0);
});
