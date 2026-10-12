import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = dirname(dirname(modulePath));
const commitPattern = /^[a-f0-9]{40}$/i;
const pendingStatuses = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
const conclusions = new Set(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', 'stale', 'startup_failure']);

class GithubCiGateError extends Error {
  constructor(code, message) {
    super(`GitHub CI gate: ${message}`);
    this.name = 'GithubCiGateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GithubCiGateError(code, message);
}

function repositoryFromRemote(raw) {
  let path;
  const ssh = /^git@github\.com:([^\s?#]+)$/i.exec(raw);
  if (ssh) {
    path = ssh[1];
  } else {
    let url;
    try { url = new URL(raw); } catch { fail('INVALID_REMOTE', 'origin must be a GitHub HTTPS or SSH remote.'); }
    const https = url.protocol === 'https:' && !url.port;
    const sshUrl = url.protocol === 'ssh:' && url.username === 'git' && !url.password && (!url.port || url.port === '22');
    if (url.hostname !== 'github.com' || (!https && !sshUrl) || url.search || url.hash) {
      fail('INVALID_REMOTE', 'origin must be a GitHub HTTPS or SSH remote.');
    }
    path = url.pathname.slice(1);
  }
  const parts = path.replace(/\/$/, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(parts[0])
      || !/^[a-z0-9_.-]{1,100}$/i.test(parts[1]) || parts[1] === '.' || parts[1] === '..') {
    fail('INVALID_REMOTE', 'origin does not identify one GitHub repository.');
  }
  return parts.join('/').toLowerCase();
}

function latestWorkflowRun(payload, sha, repository) {
  if (!payload || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0
      || !Array.isArray(payload.workflow_runs) || payload.workflow_runs.length > 100
      || payload.workflow_runs.length !== Math.min(payload.total_count, 100)) {
    fail('INVALID_RESPONSE', 'GitHub returned an invalid workflow-run list.');
  }
  let latest;
  const identities = new Set();
  for (const run of payload.workflow_runs) {
    if (!run || !Number.isSafeInteger(run.id) || run.id <= 0
        || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0
        || typeof run.head_sha !== 'string' || !commitPattern.test(run.head_sha)
        || typeof run.head_repository?.full_name !== 'string'
        || typeof run.event !== 'string' || typeof run.path !== 'string') {
      fail('INVALID_RESPONSE', 'GitHub returned invalid workflow-run identity fields.');
    }
    if (run.head_sha !== sha || run.head_repository.full_name.toLowerCase() !== repository
        || run.event !== 'push' || run.path !== '.github/workflows/ci.yml') {
      fail('RUN_MISMATCH', 'GitHub returned a run for a different commit, repository, event, or workflow.');
    }
    if (run.status === 'completed' ? !conclusions.has(run.conclusion)
      : !pendingStatuses.has(run.status) || run.conclusion !== null) {
      fail('INVALID_RESPONSE', 'GitHub returned an invalid workflow-run status.');
    }
    const identity = `${run.id}:${run.run_attempt}`;
    if (identities.has(identity)) fail('INVALID_RESPONSE', 'GitHub returned duplicate workflow-run attempts.');
    identities.add(identity);
    if (!latest || run.id > latest.id || (run.id === latest.id && run.run_attempt > latest.run_attempt)) latest = run;
  }
  return latest;
}

/** Redact an authentication secret from any diagnostic text before it is logged or thrown. */
function redactSecret(text, secret) {
  if (typeof text !== 'string' || text === '' || typeof secret !== 'string' || secret === '') return text;
  return text.split(secret).join('***');
}

/** Collapse control characters so a remote API message cannot inject lines into build logs. */
function sanitizeMessage(value) {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 297)}...` : collapsed;
}

function readHeader(response, name) {
  try {
    const value = response?.headers?.get?.(name);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  } catch { return null; }
}

function parseIntegerHeader(value) {
  if (value === null || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parse Retry-After (delay-seconds or HTTP-date) into a millisecond wait. */
function parseRetryAfterMs(value, nowMs) {
  if (value === null) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }
  const target = Date.parse(value);
  return Number.isNaN(target) ? null : Math.max(0, target - nowMs);
}

/** Read the JSON `message` from a failed response without ever echoing the token. */
async function readResponseMessage(response, secret) {
  if (!response || typeof response.json !== 'function') return '';
  try {
    const payload = await response.json();
    const message = typeof payload === 'string' ? payload : payload?.message;
    return redactSecret(sanitizeMessage(message), secret);
  } catch { return ''; }
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
}

/**
 * Turn a non-200 GitHub response into an actionable, secret-free diagnosis and
 * decide whether the request was throttled (worth waiting for) or refused.
 */
async function diagnoseHttpFailure(response, { secret, tokenPresent, nowMs }) {
  const message = await readResponseMessage(response, secret);
  const remaining = parseIntegerHeader(readHeader(response, 'x-ratelimit-remaining'));
  const limit = parseIntegerHeader(readHeader(response, 'x-ratelimit-limit'));
  const resetSeconds = parseIntegerHeader(readHeader(response, 'x-ratelimit-reset'));
  const resetAtMs = resetSeconds === null ? null : resetSeconds * 1000;
  const retryAfterMs = parseRetryAfterMs(readHeader(response, 'retry-after'), nowMs);
  const scopes = redactSecret(readHeader(response, 'x-accepted-oauth-scopes'), secret);
  const mentionsRateLimit = /rate limit|secondary rate/i.test(message);
  const rateLimited = response.status === 429 || remaining === 0 || retryAfterMs !== null || mentionsRateLimit;

  const authLabel = tokenPresent ? 'authenticated' : 'unauthenticated';
  const quota = remaining === null ? '' : `; ${limit === null ? remaining : `${remaining}/${limit}`} requests remaining`;
  const resetLabel = resetAtMs === null ? '' : `; resets in ${formatDuration(Math.max(0, resetAtMs - nowMs))}`;
  const retryLabel = retryAfterMs === null ? '' : `; retry after ${formatDuration(retryAfterMs)}`;
  const scopeLabel = scopes === null ? '' : `; accepted scope${scopes === '' ? 's' : ''}: ${scopes || '(none)'}`;
  const summary = `${message || 'the API rejected the request'} (${authLabel}${quota}${resetLabel}${retryLabel}${scopeLabel})`;

  let waitMs = null;
  if (retryAfterMs !== null) waitMs = retryAfterMs;
  else if (resetAtMs !== null) waitMs = Math.max(0, resetAtMs - nowMs);

  return { rateLimited, waitMs, summary, scopes };
}

/** Hints naming the most likely cause of a refused (non-throttled) request. */
function permissionHints(tokenPresent, scopes) {
  const hints = [];
  if (tokenPresent) {
    hints.push('the configured GITHUB_TOKEN was rejected; confirm it is valid, not expired, and granted the "Actions: read" permission');
  } else {
    hints.push('no GITHUB_TOKEN was provided (未配置 GITHUB_TOKEN); set a token with the "Actions: read" permission to authenticate the request');
  }
  if (scopes) hints.push(`GitHub expects one of these scopes: ${scopes}`);
  return `Hints: ${hints.join('; ')}.`;
}

function rateLimitTokenHint(tokenPresent) {
  return tokenPresent ? '' : ' Configure a GITHUB_TOKEN with "Actions: read" to raise the shared API limit from 60/h to 5000/h.';
}

/** Wait for the latest push CI run for this clean checkout; never build or deploy. */
export async function runGithubCiGate({
  root = defaultRoot,
  env = process.env,
  run = spawnSync,
  fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  now = Date.now,
  log = console.log,
  timeoutMs = 12 * 60_000,
  pollMs = 30_000,
} = {}) {
  try {
    if (typeof root !== 'string' || !root || !env || typeof env !== 'object'
        || ![run, fetchImpl, sleep, now, log].every(fn => typeof fn === 'function')
        || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
        || !Number.isSafeInteger(pollMs) || pollMs <= 0) {
      fail('INVALID_OPTIONS', 'invalid checkout, I/O, or wait configuration.');
    }
    const startedAt = now();
    if (!Number.isFinite(startedAt)) fail('INVALID_OPTIONS', 'the wait clock is unavailable.');
    const deadline = startedAt + timeoutMs;
    const git = args => {
      let result;
      try {
        result = run('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe', shell: false,
          windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
      } catch { fail('GIT_CHECK_FAILED', 'could not inspect the current Git checkout.'); }
      if (args[0] === 'diff' && result?.status === 1) {
        fail('DIRTY_WORKTREE', 'tracked files or the index differ from HEAD; deployment stopped.');
      }
      if (!result || result.status !== 0 || result.error) fail('GIT_CHECK_FAILED', 'could not inspect the current Git checkout.');
      return typeof result.stdout === 'string' ? result.stdout.trim() : '';
    };
    const readCommit = () => {
      const value = git(['rev-parse', 'HEAD']);
      if (!commitPattern.test(value)) fail('INVALID_COMMIT', 'Git HEAD must be a full 40-character commit SHA.');
      return value.toLowerCase();
    };
    const sha = readCommit();
    if (env.WORKERS_CI_COMMIT_SHA !== undefined
        && (typeof env.WORKERS_CI_COMMIT_SHA !== 'string'
          || !commitPattern.test(env.WORKERS_CI_COMMIT_SHA.trim())
          || env.WORKERS_CI_COMMIT_SHA.trim().toLowerCase() !== sha)) {
      fail('COMMIT_MISMATCH', 'the Workers build commit differs from Git HEAD.');
    }
    const repository = repositoryFromRemote(git(['remote', 'get-url', 'origin']));
    git(['diff', '--quiet', 'HEAD', '--']);

    const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs`);
    url.search = new URLSearchParams({ head_sha: sha, event: 'push', per_page: '100' }).toString();
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cf-vps-monitor-ci-gate' };
    const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    let previousState;
    let newestObserved;
    while (true) {
      const remaining = deadline - now();
      if (!Number.isFinite(remaining) || remaining <= 0) fail('WAIT_TIMEOUT', 'timed out waiting for successful CI; deployment stopped.');
      const signal = AbortSignal.timeout(Math.max(1, Math.min(15_000, Math.floor(remaining))));
      let response;
      try {
        response = await fetchImpl(url.href, { method: 'GET', headers, signal, redirect: 'error', cache: 'no-store' });
      } catch { fail('NETWORK_ERROR', 'the GitHub request failed or timed out; deployment stopped.'); }
      if (!Number.isInteger(response?.status)) fail('INVALID_RESPONSE', 'GitHub returned an invalid HTTP response.');
      if (response.status !== 200) {
        const failure = await diagnoseHttpFailure(response, { secret: token, tokenPresent: Boolean(token), nowMs: now() });
        if (failure.rateLimited) {
          // Throttled: GitHub is reachable, so wait for the reset inside the
          // existing deadline and retry instead of aborting the deployment.
          const budget = deadline - now();
          const requested = failure.waitMs;
          const waitMs = requested !== null && requested > 0
            ? requested
            : Math.min(pollMs, Math.max(1, Math.floor(budget)));
          if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs >= budget) {
            fail('RATE_LIMITED', `GitHub throttled the request (HTTP ${response.status}): ${failure.summary}. `
              + `The limit will not reset within the remaining deployment window (${formatDuration(Math.max(0, budget))} left`
              + `${requested !== null && requested > 0 ? `, reset expected in ${formatDuration(requested)}` : ''}); deployment stopped.`
              + rateLimitTokenHint(Boolean(token)));
          }
          log(`GitHub throttled the request (HTTP ${response.status}): ${failure.summary}. Waiting ${formatDuration(waitMs)} before retrying.`);
          await sleep(waitMs);
          continue;
        }
        // Refused: authentication or permission problem that waiting cannot fix.
        fail('HTTP_ERROR', `GitHub returned HTTP ${response.status}: ${failure.summary}. ${permissionHints(Boolean(token), failure.scopes)}`);
      }
      let payload;
      try { payload = await response.json(); } catch {
        if (signal.aborted) fail('NETWORK_ERROR', 'the GitHub response timed out; deployment stopped.');
        fail('INVALID_RESPONSE', 'GitHub returned an unreadable response; deployment stopped.');
      }
      if (now() >= deadline) fail('WAIT_TIMEOUT', 'timed out waiting for successful CI; deployment stopped.');
      const latest = latestWorkflowRun(payload, sha, repository);
      // API snapshots can lag behind an earlier poll. Once a rerun is seen,
      // an older success must never regain permission to publish this checkout.
      if (latest && newestObserved && (latest.id < newestObserved.id
          || (latest.id === newestObserved.id && latest.run_attempt < newestObserved.run_attempt))) {
        fail('STALE_RESPONSE', 'GitHub returned an older CI run or attempt than previously observed; deployment stopped.');
      }
      if (latest) newestObserved = latest;
      if (latest?.status === 'completed') {
        if (latest.conclusion !== 'success') {
          fail('CI_NOT_SUCCESSFUL', `latest CI run ${latest.id} attempt ${latest.run_attempt} completed with ${latest.conclusion}; deployment stopped.`);
        }
        if (readCommit() !== sha) fail('COMMIT_MISMATCH', 'Git HEAD changed while waiting for CI; deployment stopped.');
        git(['diff', '--quiet', 'HEAD', '--']);
        const completedAt = now();
        if (!Number.isFinite(completedAt) || completedAt >= deadline) {
          fail('WAIT_TIMEOUT', 'timed out while confirming the tested checkout; deployment stopped.');
        }
        log(`GitHub CI passed for ${sha.slice(0, 7)} (run ${latest.id}, attempt ${latest.run_attempt}).`);
        return { sha, repository, runId: latest.id, runAttempt: latest.run_attempt };
      }
      const state = latest ? `${latest.id}:${latest.run_attempt}:${latest.status}` : 'missing';
      if (state !== previousState) {
        log(latest
          ? `Waiting for GitHub CI ${sha.slice(0, 7)}: run ${latest.id}, attempt ${latest.run_attempt}, ${latest.status}.`
          : `Waiting for the GitHub push CI run for ${sha.slice(0, 7)} to appear.`);
        previousState = state;
      }
      const delay = Math.min(pollMs, deadline - now());
      if (delay > 0) await sleep(delay);
    }
  } catch (error) {
    if (error instanceof GithubCiGateError) throw error;
    fail('INTERNAL_ERROR', 'an unexpected check failed; deployment stopped.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  try { await runGithubCiGate(); } catch (error) {
    console.error(error instanceof GithubCiGateError ? error.message : 'GitHub CI gate failed; deployment stopped.');
    process.exitCode = 1;
  }
}
