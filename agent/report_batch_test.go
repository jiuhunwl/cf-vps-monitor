package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestReportBatchUsesEncodedBytesAndTransportEnvelope(t *testing.T) {
	for _, transport := range []reportTransport{reportHTTP, reportWebSocket} {
		reports := make([]Report, 30)
		for i := range reports {
			reports[i] = Report{CPU: float64(i), Name: strings.Repeat("<&界", 8000), Timestamp: int64(i + 1)}
		}
		batch, err := prepareReportBatch(reports, transport, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(batch.reports) == 0 || len(batch.reports) >= len(reports) || len(batch.body) > maxReportWireBytes {
			t.Fatalf("bad batch: reports=%d bytes=%d", len(batch.reports), len(batch.body))
		}
		var expected []byte
		if transport == reportWebSocket {
			if len(batch.reports) == 1 {
				expected, err = json.Marshal(reportEnvelope{Type: "report", Data: batch.reports[0]})
			} else {
				expected, err = json.Marshal(reportsEnvelope{Type: "reports", Reports: batch.reports})
			}
		} else if len(batch.reports) == 1 {
			expected, err = json.Marshal(batch.reports[0])
		} else {
			expected, err = json.Marshal(map[string]any{"reports": batch.reports})
		}
		if err != nil || !bytes.Equal(expected, batch.body) {
			t.Fatalf("wire envelope differs: %v", err)
		}
		for i, r := range batch.reports {
			if r.Timestamp != reports[i].Timestamp {
				t.Fatal("sample reordered or timestamp changed")
			}
		}
	}
}
func TestReportBatchPreservesCountCeilingAndRejectsIndivisibleOversize(t *testing.T) {
	reports := make([]Report, maxReportsPerEnvelope+2)
	batch, err := prepareReportBatch(reports, reportHTTP, nil)
	if err != nil || len(batch.reports) != maxReportsPerEnvelope {
		t.Fatalf("count ceiling: %d %v", len(batch.reports), err)
	}
	for _, transport := range []reportTransport{reportHTTP, reportWebSocket} {
		batch, err = prepareReportBatch([]Report{{Name: strings.Repeat("界", maxReportWireBytes)}}, transport, nil)
		var oversized *reportWireSizeError
		if !errors.As(err, &oversized) || len(batch.body) != 0 {
			t.Fatalf("oversize was not rejected: %v", err)
		}
		if delay := reportDeliveryRetryDelay(err, time.Second); delay < time.Minute {
			t.Fatalf("oversize busy retry: %v", delay)
		}
	}
}
func TestReportBatchFreezesDataAndOnlyAcknowledgesSelectedLeases(t *testing.T) {
	state := &pingReportState{pendingPing: map[int]*queuedPingResult{}, pendingWebsites: map[int]*queuedWebsiteResult{}}
	reports := make([]Report, 20)
	for i := range reports {
		id := i + 1
		state.pendingPing[id] = &queuedPingResult{result: PingResult{TaskID: id, Value: float64(id)}, sequence: uint64(id), leased: true}
		state.pingOrder = append(state.pingOrder, id)
		reports[i] = Report{Name: strings.Repeat("x", 60000), Timestamp: int64(id), PingResults: []PingResult{{TaskID: id, Value: float64(id)}}, pingResultLeases: map[int]uint64{id: uint64(id)}}
	}
	owner := &reportPreparer{basicInfoRevision: 7, pendingBasicInfo: &BasicInfo{OS: "original"}}
	reports[0].BasicInfo = owner.pendingBasicInfo
	reports[0].basicInfoOwner = owner
	reports[0].basicInfoRevision = 7
	// A stale map entry without a serialized result must never be acknowledged.
	reports[0].pingResultLeases[999] = 999
	state.pendingPing[999] = &queuedPingResult{sequence: 999, leased: true}
	batch, err := prepareReportBatch(reports, reportHTTP, []upgradeResult{receiptResult(1)})
	if err != nil {
		t.Fatal(err)
	}
	before := append([]byte(nil), batch.body...)
	owner.pendingBasicInfo.OS = "changed after encoding"
	reports[0].PingResults[0].Value = 9999
	if !bytes.Equal(before, batch.body) || batch.reports[0].BasicInfo.OS != "original" || batch.reports[0].PingResults[0].Value == 9999 {
		t.Fatal("prepared data mutated")
	}
	owner.basicInfoRevision++
	state.acknowledgeReports(batch.reports)
	if owner.pendingBasicInfo == nil {
		t.Fatal("new basic-info revision was consumed")
	}
	for i := range reports {
		_, remaining := state.pendingPing[i+1]
		if remaining != (i >= len(batch.reports)) {
			t.Fatalf("incorrect lease at %d", i)
		}
	}
	if state.pendingPing[999] == nil {
		t.Fatal("unsent lease-map entry was consumed")
	}
}
func TestHTTPReportSendsMeasuredBytesWithoutReattachingNewReceipts(t *testing.T) {
	m, _ := receiptManager(t)
	oldRuntime, oldURL, oldToken := upgradeRuntime, serverURL, token
	upgradeRuntime = m
	token = "synthetic-token"
	t.Cleanup(func() { upgradeRuntime = oldRuntime; serverURL = oldURL; token = oldToken })
	healthBeacon.mu.Lock()
	oldWritten, oldLogged := healthBeacon.written, healthBeacon.logged
	healthBeacon.written = true
	healthBeacon.mu.Unlock()
	t.Cleanup(func() {
		healthBeacon.mu.Lock()
		healthBeacon.written, healthBeacon.logged = oldWritten, oldLogged
		healthBeacon.mu.Unlock()
	})
	a, b := receiptResult(1), receiptResult(2)
	m.enqueue(a)
	batch, err := prepareReportBatch([]Report{{CPU: 3}}, reportHTTP, m.snapshot())
	if err != nil {
		t.Fatal(err)
	}
	m.enqueue(b)
	wire := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		wire <- raw
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "accepted_upgrade_ids": []string{a.CommandID, b.CommandID}})
	}))
	defer server.Close()
	serverURL = server.URL
	if err := sendHTTPReports(batch); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(<-wire, batch.body) {
		t.Fatal("HTTP re-encoded a different payload")
	}
	if pending := m.snapshot(); len(pending) != 1 || pending[0].CommandID != b.CommandID {
		t.Fatalf("unsent receipt lost: %+v", pending)
	}
}
func TestWebSocketReportSendsMeasuredBytes(t *testing.T) {
	batch, err := prepareReportBatch([]Report{{CPU: 3}, {CPU: 4}}, reportWebSocket, nil)
	if err != nil {
		t.Fatal(err)
	}
	wire := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		_, raw, err := peer.ReadMessage()
		if err == nil {
			wire <- raw
		}
	}))
	defer server.Close()
	conn, err := connectWebSocket("ws"+strings.TrimPrefix(server.URL, "http"), "synthetic-token")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := sendWebSocketReports(conn, batch); err != nil {
		t.Fatal(err)
	}
	select {
	case raw := <-wire:
		if !bytes.Equal(raw, batch.body) {
			t.Fatal("WS sent bytes differ")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("missing WS bytes")
	}
}

