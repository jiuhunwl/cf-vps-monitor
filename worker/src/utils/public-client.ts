import type { PublicClientRow } from '../db/types';
import { isPublicIpAddress } from './request-ip.ts';

export type PublicClient = Omit<PublicClientRow, 'ipv4' | 'ipv6'> & {
  has_ipv4: boolean;
  has_ipv6: boolean;
  tags: string;
};

type PublicClientSource = PublicClientRow & {
  token?: unknown;
  token_hash?: unknown;
  token_last_used_at?: unknown;
  token_last_used_ip?: unknown;
  token_rotated_at?: unknown;
  remark?: unknown;
};

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

export function toPublicClient(client: PublicClientSource): PublicClient {
  const {
    token: _token,
    token_hash: _tokenHash,
    token_last_used_at: _tokenLastUsedAt,
    token_last_used_ip: _tokenLastUsedIp,
    token_rotated_at: _tokenRotatedAt,
    ipv4,
    ipv6,
    remark: _remark,
    ...publicClient
  } = client;
  return {
    ...publicClient,
    has_ipv4: typeof ipv4 === 'string' && isPublicIpAddress(ipv4),
    has_ipv6: typeof ipv6 === 'string' && isPublicIpAddress(ipv6),
    tags: sanitizePublicTags(publicClient.tags),
  };
}
