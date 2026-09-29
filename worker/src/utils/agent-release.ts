/**
 * 解析 GitHub releases/latest 到具体 tag（供面板显示与升级命令固化）。
 *
 * 为什么不节点侧解析：节点侧若要知道"latest 具体是哪个 tag"，必须下载二进制才能
 * 从内容里读到版本号——这与「零副作用」（P0-9）冲突。所以由 Worker 侧用轻量
 * HEAD 请求跟随跳转读 Location，不落盘。
 *
 * 为什么带缓存：路由会在面板刷新时被频繁调用；GitHub releases/latest 不会秒级变化，
 * 缓存 10 分钟足够。缓存仅存内存（无 DO 持久化），实例重启即失效。
 */
import { CF_MONITOR_REPOSITORY } from './project-repository.ts';
import { scheduledFetch } from './scheduled-budget.ts';

export interface AgentReleaseInfo {
  latest_version: string | null;
  published_at: string | null;
}

interface CachedRelease {
  expiresAt: number;
  value: AgentReleaseInfo;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CachedRelease>();

/** 仓库标识，支持 CF_MONITOR_RELEASE_REPOSITORY 覆盖（fork 场景）。*/
export function resolveReleaseRepository(env: { CF_MONITOR_RELEASE_REPOSITORY?: string }): string {
  const override = (env.CF_MONITOR_RELEASE_REPOSITORY || '').trim();
  return override || CF_MONITOR_REPOSITORY;
}

function parseTagFromLocation(location: string | null): string | null {
  if (!location) return null;
  // releases/latest 跳转到 /releases/tag/<tag>，取最后一段并 decode
  const match = location.match(/\/releases\/tag\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** 拉 GitHub releases/latest，跟随跳转读出具体 tag。失败返回 {latest_version: null}。*/
export async function fetchLatestAgentRelease(
  env: { CF_MONITOR_RELEASE_REPOSITORY?: string },
  nowMs: number,
  forceRefresh = false,
): Promise<AgentReleaseInfo & { cached?: boolean }> {
  const repository = resolveReleaseRepository(env);
  const cacheKey = repository;
  const cached = cache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > nowMs) {
    return { ...cached.value, cached: true };
  }

  const url = `https://github.com/${repository}/releases/latest`;
  try {
    // scheduledFetch 已用 redirect:'manual'，这里我们需要真正跟随一次跳转拿到 Location
    const response = await scheduledFetch(url, { method: 'GET', redirect: 'manual' });
    // releases/latest 在 GitHub 上会返回 302 Location: /releases/tag/<tag>
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      const tag = parseTagFromLocation(location);
      if (tag) {
        const value: AgentReleaseInfo = {
          latest_version: tag,
          published_at: response.headers.get('published_at'),
        };
        cache.set(cacheKey, { expiresAt: nowMs + CACHE_TTL_MS, value });
        return { ...value, cached: false };
      }
    }
    // 某些情况下 GitHub 可能直接返回 200（已被前端代理改造）；尝试从最终 URL 读 tag
    const finalUrl = response.url || url;
    const tag = parseTagFromLocation(finalUrl);
    if (tag) {
      const value: AgentReleaseInfo = { latest_version: tag, published_at: null };
      cache.set(cacheKey, { expiresAt: nowMs + CACHE_TTL_MS, value });
      return { ...value, cached: false };
    }
    // 解析失败：若有过期缓存，降级返回它（比 null 强）；否则返回 null
    if (cached) return { ...cached.value, cached: true };
    return { latest_version: null, published_at: null };
  } catch {
    if (cached) return { ...cached.value, cached: true };
    return { latest_version: null, published_at: null };
  }
}

/** 仅供测试：清空缓存。*/
export function __clearAgentReleaseCacheForTests(): void {
  cache.clear();
}
