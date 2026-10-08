import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./client.ts', import.meta.url), 'utf8');

assert.match(source, /export const AGENT_AUTH_CACHE_MS = 120_000;/);
assert.match(source, /const AGENT_TOKEN_USAGE_CACHE_MS = 15 \* 60_000;/);
assert.match(source, /export function invalidateAgentClientAuthCache/);
assert.match(source, /markAgentTokenUsedIfDue/);
// Cache structure is metadata-only; behavioral authorization regressions live
// in client.http-revocation.test.mjs rather than asserting cached authority.
assert.match(source, /cacheAgentMetadata/);
assert.doesNotMatch(source, /agentIdentityAuthCache|AGENT_AUTH_NEGATIVE_CACHE_MS/);
assert.match(source, /identity\.uuid/);
assert.match(source, /full\.uuid !== identity\.uuid/);
