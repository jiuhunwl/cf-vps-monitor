package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestReportRejectionSanitizesCodeAndBoundsRetry(t *testing.T) {
	previous := reconnectInterval
	reconnectInterval = 5
	defer func() { reconnectInterval = previous }()
	err := reportRejectionFromMessage(serverMessage{Type: "error", Code: "SECRET\nforged log", RetryAfterSec: 999999})
	if strings.Contains(err.Error(), "SECRET") || strings.Contains(err.Error(), "\n") {
		t.Fatalf("untrusted rejection logged: %v", err)
	}
	delay := webSocketReconnectDelay(err)
	if delay < 60*time.Second || delay >= 61*time.Second {
		t.Fatalf("unbounded retry: %v", delay)
	}
	oversized := reportRejectionFromMessage(serverMessage{Type: "error", Code: "REPORT_TOO_LARGE"})
	if delay := webSocketReconnectDelay(oversized); delay < time.Minute {
		t.Fatalf("oversize retry too fast: %v", delay)
	}
}

func TestServerBackpressureEndsReaderWithoutAcknowledging(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		_ = peer.WriteJSON(serverMessage{Type: "error", Code: "REPORT_BACKPRESSURE", RetryAfterSec: 7})
		<-release
	}))
	defer server.Close()
	defer close(release)
	conn, err := connectWebSocket("ws"+strings.TrimPrefix(server.URL, "http"), "synthetic-token")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.configureLiveness(30 * time.Second); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	acks := make(chan serverMessage, 1)
	policies := make(chan serverMessage, 1)
	go readWebSocketMessages(conn, done, policies, acks)
	select {
	case err := <-done:
		var rejection *reportRejectionError
		if !errors.As(err, &rejection) || rejection.code != "REPORT_BACKPRESSURE" {
			t.Fatalf("unexpected error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("rejection waited for the ACK deadline")
	}
	if len(acks) != 0 || len(policies) != 0 {
		t.Fatal("rejection was treated as accepted data")
	}
}

func TestAgentReadLimitBoundsPolicyAllocation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		_ = peer.WriteMessage(websocket.TextMessage, bytes.Repeat([]byte("x"), maxAgentWebSocketMessageBytes+1))
	}))
	defer server.Close()
	conn, err := connectWebSocket("ws"+strings.TrimPrefix(server.URL, "http"), "synthetic-token")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.configureLiveness(time.Second); err != nil {
		t.Fatal(err)
	}
	if _, _, err := conn.ReadMessage(); !errors.Is(err, websocket.ErrReadLimit) {
		t.Fatalf("oversized policy was not rejected at the reader: %v", err)
	}
}

func TestReportBackpressureRetainsProbeAndBasicInfoLeases(t *testing.T) {
	preparer, state := basicInfoDeliveryFixture(t)
	state.mu.Lock()
	state.queuePingResultsLocked([]PingResult{{TaskID: 7, Value: 10}})
	state.mu.Unlock()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		if _, _, err := peer.ReadMessage(); err != nil {
			return
		}
		_ = peer.WriteJSON(serverMessage{Type: "error", Code: "REPORT_BACKPRESSURE", RetryAfterSec: 5})
	}))
	defer server.Close()
	conn, err := connectWebSocket("ws"+strings.TrimPrefix(server.URL, "http"), "synthetic-token")
	if err != nil {
		t.Fatal(err)
	}
	err = runWebSocketSession(conn, preparer, state, 3*time.Second, 10*time.Second)
	var rejection *reportRejectionError
	if !errors.As(err, &rejection) {
		t.Fatalf("expected report rejection: %v", err)
	}
	retried := state.takeRetryReports()
	found := false
	for _, report := range retried {
		for _, result := range report.PingResults {
			if result.TaskID == 7 {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("unacknowledged probe lease was lost")
	}
	preparer.basicInfoMu.Lock()
	defer preparer.basicInfoMu.Unlock()
	if preparer.pendingBasicInfo == nil {
		t.Fatal("unacknowledged basic-info revision was cleared")
	}
}

func TestHTTPStatusErrorsDriveAuthAndServerRetryBackoff(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		err := httpStatusError(&http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("synthetic denial"))})
		if delay := reportDeliveryRetryDelay(err, 5*time.Second); delay != 10*time.Minute {
			t.Fatalf("HTTP %d backoff=%v", status, delay)
		}
	}
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		err := httpStatusError(&http.Response{StatusCode: status, Header: http.Header{"Retry-After": []string{"30"}}, Body: io.NopCloser(strings.NewReader("synthetic busy"))})
		delay := reportDeliveryRetryDelay(err, 5*time.Second)
		if delay < 30*time.Second || delay >= 31*time.Second {
			t.Fatalf("HTTP %d Retry-After ignored: %v", status, delay)
		}
	}
}
func TestReportRetryAfterParsingIsBounded(t *testing.T) {
	now := time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)
	for _, value := range []string{"99999999999999999999999999", "86400"} {
		if got := parseReportRetryAfter(value, now); got != maxReportRetryAfter {
			t.Fatalf("unbounded retry for %q: %v", value, got)
		}
	}
	if got := parseReportRetryAfter(now.Add(45*time.Second).Format(http.TimeFormat), now); got != 45*time.Second {
		t.Fatalf("HTTP-date retry=%v", got)
	}
	for _, value := range []string{"", "-1", "bogus", now.Add(-time.Hour).Format(http.TimeFormat)} {
		if got := parseReportRetryAfter(value, now); got != 0 {
			t.Fatalf("invalid/past retry %q: %v", value, got)
		}
	}
}
