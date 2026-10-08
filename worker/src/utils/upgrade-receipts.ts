import * as db from '../db/queries';
import { isJsonObject, type JsonObject } from './report-envelope';

export const MAX_UPGRADE_RECEIPTS = 16;
const MAX_RAW_RECEIPTS = 64;
const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['success', 'already_latest', 'rolled_back', 'failed']);

function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' && value.length <= max ? value : null;
}
function timestamp(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function parseReceipt(value: unknown, reportVersion: unknown): db.AgentUpgradeResult | null {
  if (!isJsonObject(value) || typeof value.command_id !== 'string' || !COMMAND_ID.test(value.command_id)
    || typeof value.status !== 'string' || !STATUSES.has(value.status)) return null;
  const target = text(value.target_version, 128), from = text(value.from_version, 128);
  const final = text(value.final_version, 128), fallback = text(reportVersion, 128);
  const failure = text(value.failure_code, 64), reason = text(value.reason, 4096);
  const started = timestamp(value.started_at), finished = timestamp(value.finished_at);
  if ([target, from, final, fallback, failure, reason, started, finished].some(item => item === null)) return null;
  return { command_id: value.command_id, status: value.status as db.AgentUpgradeResult['status'],
    target_version: target!, from_version: from!, final_version: final || fallback || '',
    failure_code: failure || undefined, reason: reason || undefined, started_at: started!, finished_at: finished! };
}

/** Optional receipts never masquerade as durable telemetry or authenticate a node. */
export function collectUpgradeReceipts(reports: readonly unknown[], envelope?: unknown): db.AgentUpgradeResult[] {
  const versionOf = (value: unknown): unknown => isJsonObject(value)
    ? value.version ?? (isJsonObject(value.data) ? value.data.version : undefined) : undefined;
  const envelopeVersion = versionOf(envelope) ?? versionOf(reports.at(-1));
  const sources = new Set<JsonObject>();
  const add = (source: unknown) => {
    if (!isJsonObject(source)) return;
    sources.add(source);
    if (source.type === 'report' && isJsonObject(source.data)) sources.add(source.data);
  };
  add(envelope);
  for (const report of reports) add(report);
  const receipts = new Map<string, db.AgentUpgradeResult>();
  const conflicting = new Set<string>();
  let count = 0;
  for (const source of sources) {
    if (!Array.isArray(source.upgrade_results)) continue;
    count += source.upgrade_results.length;
    if (count > MAX_RAW_RECEIPTS) return [];
    const version = versionOf(source) ?? envelopeVersion;
    for (const raw of source.upgrade_results) {
      const result = parseReceipt(raw, version);
      if (!result || conflicting.has(result.command_id)) continue;
      const previous = receipts.get(result.command_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(result)) {
        receipts.delete(result.command_id);
        conflicting.add(result.command_id);
      } else receipts.set(result.command_id, result);
    }
  }
  // No truncated prefix is claimed accepted when an envelope exceeds the contract.
  return receipts.size <= MAX_UPGRADE_RECEIPTS ? [...receipts.values()] : [];
}

/** Return only confirmations actually received from the database. No blanket ACK. */
export async function persistUpgradeReceipts(database: db.QueryDatabase, clientUuid: string,
  receipts: readonly db.AgentUpgradeResult[]): Promise<string[]> {
  if (receipts.length === 0 || receipts.length > MAX_UPGRADE_RECEIPTS) return [];
  const accepted: string[] = [];
  const signal = AbortSignal.timeout(10_000);
  const reportedAt = new Date().toISOString();
  for (const receipt of receipts) {
    if (signal.aborted) break;
    try {
      const outcome = await db.recordAgentUpgradeResult(database, {
        ...receipt, client_uuid: clientUuid, reported_at: reportedAt,
      }, signal);
      signal.throwIfAborted();
      if (outcome?.ok === true) accepted.push(receipt.command_id);
    } catch {
      // An unconfirmed write is replayable; do not suppress otherwise accepted telemetry.
    }
  }
  return accepted;
}
