export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function unwrapMonitorReportEnvelope(report: JsonObject): JsonObject {
  return report.type === 'report' && isJsonObject(report.data)
    ? report.data
    : report;
}

// A successful ACK must never silently accept only a filtered/truncated prefix.
export function isReportBatch(value: unknown, max: number): value is JsonObject[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return false;
  for (const item of value) if (!isJsonObject(item)) return false;
  return true;
}
