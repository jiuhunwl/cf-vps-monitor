import type { PublicClientRow } from '../db/types';
import { isPublicIpAddress } from './request-ip.ts';

export type PublicClient = Omit<PublicClientRow, 'ipv4' | 'ipv6'> & {
  has_ipv4: boolean;
  has_ipv6: boolean;
  tags: string;
};

type PublicClientSource = Omit<PublicClientRow, 'ipv4' | 'ipv6'> & {
  token?: unknown;
  remark?: unknown;
  // 数据库层的 cfm_public_clients 已不再下发原始 ipv4/ipv6，只下发预计算的
  // has_ipv4/has_ipv6，因此这里的原始字段是可缺席的。旧库仍会下发它们。
  ipv4?: unknown;
  ipv6?: unknown;
  has_ipv4?: unknown;
  has_ipv6?: unknown;
};

export const PUBLIC_CLIENT_FIELDS = [
  'uuid', 'name', 'cpu_name', 'virtualization', 'arch', 'cpu_cores', 'os',
  'kernel_version', 'gpu_name', 'region', 'public_remark', 'mem_total', 'swap_total',
  'disk_total', 'version', 'price', 'billing_cycle', 'auto_renewal', 'currency',
  'expired_at', 'group', 'tags', 'hidden', 'traffic_limit', 'traffic_limit_type',
  'traffic_reset_day', 'sort_order', 'created_at', 'updated_at',
] as const;

function pickFields<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    // Patches omit missing fields; explicit zero/empty/null values remain meaningful.
    if (Object.hasOwn(source, key) && source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function isPublicTag(tag: string): boolean {
  const text = tag.replace(/<\w+>$/, '').trim().toLowerCase();
  return !['ipv4', 'ipv6', 'ip4', 'ip6', 'v4', 'v6'].includes(text);
}

export function sanitizePublicTags(tags: unknown): string {
  if (typeof tags !== 'string') return '';
  return tags
    .split(/[;,]/)
    .map(tag => tag.trim())
    .filter(Boolean)
    .filter(isPublicTag)
    .join(';');
}

/**
 * 解析「是否存在公网 IP」标记。
 *
 * 两条来源必须都支持，否则会静默退化成一律 false：
 *  - 旧库：下发原始 ipv4/ipv6，由 Worker 现场判定（不能信任库里的值，只认自己算的）
 *  - 新库：已在下发前剥离原始 IP，只保留预计算的布尔值
 * 原始字段一旦存在就以现算结果为准，避免上游塞入伪造的标记。
 */
function resolveIpPresence(rawIp: unknown, precomputed: unknown): boolean {
  if (typeof rawIp === 'string') return isPublicIpAddress(rawIp);
  return precomputed === true;
}

export function toPublicClient(client: PublicClientSource): PublicClient {
  const { ipv4, ipv6 } = client;
  const publicClient = pickFields(client, PUBLIC_CLIENT_FIELDS);
  return {
    ...publicClient,
    has_ipv4: resolveIpPresence(ipv4, client.has_ipv4),
    has_ipv6: resolveIpPresence(ipv6, client.has_ipv6),
    tags: sanitizePublicTags(publicClient.tags),
  };
}
