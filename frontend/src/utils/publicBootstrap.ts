import type { LiveDataResponse } from '../contexts/LiveDataContext';
import { normalizeLiveDataResponse } from './liveDataResponse.ts';
import { normalizePublicClient, normalizePublicClients, sortPublicClients } from './publicClients.ts';
import { normalizePublicSettings, type PublicSettings } from './publicSettings.ts';
import { fetchWithBootstrapRetry } from './api.ts';
import type { ClientInfo } from '../types';
import { getLocalStorageItem, removeLocalStorageItem, setLocalStorageItem } from './browserStorage.ts';

export interface PublicBootstrapPayload {
  settings?: PublicSettings;
  clients?: ClientInfo[];
  nodes?: ClientInfo[];
  live?: LiveDataResponse | null;
  metadata_version?: string;
  snapshot_at?: number;
  server_time?: number;
}

/**
 * 在途的 bootstrap 请求（全局单槽，不再按 include_hidden 分槽）。
 *
 * `/api/public/bootstrap` 已不接受 include_hidden：公开首屏用不到隐藏节点，响应形状必须
 * 与调用方身份无关。以前分槽是因为「已登录」会多要一份带隐藏节点的数据，同一个 URL 两种
 * 形状；现在只有一种形状，一次请求就够。fresh 标记该请求是否以 cacheBust 发起。
 */
let bootstrapInFlight: { promise: Promise<PublicBootstrapPayload>; fresh: boolean } | null = null;
let bootstrapCache: PublicBootstrapPayload | null = null;
let clientPatchCache: PublicBootstrapClientPatch | null = null;
const PUBLIC_BOOTSTRAP_STORAGE_KEY = 'cf_monitor_public_bootstrap';
const PUBLIC_BOOTSTRAP_CLIENT_PATCH_KEY = 'cf_monitor_public_bootstrap_client_patch';
const PUBLIC_BOOTSTRAP_STORAGE_MAX_AGE_MS = 10 * 60_000;
const PUBLIC_BOOTSTRAP_CLIENT_PATCH_MAX_AGE_MS = 10 * 60_000;

type PublicBootstrapClientPatch = {
  version: 2;
  saved_at: number;
  upsert: Array<Partial<ClientInfo> & { uuid: string }>;
  remove: string[];
};

