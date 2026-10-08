package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

const maxReportWireBytes = 512 * 1024
const targetReportBatchBytes = 480 * 1024

type reportTransport uint8

const (
	reportHTTP reportTransport = iota
	reportWebSocket
)

type preparedReportBatch struct {
	transport reportTransport
	reports   []Report
	body      []byte
}
type reportWireSizeError struct{ bytes int }

func (e *reportWireSizeError) Error() string {
	return fmt.Sprintf("single report requires %d bytes; wire limit is %d (configuration or report splitting required)", e.bytes, maxReportWireBytes)
}

func freezeReportPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func freezeWireReport(report Report, upgrades []upgradeResult) Report {
	report.Load = freezeReportPointer(report.Load)
	report.Temp = freezeReportPointer(report.Temp)
	report.Disk = freezeReportPointer(report.Disk)
	report.DiskTotal = freezeReportPointer(report.DiskTotal)
	report.Uptime = freezeReportPointer(report.Uptime)
	report.BasicInfo = freezeReportPointer(report.BasicInfo)
	if report.BasicInfo == nil {
		report.basicInfoOwner = nil
		report.basicInfoRevision = 0
	}
	report.GPUs = append([]GPUInfo(nil), report.GPUs...)
	report.PingResults = append([]PingResult(nil), report.PingResults...)
	report.WebsiteProbeResults = append([]WebsiteProbeResult(nil), report.WebsiteProbeResults...)
	for i := range report.WebsiteProbeResults {
		item := &report.WebsiteProbeResults[i]
		item.StatusCode = freezeReportPointer(item.StatusCode)
		item.RawStatusCode = freezeReportPointer(item.RawStatusCode)
		item.Error = freezeReportPointer(item.Error)
	}
	// Only serialized probe results own ACK leases; do not retain stale map-only entries.
	pingLeases := report.pingResultLeases
	report.pingResultLeases = nil
	for _, item := range report.PingResults {
		if sequence, ok := pingLeases[item.TaskID]; ok {
			if report.pingResultLeases == nil {
				report.pingResultLeases = make(map[int]uint64)
			}
			report.pingResultLeases[item.TaskID] = sequence
		}
	}
	websiteLeases := report.websiteResultLeases
	report.websiteResultLeases = nil
	for _, item := range report.WebsiteProbeResults {
		if sequence, ok := websiteLeases[item.MonitorID]; ok {
			if report.websiteResultLeases == nil {
				report.websiteResultLeases = make(map[int]uint64)
			}
			report.websiteResultLeases[item.MonitorID] = sequence
		}
	}
	// The upgrade outbox owns unconfirmed results. Retry-carried copies may
	// already have been acknowledged; rebuild this field from one frozen snapshot.
	report.UpgradeResults = append([]upgradeResult(nil), upgrades...)
	return report
}
func reportFraming(transport reportTransport, count int) (string, string) {
	if transport == reportHTTP {
		if count == 1 {
			return "", ""
		}
		return `{"reports":[`, `]}`
	}
	if count == 1 {
		return `{"type":"report","data":`, `}`
	}
	return `{"type":"reports","reports":[`, `]}`
}

// Callers filter obsolete leases/revisions before preparation. Each candidate is
// marshaled once; only a consecutive prefix is selected. Send body verbatim.
func prepareReportBatch(reports []Report, transport reportTransport, upgrades []upgradeResult) (preparedReportBatch, error) {
	batch := preparedReportBatch{transport: transport}
	if transport != reportHTTP && transport != reportWebSocket {
		return batch, errors.New("unknown report transport")
	}
	if len(upgrades) > maxUpgradeResultsPerEnvelope {
		return batch, errors.New("too many upgrade receipts in one snapshot")
	}
	var fragments [][]byte
	total := 0
	for i := 0; i < len(reports) && i < maxReportsPerEnvelope; i++ {
		var receiptSnapshot []upgradeResult
		if i == 0 {
			receiptSnapshot = upgrades
		}
		candidate := freezeWireReport(reports[i], receiptSnapshot)
		encoded, err := json.Marshal(candidate)
		if err != nil {
			if len(batch.reports) == 0 {
				return batch, fmt.Errorf("encode report: %w", err)
			}
			break
		}
		count := len(batch.reports) + 1
		prefix, suffix := reportFraming(transport, count)
		limit := targetReportBatchBytes
		if count == 1 {
			limit = maxReportWireBytes
		}
		if len(encoded) > maxReportWireBytes || total+len(encoded)+(count-1)+len(prefix)+len(suffix) > limit {
			if count == 1 {
				return batch, &reportWireSizeError{bytes: len(encoded) + len(prefix) + len(suffix)}
			}
			break
		}
		total += len(encoded)
		batch.reports = append(batch.reports, candidate)
		fragments = append(fragments, encoded)
	}
	if len(batch.reports) == 0 {
		return batch, nil
	}
	prefix, suffix := reportFraming(transport, len(batch.reports))
	var body bytes.Buffer
	body.Grow(total + len(batch.reports) - 1 + len(prefix) + len(suffix))
	body.WriteString(prefix)
	for i, fragment := range fragments {
		if i > 0 {
			body.WriteByte(',')
		}
		body.Write(fragment)
	}
	body.WriteString(suffix)
	batch.body = body.Bytes()
	return batch, nil
}
func (batch preparedReportBatch) validate(transport reportTransport) error {
	if batch.transport != transport || len(batch.reports) == 0 || len(batch.reports) > maxReportsPerEnvelope || len(batch.body) == 0 || len(batch.body) > maxReportWireBytes {
		return errors.New("invalid prepared report batch")
	}
	return nil
}
