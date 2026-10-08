import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

for (const reports of [[], Array.from({ length: 301 }, () => ({ cpu: 1 })), [{ cpu: 1 }, null]]) {
  test(`HTTP report rejects invalid batch (${reports.length}) without forwarding a prefix`, async () => {
    const row = { uuid: 'batch-node', token: 'a'.repeat(64), name: 'Batch node', hidden: false };
    let forwarded = 0;
    const jobs = [];
    const { clientRoutes } = createWorkerLoader({ db: {
      getClientByToken: async () => row, getClientIdentityByToken: async () => row,
      markClientTokenUsed: async () => false, insertAuditLog: async () => {},
    } }).load('worker/src/routes/client.ts');
    const env = { LIVE_DATA: { idFromName: id => id, get: () => ({ fetch: async request => {
      if (new URL(request.url).pathname === '/client-report') forwarded++;
      return Response.json({ success: true, persisted: false, queued: true });
    } }) } };
    const response = await clientRoutes.fetch(new Request('https://panel.example.test/report', {
      method: 'POST', headers: { Authorization: `Bearer ${row.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reports }),
    }), env, { waitUntil: task => jobs.push(task) });
    assert.equal(response.status, 400);
    assert.equal(forwarded, 0);
    await Promise.all(jobs);
  });
}
