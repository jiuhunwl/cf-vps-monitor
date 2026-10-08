import assert from 'node:assert/strict';

const { unwrapMonitorReportEnvelope } = await import('../utils/report-envelope.ts');

const report = {
  timestamp: 12345,
  ping_results: [{ task_id: 1, value: 32 }],
  website_probe_results: [{ monitor_id: 2, ok: true, latency_ms: 88, effective_status: 'up' }],
  basic_info: { os: 'linux', version: '2.0.0' },
};

assert.equal(unwrapMonitorReportEnvelope(report), report);
assert.deepEqual(
  unwrapMonitorReportEnvelope({ type: 'report', data: report }),
  report,
);
assert.equal(
  unwrapMonitorReportEnvelope({ type: 'report', data: report }).basic_info,
  report.basic_info,
);
assert.deepEqual(
  unwrapMonitorReportEnvelope({ type: 'report', data: null, ping_results: [] }),
  { type: 'report', data: null, ping_results: [] },
);


const { isReportBatch } = await import('../utils/report-envelope.ts');
assert.equal(isReportBatch([report], 300), true);
assert.equal(isReportBatch(Array.from({ length: 300 }, () => report), 300), true);
for (const invalid of [[], null, new Array(2), [report, null], Array.from({ length: 301 }, () => report)]) {
  assert.equal(isReportBatch(invalid, 300), false);
}
