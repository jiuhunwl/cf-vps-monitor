package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// startUpgradeReleaseServer serves a release asset plus its SHA256SUMS. When
// publishedHash is empty the documented hash for the body is used; otherwise the
// caller-supplied (possibly wrong) hash is served to exercise mismatch handling.
func startUpgradeReleaseServer(t *testing.T, body []byte, publishedHash string) *httptest.Server {
	t.Helper()
	asset := upgradeAssetName()
	digest := sha256.Sum256(body)
	if publishedHash == "" {
		publishedHash = hex.EncodeToString(digest[:])
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/rel/"+asset, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	})
	mux.HandleFunc("/rel/SHA256SUMS", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  %s\n", publishedHash, asset)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

// withUpgradeVersion temporarily pins Version for the duration of a test.
func withUpgradeVersion(t *testing.T, version string) {
	t.Helper()
	original := Version
	Version = version
	t.Cleanup(func() { Version = original })
}

// withUpgradeSeams replaces the restart/active seams so no host service manager
// is touched, returning a counter of restart invocations.
func withUpgradeSeams(t *testing.T, active bool) *int {
	t.Helper()
	restarts := 0
	originalRestart, originalActive := upgradeRestartService, upgradeServiceIsActive
	upgradeRestartService = func(upgradeOptions) error { restarts++; return nil }
	upgradeServiceIsActive = func(string, string, string) bool { return active }
	t.Cleanup(func() {
		upgradeRestartService = originalRestart
		upgradeServiceIsActive = originalActive
	})
	return &restarts
}

func newUpgradeTestEnv(t *testing.T) (upgradeOptions, string) {
	t.Helper()
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"} {
		t.Setenv(name, "")
	}
	root := t.TempDir()
	installDir := filepath.Join(root, "install")
	stateDir := filepath.Join(root, "state")
	if err := os.MkdirAll(installDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	targetPath := filepath.Join(installDir, upgradeBinaryFilename())
	if err := os.WriteFile(targetPath, []byte("OLDBINARY"), 0o755); err != nil {
		t.Fatal(err)
	}
	options := upgradeOptions{
		installDir:    installDir,
		stateDir:      stateDir,
		serviceMode:   "systemd",
		serviceName:   "cf-vps-monitor-agent-test",
		healthFile:    filepath.Join(stateDir, upgradeHealthFile),
		healthTimeout: 5 * time.Millisecond,
		repository:    "example/repo",
	}
	return options, targetPath
}

func noStagingLeftovers(t *testing.T, installDir string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(installDir, "*"+".new.*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("staging files were not cleaned up: %v", matches)
	}
}

func TestApplyUpgradeChecksumMismatchRejectsWithoutTouchingBinary(t *testing.T) {
	options, targetPath := newUpgradeTestEnv(t)
	withUpgradeVersion(t, "v1.0.0")
	restarts := withUpgradeSeams(t, true)
	server := startUpgradeReleaseServer(t, []byte("NEWBINARY"), strings.Repeat("0", 64))

	result := applyUpgrade(options, upgradeTask{ID: "cmd-1", TargetVersion: "v1.1.0", ReleaseBase: server.URL + "/rel"})

	if result.Status != upgradeStatusFailed || result.FailureCode != upgradeFailureChecksumMismatch {
		t.Fatalf("status=%q code=%q, want failed/checksum_mismatch", result.Status, result.FailureCode)
	}
	if *restarts != 0 {
		t.Fatalf("checksum mismatch must not restart the service, got %d restarts", *restarts)
	}
	content, err := os.ReadFile(targetPath)
	if err != nil || string(content) != "OLDBINARY" {
		t.Fatalf("binary was modified on failed verification: %q err=%v", content, err)
	}
	if _, err := os.Stat(targetPath + upgradeBackupSuffix); !os.IsNotExist(err) {
		t.Fatalf("no backup should be created on a rejected download: %v", err)
	}
	noStagingLeftovers(t, options.installDir)
}

func TestApplyUpgradeAlreadyLatestIsZeroSideEffects(t *testing.T) {
	options, targetPath := newUpgradeTestEnv(t)
	withUpgradeVersion(t, "v1.2.3")
	restarts := withUpgradeSeams(t, true)
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	t.Cleanup(server.Close)

	result := applyUpgrade(options, upgradeTask{ID: "cmd-2", TargetVersion: "v1.2.3", ReleaseBase: server.URL + "/rel"})

	if result.Status != upgradeStatusAlreadyLatest {
		t.Fatalf("status=%q, want already_latest", result.Status)
	}
	if hits != 0 {
		t.Fatalf("already-latest must not download anything, saw %d requests", hits)
	}
	if *restarts != 0 {
		t.Fatalf("already-latest must not restart, saw %d", *restarts)
	}
	content, err := os.ReadFile(targetPath)
	if err != nil || string(content) != "OLDBINARY" {
		t.Fatalf("already-latest must not modify the binary: %q err=%v", content, err)
	}
	entries, err := os.ReadDir(options.installDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("already-latest must not create files, install dir has %d entries", len(entries))
	}
	noStagingLeftovers(t, options.installDir)
}

func TestApplyUpgradeHealthFailureRollsBack(t *testing.T) {
	options, targetPath := newUpgradeTestEnv(t)
	withUpgradeVersion(t, "v1.0.0")
	restarts := withUpgradeSeams(t, true)
	// A beacon that still reports the old version: the new service never becomes
	// healthy, forcing rollback.
	beacon := agentHealth{Version: "v1.0.0", ReportedAtMs: time.Now().UnixMilli()}
	if err := writeAgentHealth(options.healthFile, beacon); err != nil {
		t.Fatal(err)
	}
	server := startUpgradeReleaseServer(t, []byte("NEWBINARY"), "")

	result := applyUpgrade(options, upgradeTask{ID: "cmd-3", TargetVersion: "v9.9.9", ReleaseBase: server.URL + "/rel"})

	if result.Status != upgradeStatusRolledBack || result.FailureCode != upgradeFailureHealthTimeout {
		t.Fatalf("status=%q code=%q, want rolled_back/health_timeout", result.Status, result.FailureCode)
	}
	if *restarts < 1 {
		t.Fatalf("rollback must restart the service, saw %d restarts", *restarts)
	}
	content, err := os.ReadFile(targetPath)
	if err != nil || string(content) != "OLDBINARY" {
		t.Fatalf("rollback must restore the previous binary: %q err=%v", content, err)
	}
	if result.FinalVersion != "v1.0.0" {
		t.Fatalf("final version=%q, want the restored v1.0.0", result.FinalVersion)
	}
	if _, err := os.Stat(targetPath + upgradeBackupSuffix); err != nil {
		t.Fatalf("the most recent backup should be retained: %v", err)
	}
	noStagingLeftovers(t, options.installDir)
}

func TestApplyUpgradeSuccessReplacesBinary(t *testing.T) {
	options, targetPath := newUpgradeTestEnv(t)
	withUpgradeVersion(t, "v1.0.0")
	restarts := withUpgradeSeams(t, true)
	server := startUpgradeReleaseServer(t, []byte("NEWBINARY"), "")
	// A fresh beacon already advertising the target version confirms health.
	if err := writeAgentHealth(options.healthFile, agentHealth{Version: "v9.9.9", ReportedAtMs: time.Now().Add(time.Hour).UnixMilli()}); err != nil {
		t.Fatal(err)
	}

	result := applyUpgrade(options, upgradeTask{ID: "cmd-4", TargetVersion: "v9.9.9", ReleaseBase: server.URL + "/rel"})

	if result.Status != upgradeStatusSuccess || result.FinalVersion != "v9.9.9" {
		t.Fatalf("status=%q final=%q, want success/v9.9.9 (code=%q reason=%q)", result.Status, result.FinalVersion, result.FailureCode, result.Reason)
	}
	if *restarts != 1 {
		t.Fatalf("successful upgrade must restart exactly once, saw %d", *restarts)
	}
	content, err := os.ReadFile(targetPath)
	if err != nil || string(content) != "NEWBINARY" {
		t.Fatalf("binary was not replaced: %q err=%v", content, err)
	}
	noStagingLeftovers(t, options.installDir)
}

func TestRequireHTTPSURLAndNormalizeProxyURL(t *testing.T) {
	if err := requireHTTPSURL("x", "http://insecure.example"); err == nil {
		t.Fatal("plain http must be rejected")
	}
	if err := requireHTTPSURL("x", "https://ok.example/path"); err != nil {
		t.Fatalf("https url rejected: %v", err)
	}
	if err := requireHTTPSURL("x", "https://user:pass@ok.example"); err == nil {
		t.Fatal("credentials in url must be rejected")
	}
	if value, err := normalizeProxyURL("p", "http://127.0.0.1:1080/"); err != nil || value != "http://127.0.0.1:1080" {
		t.Fatalf("proxy normalization=%q err=%v", value, err)
	}
	if _, err := normalizeProxyURL("p", "socks5://127.0.0.1"); err == nil {
		t.Fatal("non-http proxy scheme must be rejected")
	}
}

func TestValidateUpgradeRequestAllowlist(t *testing.T) {
	if err := validateUpgradeRequest(upgradeRequest{TargetVersion: "latest"}); err != nil {
		t.Fatalf("latest should be accepted: %v", err)
	}
	if err := validateUpgradeRequest(upgradeRequest{TargetVersion: "v1.2.3"}); err != nil {
		t.Fatalf("safe tag should be accepted: %v", err)
	}
	if err := validateUpgradeRequest(upgradeRequest{TargetVersion: "../../etc/passwd"}); err == nil {
		t.Fatal("path traversal target must be rejected")
	}
	if err := validateUpgradeRequest(upgradeRequest{TargetVersion: ""}); err == nil {
		t.Fatal("empty target must be rejected")
	}
	if err := validateUpgradeRequest(upgradeRequest{TargetVersion: "v1.2.3", ReleaseBase: "http://insecure"}); err == nil {
		t.Fatal("non-https release base must be rejected")
	}
	if err := validateUpgradeRequest(upgradeRequest{TargetVersion: "v1.2.3", Proxy: "socks5://x"}); err == nil {
		t.Fatal("invalid proxy must be rejected")
	}
}

func TestReleaseTagIsSafe(t *testing.T) {
	for _, tag := range []string{"v1.2.3", "v1.2.3-rc.1", "v1.2.3+build.5", "custom-tag"} {
		if !releaseTagIsSafe(tag) {
			t.Fatalf("%q should be safe", tag)
		}
	}
	for _, tag := range []string{"", "../x", "a..b", "v1.2.3.", "x.lock", "-leading"} {
		if releaseTagIsSafe(tag) {
			t.Fatalf("%q should be rejected", tag)
		}
	}
}