func TestReportBatchHardBoundaryAndSingletonException(t *testing.T) {
	for _, transport := range []reportTransport{reportHTTP, reportWebSocket} {
		encoded, err := json.Marshal(Report{Name: "x"})
		if err != nil {
			t.Fatal(err)
		}
		prefix, suffix := reportFraming(transport, 1)
		count := maxReportWireBytes - len(encoded) - len(prefix) - len(suffix) + 1
		report := Report{Name: strings.Repeat("x", count)}
		batch, err := prepareReportBatch([]Report{report, {}}, transport, nil)
		if err != nil || len(batch.reports) != 1 || len(batch.body) != maxReportWireBytes {
			t.Fatalf("exact hard limit rejected: n=%d bytes=%d err=%v", len(batch.reports), len(batch.body), err)
		}
		report.Name += "x"
		if _, err := prepareReportBatch([]Report{report}, transport, nil); err == nil {
			t.Fatal("hard limit + 1 accepted")
		}
	}
}

func TestHTTPByteChunksRetainFailedAndUnsentProbeReports(t *testing.T) {
	manager, _ := receiptManager(t)
	oldRuntime, oldURL, oldToken := upgradeRuntime, serverURL, token
	upgradeRuntime = manager
	token = "synthetic-token"
	t.Cleanup(func() { upgradeRuntime = oldRuntime; serverURL = oldURL; token = oldToken })
	healthBeacon.mu.Lock()
	oldWritten, oldLogged := healthBeacon.written, healthBeacon.logged
	healthBeacon.written = true
	healthBeacon.mu.Unlock()
	t.Cleanup(func() {
		healthBeacon.mu.Lock()
		healthBeacon.written, healthBeacon.logged = oldWritten, oldLogged
		healthBeacon.mu.Unlock()
	})
	state := &pingReportState{pendingPing: map[int]*queuedPingResult{}, pendingWebsites: map[int]*queuedWebsiteResult{}}
	reports := make([]Report, 20)
	for i := range reports {
		id := i + 1
		state.pendingPing[id] = &queuedPingResult{sequence: uint64(id), leased: true}
		state.pingOrder = append(state.pingOrder, id)
		reports[i] = Report{Name: strings.Repeat("x", 80000), Timestamp: int64(id), PingResults: []PingResult{{TaskID: id, Value: float64(id)}}, pingResultLeases: map[int]uint64{id: uint64(id)}}
	}
	var mu sync.Mutex
	var chunks [][]Report
	var fail atomic.Bool
	fail.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > maxReportWireBytes {
			t.Errorf("oversized request %d", len(raw))
		}
		decoded, err := decodeWireReports(raw)
		if err != nil {
			t.Error(err)
		}
		mu.Lock()
		chunks = append(chunks, decoded)
		index := len(chunks)
		mu.Unlock()
		if fail.Load() && index == 2 {
			http.Error(w, "synthetic failure", 503)
			return
		}
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()
	serverURL = server.URL
	if err := deliverHTTPReports(state, reports); err == nil {
		t.Fatal("second chunk failure not returned")
	}
	mu.Lock()
	acceptedCount := len(chunks[0])
	mu.Unlock()
	if acceptedCount <= 0 || acceptedCount >= len(reports) {
		t.Fatal("fixture did not split by bytes")
	}
	for i := range reports {
		_, remaining := state.pendingPing[i+1]
		if remaining != (i >= acceptedCount) {
			t.Fatalf("incorrect pending lease %d", i+1)
		}
	}
	retry := state.takeRetryReports()
	if len(retry) != len(reports)-acceptedCount {
		t.Fatalf("failed/unsent suffix not retained: %d", len(retry))
	}
	for i, report := range retry {
		if report.Timestamp != reports[acceptedCount+i].Timestamp {
			t.Fatal("retry sample time changed")
		}
	}
	fail.Store(false)
	if err := deliverHTTPReports(state, retry); err != nil {
		t.Fatal(err)
	}
	if len(state.pendingPing) != 0 {
		t.Fatal("successful remaining chunks not acknowledged")
	}
}