export type PublicBootstrapClientPatchDetail = {
  clients?: {
    upsert?: unknown[];
    remove?: string[];
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * 归一化公开 bootstrap 响应。**没有 includeHidden 参数**：该端点不区分受众，
 * 恒为公开形状，因此归一化也只有一条路径（隐藏节点一律剔除，并叠加本地乐观补丁）。
 */
function normalizePublicBootstrap(payload: unknown): PublicBootstrapPayload {
  const record = asRecord(payload);
  if (!record) throw new Error('Invalid public bootstrap response');
  for (const field of ['clients', 'nodes'] as const) {
    const value = record[field];
    if (value !== undefined && !Array.isArray(value) && !Array.isArray(asRecord(value)?.data)) {
      throw new Error(`Invalid public bootstrap ${field} list`);
    }
  }
  const normalized = {
    settings: record.settings === undefined ? undefined : normalizePublicSettings(record.settings) || undefined,
    clients: record.clients === undefined ? undefined : normalizePublicClients(record.clients),
    nodes: record.nodes === undefined ? undefined : normalizePublicClients(record.nodes),
    live: record.live === undefined ? undefined : normalizeLiveDataResponse(record.live),
    metadata_version: typeof record.metadata_version === 'string' ? record.metadata_version : undefined,
    snapshot_at: typeof record.snapshot_at === 'number' && Number.isFinite(record.snapshot_at) ? record.snapshot_at : undefined,
    server_time: typeof record.server_time === 'number' && Number.isFinite(record.server_time) ? record.server_time : undefined,
  };
  return applyStoredClientPatch(normalized);
}

function readClientPatch(): PublicBootstrapClientPatch | null {
  if (clientPatchCache && Date.now() - clientPatchCache.saved_at <= PUBLIC_BOOTSTRAP_CLIENT_PATCH_MAX_AGE_MS) {
    return clientPatchCache;
  }
  try {
    const raw = getLocalStorageItem(PUBLIC_BOOTSTRAP_CLIENT_PATCH_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<PublicBootstrapClientPatch>;
    if (
      stored.version !== 2 ||
      !stored.saved_at ||
      Date.now() - stored.saved_at > PUBLIC_BOOTSTRAP_CLIENT_PATCH_MAX_AGE_MS
    ) {
      removeLocalStorageItem(PUBLIC_BOOTSTRAP_CLIENT_PATCH_KEY);
      return null;
    }
    clientPatchCache = {
      version: 2,
      saved_at: stored.saved_at,
      upsert: Array.isArray(stored.upsert)
        ? stored.upsert.flatMap((item) => {
            const patch = normalizePublicClientPatch(item);
            return patch ? [patch] : [];
          })
        : [],
      remove: Array.isArray(stored.remove)
        ? stored.remove.filter((uuid): uuid is string => typeof uuid === 'string' && uuid.trim() !== '')
        : [],
    };
    return clientPatchCache;
  } catch {
    return null;
  }
}

function writeClientPatch(patch: PublicBootstrapClientPatch): void {
  clientPatchCache = patch;
  setLocalStorageItem(PUBLIC_BOOTSTRAP_CLIENT_PATCH_KEY, JSON.stringify(patch));
}

export function normalizePublicClientPatch(raw: unknown): (Partial<ClientInfo> & { uuid: string }) | null {
  const record = asRecord(raw);
  const client = normalizePublicClient(record);
  if (!record || !client) return null;
  const patch: Partial<ClientInfo> & { uuid: string } = { uuid: client.uuid };
  for (const key of Object.keys(client) as Array<keyof ClientInfo>) {
    if (key !== 'uuid' && Object.prototype.hasOwnProperty.call(record, key)) {
      (patch as Record<string, unknown>)[key] = client[key];
    }
  }
  return patch;
}

function clientPatchFromDetail(detail?: PublicBootstrapClientPatchDetail): Omit<PublicBootstrapClientPatch, 'version' | 'saved_at'> | null {
  const rawUpserts = Array.isArray(detail?.clients?.upsert) ? detail.clients.upsert : [];
  const remove = new Set(Array.isArray(detail?.clients?.remove) ? detail.clients.remove : []);
  const upsert: Array<Partial<ClientInfo> & { uuid: string }> = [];
  for (const raw of rawUpserts) {
    const record = asRecord(raw);
    const uuid = typeof record?.uuid === 'string' ? record.uuid.trim() : '';
    if (uuid && record?.hidden === true) remove.add(uuid);
    const patch = normalizePublicClientPatch(record);
    if (patch && patch.hidden !== true && !remove.has(patch.uuid)) upsert.push(patch);
  }
  if (upsert.length === 0 && remove.size === 0) return null;
  return { upsert, remove: [...remove] };
}

function mergeClientPatch(next: Omit<PublicBootstrapClientPatch, 'version' | 'saved_at'>): PublicBootstrapClientPatch {
  const previous = readClientPatch();
  const remove = new Set(previous?.remove || []);
  const byUuid = new Map((previous?.upsert || []).map(client => [client.uuid, client]));
  for (const uuid of next.remove) {
    remove.add(uuid);
    byUuid.delete(uuid);
  }
  for (const client of next.upsert) {
    remove.delete(client.uuid);
    byUuid.set(client.uuid, { ...byUuid.get(client.uuid), ...client });
  }
  return { version: 2, saved_at: Date.now(), upsert: [...byUuid.values()], remove: [...remove] };
}

function applyClientPatch(clients: ClientInfo[] | undefined, patch: PublicBootstrapClientPatch | null): ClientInfo[] | undefined {
  if (!clients || !patch) return clients;
  const remove = new Set(patch.remove);
  const byUuid = new Map(
    clients
      .filter(client => !remove.has(client.uuid))
      .map(client => [client.uuid, client]),
  );
  for (const client of patch.upsert) {
    const existing = byUuid.get(client.uuid);
    const next = existing ? { ...existing, ...client } : normalizePublicClient(client);
    if (!next) continue;
    byUuid.set(client.uuid, next);
  }
  return sortPublicClients([...byUuid.values()]);
}

function applyStoredClientPatch(payload: PublicBootstrapPayload): PublicBootstrapPayload {
  const patch = readClientPatch();
  return patch
    ? { ...payload, clients: applyClientPatch(payload.clients, patch), nodes: applyClientPatch(payload.nodes, patch) }
    : payload;
}

function savePublicBootstrap(payload: PublicBootstrapPayload): PublicBootstrapPayload {
  bootstrapCache = payload;
  setLocalStorageItem(PUBLIC_BOOTSTRAP_STORAGE_KEY, JSON.stringify({ saved_at: Date.now(), payload }));
  return payload;
}

export function getCachedPublicBootstrap(): PublicBootstrapPayload | null {
  if (bootstrapCache) return bootstrapCache;
  try {
    const raw = getLocalStorageItem(PUBLIC_BOOTSTRAP_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { saved_at?: number; payload?: unknown };
    if (!stored.saved_at || Date.now() - stored.saved_at > PUBLIC_BOOTSTRAP_STORAGE_MAX_AGE_MS) return null;
    bootstrapCache = normalizePublicBootstrap(stored.payload);
    return bootstrapCache;
  } catch {
    return null;
  }
}

export function clearCachedPublicBootstrap(): void {
  bootstrapCache = null;
  bootstrapInFlight = null;
  removeLocalStorageItem(PUBLIC_BOOTSTRAP_STORAGE_KEY);
  clearClientPatch();
}

function clearClientPatch(): void {
  clientPatchCache = null;
  removeLocalStorageItem(PUBLIC_BOOTSTRAP_CLIENT_PATCH_KEY);
}

export function patchCachedPublicBootstrapClients(detail?: PublicBootstrapClientPatchDetail): void {
  const patch = clientPatchFromDetail(detail);
  if (!patch) return;
  const merged = mergeClientPatch(patch);
  writeClientPatch(merged);
  const cached = getCachedPublicBootstrap();
  if (cached) savePublicBootstrap(applyStoredClientPatch(cached));
}

export async function fetchPublicBootstrap(options: { cache?: RequestCache; cacheBust?: boolean } = {}): Promise<PublicBootstrapPayload> {
  const wantsFresh = Boolean(options.cacheBust);

  // 并发去重：一次 notifyPublicDataUpdated 会同时唤醒多个订阅者
  // （LiveDataContext 与 Index 都会拉 bootstrap），它们应共用同一次网络请求。
  // 要求新鲜数据的调用方只能复用同样以 cacheBust 发起的在途请求，
  // 否则可能拿到走了缓存的旧响应。
  if (bootstrapInFlight && (!wantsFresh || bootstrapInFlight.fresh)) return bootstrapInFlight.promise;

  // Fresh server data supersedes earlier optimistic edits. Edits arriving during
  // this request remain available to bridge a response started before that edit.
  if (wantsFresh) clearClientPatch();

  const url = new URL('/api/public/bootstrap', typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  if (options.cacheBust) url.searchParams.set('_fresh', String(Date.now()));
  // 不再拼 include_hidden：该端点不接受它，公开首屏也不需要隐藏节点。
  const promise: Promise<PublicBootstrapPayload> = fetchWithBootstrapRetry(`${url.pathname}${url.search}`, options.cache ? { cache: options.cache } : undefined)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((payload) => {
      const normalized = normalizePublicBootstrap(payload);
      // 只有仍是最新的在途请求才写入本地缓存，避免被后发起的请求抢先落盘后又被旧响应覆盖。
      return bootstrapInFlight?.promise === promise ? savePublicBootstrap(normalized) : normalized;
    })
    .finally(() => {
      if (bootstrapInFlight?.promise === promise) bootstrapInFlight = null;
    });
  bootstrapInFlight = { promise, fresh: wantsFresh };
  return promise;
}
