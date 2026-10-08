package main

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Report rejection is not an ACK. The session exits so its existing deferred
// retry path keeps probe/basic-info leases rather than consuming them.
type reportRejectionError struct {
	code       string
	retryAfter time.Duration
}

func (e *reportRejectionError) Error() string {
	return fmt.Sprintf("server rejected report (%s)", e.code)
}
func (e *reportRejectionError) reconnectDelay(base time.Duration) time.Duration {
	return max(base, e.retryAfter) + time.Duration(rand.Int64N(int64(time.Second)))
}
func reportRejectionFromMessage(message serverMessage) error {
	code := "REPORT_REJECTED"
	switch message.Code {
	case "REPORT_BACKPRESSURE", "REPORT_REJECTED", "REPORT_TOO_LARGE":
		code = message.Code
	}
	seconds := message.RetryAfterSec
	if seconds <= 0 {
		seconds = 5
	}
	seconds = min(seconds, 60)
	if code == "REPORT_TOO_LARGE" {
		seconds = 60
	}
	return &reportRejectionError{code: code, retryAfter: time.Duration(seconds) * time.Second}
}

func reportDeliveryRetryDelay(err error, base time.Duration) time.Duration {
	var response *httpStatusResponseError
	if errors.As(err, &response) {
		if response.statusCode == http.StatusUnauthorized || response.statusCode == http.StatusForbidden {
			return max(base, 10*time.Minute)
		}
		delay := max(base, response.retryAfter)
		if response.statusCode == http.StatusTooManyRequests || response.statusCode == http.StatusServiceUnavailable {
			delay += time.Duration(rand.Int64N(int64(time.Second)))
		}
		return delay
	}

	var oversized *reportWireSizeError
	if errors.As(err, &oversized) {
		return max(base, time.Minute)
	}
	var rejection *reportRejectionError
	if errors.As(err, &rejection) {
		return rejection.reconnectDelay(base)
	}
	if err != nil && (strings.HasPrefix(err.Error(), "401 ") || strings.HasPrefix(err.Error(), "403 ")) {
		return max(base, 10*time.Minute)
	}
	return base
}

const maxReportRetryAfter = 10 * time.Minute

type httpStatusResponseError struct {
	statusCode int
	retryAfter time.Duration
	detail     string
	truncated  bool
}

func (e *httpStatusResponseError) Error() string {
	if e.detail == "" {
		return fmt.Sprintf("HTTP %d", e.statusCode)
	}
	suffix := ""
	if e.truncated {
		suffix = "...(truncated)"
	}
	return fmt.Sprintf("HTTP %d: %s%s", e.statusCode, e.detail, suffix)
}
func parseReportRetryAfter(raw string, now time.Time) time.Duration {
	value := strings.TrimSpace(raw)
	seconds, err := strconv.ParseUint(value, 10, 64)
	if err == nil {
		if seconds >= uint64(maxReportRetryAfter/time.Second) {
			return maxReportRetryAfter
		}
		return time.Duration(seconds) * time.Second
	}
	if errors.Is(err, strconv.ErrRange) {
		return maxReportRetryAfter
	}
	when, err := http.ParseTime(value)
	if err != nil || !when.After(now) {
		return 0
	}
	return min(when.Sub(now), maxReportRetryAfter)
}
