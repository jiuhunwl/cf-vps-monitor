package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"testing"
)

func receiptManager(t *testing.T) (*upgradeManager, string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", "")
	t.Setenv("CF_MONITOR_UPGRADE_STATE_DIR", dir)
	return &upgradeManager{queuedIDs: map[string]bool{}, reportedIDs: map[string]bool{}}, dir
}
func receiptResult(n int) upgradeResult {
	return upgradeResult{CommandID: fmt.Sprintf("00000000-0000-4000-8000-%012d", n), Status: upgradeStatusSuccess, TargetVersion: "v2", FinalVersion: "v2"}
}
func TestUpgradeReceiptsOnlyClearSentAndExplicitlyConfirmedResults(t *testing.T) {
	m, _ := receiptManager(t)
	a, b, c := receiptResult(1), receiptResult(2), receiptResult(3)
	m.enqueue(a)
	m.enqueue(b)
	sent := []Report{{UpgradeResults: m.snapshot()}}
	m.enqueue(c)
	m.acknowledge(sent, upgradeReceiptIDs{a.CommandID, c.CommandID, "unknown"})
	pending := m.snapshot()
	if len(pending) != 2 || pending[0].CommandID != b.CommandID || pending[1].CommandID != c.CommandID {
		t.Fatalf("unsent/unconfirmed receipts lost: %+v", pending)
	}
	m.acknowledge(sent, nil)
	if len(m.snapshot()) != 2 {
		t.Fatal("legacy ACK cleared receipts")
	}
}
func TestUpgradeReceiptCannotClearChangedSameIDPayload(t *testing.T) {
	m, _ := receiptManager(t)
	a := receiptResult(1)
	m.enqueue(a)
	sent := []Report{{UpgradeResults: m.snapshot()}}
	m.mu.Lock()
	m.pending[0].Reason = "new unsent details"
	m.mu.Unlock()
	m.acknowledge(sent, upgradeReceiptIDs{a.CommandID})
	if len(m.snapshot()) != 1 {
		t.Fatal("changed unsent payload cleared")
	}
}
func TestUpgradeReceiptAckNeverDeletesNewerDiskResult(t *testing.T) {
	m, dir := receiptManager(t)
	a, b := receiptResult(1), receiptResult(2)
	if err := writeUpgradeResult(dir, a); err != nil {
		t.Fatal(err)
	}
	sent := []Report{{UpgradeResults: m.snapshot()}}
	if err := writeUpgradeResult(dir, b); err != nil {
		t.Fatal(err)
	}
	m.acknowledge(sent, upgradeReceiptIDs{a.CommandID, b.CommandID})
	disk, err := readUpgradeResult(dir)
	if err != nil || disk.CommandID != b.CommandID {
		t.Fatalf("new disk result lost: %+v %v", disk, err)
	}
	if pending := m.snapshot(); len(pending) != 1 || pending[0].CommandID != b.CommandID {
		t.Fatalf("new result not replayed: %+v", pending)
	}
	m.acknowledge([]Report{{UpgradeResults: m.snapshot()}}, upgradeReceiptIDs{b.CommandID})
	if len(m.snapshot()) != 0 {
		t.Fatal("acknowledged retained file was immediately re-enqueued")
	}
	restarted := &upgradeManager{queuedIDs: map[string]bool{}, reportedIDs: map[string]bool{}}
	if len(restarted.snapshot()) != 1 {
		t.Fatal("restart must replay retained file for idempotent server confirmation")
	}
}
func TestUpgradeReceiptFieldsFailClosedWithoutBreakingTelemetryAck(t *testing.T) {
	for _, raw := range []string{`{"success":true}`, `{"success":true,"accepted_upgrade_ids":null}`, `{"success":true,"accepted_upgrade_ids":42}`, `{"success":true,"accepted_upgrade_ids":[1]}`} {
		var ack struct {
			Success bool              `json:"success"`
			IDs     upgradeReceiptIDs `json:"accepted_upgrade_ids"`
		}
		if err := json.Unmarshal([]byte(raw), &ack); err != nil || !ack.Success || len(ack.IDs) != 0 {
			t.Fatalf("legacy/malformed receipt handling: %+v %v", ack, err)
		}
	}
}
func TestUpgradeReceiptSnapshotsAreBoundedWithoutDiscardingQueuedResults(t *testing.T) {
	m, _ := receiptManager(t)
	for n := 1; n <= maxUpgradeResultsPerEnvelope+3; n++ {
		m.enqueue(receiptResult(n))
	}
	first := m.snapshot()
	if len(first) != maxUpgradeResultsPerEnvelope {
		t.Fatalf("snapshot length %d", len(first))
	}
	ids := make(upgradeReceiptIDs, len(first))
	for i, r := range first {
		ids[i] = r.CommandID
	}
	m.acknowledge([]Report{{UpgradeResults: first}}, ids)
	if len(m.snapshot()) != 3 {
		t.Fatal("unsent tail was discarded")
	}
}
func TestLocalCLIResultIsNotSentAsAPanelCommand(t *testing.T) {
	m, dir := receiptManager(t)
	r := receiptResult(1)
	r.CommandID = "cli-local-invocation"
	if err := writeUpgradeResult(dir, r); err != nil {
		t.Fatal(err)
	}
	if len(m.snapshot()) != 0 {
		t.Fatal("local-only result queued for nonexistent panel command")
	}
}

func TestWebSocketAcknowledgementCarriesExplicitUpgradeIDs(t *testing.T) {
	id := receiptResult(1).CommandID
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		_ = peer.WriteJSON(serverMessage{Type: "ack", AcceptedUpgradeIDs: upgradeReceiptIDs{id}})
	}))
	defer server.Close()
	conn, err := connectWebSocket("ws"+strings.TrimPrefix(server.URL, "http"), "synthetic-token")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	done := make(chan error, 1)
	policies := make(chan serverMessage, 1)
	acknowledgements := make(chan serverMessage, 1)
	go readWebSocketMessages(conn, done, policies, acknowledgements)
	select {
	case message := <-acknowledgements:
		if len(message.AcceptedUpgradeIDs) != 1 || message.AcceptedUpgradeIDs[0] != id {
			t.Fatalf("receipt lost in ACK channel: %+v", message)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ACK channel did not carry receipts")
	}
}
