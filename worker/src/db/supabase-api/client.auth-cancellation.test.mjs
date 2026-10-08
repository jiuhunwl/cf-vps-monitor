import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../../test-support/worker-module.mjs';

for (const [getter, rpc] of [
  ['getSupabaseClientIdentityByToken', 'cfm_agent_client_identity_by_token'],
  ['getSupabaseClientByToken', 'cfm_agent_client_by_token'],
]) test(`${rpc}: caller cancellation reaches the actual fetch boundary`, async () => {
  const controller = new AbortController();
  let started;
  const reached = new Promise(resolve => { started = resolve; });
  const loader = createWorkerLoader({ db: null, globals: {
    fetch: async (url, init) => {
      assert.equal(new URL(url).pathname, `/rest/v1/rpc/${rpc}`);
      assert.equal(init.signal, controller.signal);
      started();
      return new Promise((_resolve, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
  } });
  const adapter = loader.load('worker/src/db/supabase-api/client.ts');
  const pending = adapter[getter]({
    SUPABASE_URL: 'https://synthetic-supabase.invalid', SUPABASE_SECRET_KEY: 'sb_secret_synthetic_only',
  }, 'synthetic-agent-token-'.padEnd(64, '0'), controller.signal);
  await reached;
  controller.abort(new Error('synthetic authorization deadline'));
  await assert.rejects(pending, /synthetic authorization deadline/);
});
