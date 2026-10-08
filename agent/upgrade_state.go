package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Upgrade status enum — kept byte-identical to the worker/DB/frontend contract.
//
//	queued | dispatched | running | success | already_latest | failed | rolled_back | unverified
//
// The Agent only ever emits the terminal subset (success/already_latest/failed/
// rolled_back); queued/dispatched/running/unverified are owned by the panel and
// the Worker. Declaring the full set here keeps the shared contract in one place.
const (
	upgradeStatusQueued        = "queued"
	upgradeStatusDispatched    = "dispatched"
	upgradeStatusRunning       = "running"
	upgradeStatusSuccess       = "success"
	upgradeStatusAlreadyLatest = "already_latest"
	upgradeStatusFailed        = "failed"
	upgradeStatusRolledBack    = "rolled_back"
	upgradeStatusUnverified    = "unverified"
)

// Failure codes — the exhaustive allowlist shared across Go/DB/frontend.
const (
	upgradeFailureChecksumMismatch    = "checksum_mismatch"
	upgradeFailureDownloadFailed      = "download_failed"
	upgradeFailureStagingFailed       = "staging_failed"
	upgradeFailureReplaceFailed       = "replace_failed"
	upgradeFailureRestartFailed       = "restart_failed"
	upgradeFailureHealthTimeout       = "health_timeout"
	upgradeFailureRollbackFailed      = "rollback_failed"
	upgradeFailureUnsupportedPlatform = "unsupported_platform"
	upgradeFailureInvalidTarget       = "invalid_target"
	upgradeFailureProbeFailed         = "probe_failed"
	upgradeFailureTimeout             = "timeout"
)

// Naming / path contract (shared with the installers).
const (
	upgradeBinaryName       = "cf-vps-monitor-agent"
	upgradeBackupSuffix     = ".bak"
	upgradeStagingSuffixFmt = ".new.%d"
	upgradeRequestFile      = "upgrade-request.json"
	upgradeResultFile       = "upgrade-result.json"
	upgradeHealthFile       = "agent-health.json"
	upgradeLockFile         = "upgrade.lock"
)

// defaultUpgradeRepository is the release source used when neither the task nor
// the environment supplies a concrete release base. The operator installers keep
// the same `owner/repo`, anchored by install-branch-consistency.test.mjs; this
// Go copy only builds download URLs on the node and can be overridden by
// CF_MONITOR_RELEASE_REPOSITORY for forks.
const defaultUpgradeRepository = "jiuhunwl/cf-vps-monitor"

// upgradeTask is the server-issued work item delivered through the Agent policy.
type upgradeTask struct {
	ID            string `json:"id"`
	TargetVersion string `json:"target_version"`
	ReleaseBase   string `json:"release_base,omitempty"`
	Proxy         string `json:"proxy,omitempty"`
	GhProxy       string `json:"ghproxy,omitempty"`
	DeadlineMs    int64  `json:"deadline,omitempty"`
}

// upgradeRequest is written by the (non-root) Agent and consumed by the root
// supervisor. It is untrusted input: the file lives in $STATE_DIR, which the
// installer chowns to the non-root Agent user. Only CommandID and TargetVersion
// are honoured from here; both the paths and the download origin (release base,
// proxy, ghproxy) come from the supervisor's own argv. Honouring the origin
// would let anyone who can write this file point the download — binary and
// SHA256SUMS alike — at a host they control, which defeats checksum
// verification and hands root code execution to a non-root writer.
type upgradeRequest struct {
	CommandID     string `json:"command_id"`
	TargetVersion string `json:"target_version"`
	ReleaseBase   string `json:"release_base,omitempty"`
	Proxy         string `json:"proxy,omitempty"`
	GhProxy       string `json:"ghproxy,omitempty"`
	RequestedAtMs int64  `json:"requested_at"`
}

// upgradeResult is written by the supervisor/apply process and read back by the
// (new) Agent to report through Report.UpgradeResults.
type upgradeResult struct {
	CommandID     string `json:"command_id"`
	TargetVersion string `json:"target_version"`
	FromVersion   string `json:"from_version"`
	FinalVersion  string `json:"final_version"`
	Status        string `json:"status"`
	FailureCode   string `json:"failure_code,omitempty"`
	Reason        string `json:"reason,omitempty"`
	StartedAtMs   int64  `json:"started_at"`
	FinishedAtMs  int64  `json:"finished_at"`
}

// agentHealth is the liveness/version beacon. It is written by the Agent after
// its first accepted report and read by the supervisor to confirm a restart.
// The version source is Report.version (every report carries it), never
// BasicInfo (which only refreshes every 30 minutes).
type agentHealth struct {
	Version      string `json:"version"`
	PID          int    `json:"pid"`
	Instance     string `json:"instance"`
	StartedAtMs  int64  `json:"started_at"`
	ReportedAtMs int64  `json:"reported_at"`
}

// upgradeStateDir resolves the directory holding the request/result/health
// files. It mirrors trafficResetStatePath so the beacon lands beside the traffic
// state file the installer already manages.
func upgradeStateDir() string {
	if override := strings.TrimSpace(os.Getenv("CF_MONITOR_TRAFFIC_STATE_FILE")); override != "" {
		if dir := filepath.Dir(override); dir != "" && dir != "." {
			return dir
		}
	}
	if override := strings.TrimSpace(os.Getenv("CF_MONITOR_UPGRADE_STATE_DIR")); override != "" {
		return override
	}
	if exePath, err := os.Executable(); err == nil {
		if dir := filepath.Dir(exePath); strings.TrimSpace(dir) != "" && dir != "." {
			return dir
		}
	}
	return ""
}

// stateFile joins a known state directory with one of the fixed filenames.
func stateFile(stateDir, name string) string {
	return filepath.Join(stateDir, name)
}

// readJSONFile decodes a small JSON document, refusing to follow symlinks so a
// hostile local user cannot redirect the reader at an arbitrary target.
func readJSONFile(path string, out any) error {
	file, err := openNoFollow(path, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	if err := decoder.Decode(out); err != nil {
		return err
	}
	return nil
}

// writeJSONFile writes atomically (same-directory temp file + rename) with 0600
// so readers never observe a partially written document.
func writeJSONFile(path string, value any) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	encoder := json.NewEncoder(tmp)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}

func readUpgradeRequest(stateDir string) (upgradeRequest, error) {
	var request upgradeRequest
	if stateDir == "" {
		return request, errors.New("state directory is unset")
	}
	err := readJSONFile(stateFile(stateDir, upgradeRequestFile), &request)
	return request, err
}

func writeUpgradeRequest(stateDir string, request upgradeRequest) error {
	if stateDir == "" {
		return errors.New("state directory is unset")
	}
	return writeJSONFile(stateFile(stateDir, upgradeRequestFile), request)
}

func removeUpgradeRequest(stateDir string) error {
	if stateDir == "" {
		return nil
	}
	err := os.Remove(stateFile(stateDir, upgradeRequestFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func readUpgradeResult(stateDir string) (upgradeResult, error) {
	var result upgradeResult
	if stateDir == "" {
		return result, errors.New("state directory is unset")
	}
	err := readJSONFile(stateFile(stateDir, upgradeResultFile), &result)
	return result, err
}

func writeUpgradeResult(stateDir string, result upgradeResult) error {
	if stateDir == "" {
		return errors.New("state directory is unset")
	}
	return writeJSONFile(stateFile(stateDir, upgradeResultFile), result)
}

func removeUpgradeResult(stateDir string) error {
	if stateDir == "" {
		return nil
	}
	err := os.Remove(stateFile(stateDir, upgradeResultFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func readAgentHealth(path string) (agentHealth, error) {
	var health agentHealth
	if path == "" {
		return health, errors.New("health file path is unset")
	}
	err := readJSONFile(path, &health)
	return health, err
}

func writeAgentHealth(path string, health agentHealth) error {
	if path == "" {
		return errors.New("health file path is unset")
	}
	return writeJSONFile(path, health)
}

// processStartedAtMs records when this process began, used as the beacon's
// started_at. It is captured once at package init.
var processStartedAtMs = time.Now().UnixMilli()

// upgradeLock is a supervisor singleton lock. Privileged Unix locks live in
// the protected installation directory; other platforms retain state storage.
type upgradeLock struct {
	handle *os.File
	path   string
}

// acquireUpgradeLock takes the upgrade lock without blocking. A nil lock with a
// nil error cannot happen; callers always get either a held lock or an error.
func acquireUpgradeLock(options upgradeOptions) (*upgradeLock, error) {
	if options.stateDir == "" {
		return nil, errors.New("state directory is unset")
	}
	handle, path, err := platformAcquireUpgradeLock(options)
	if err != nil {
		return nil, err
	}
	return &upgradeLock{handle: handle, path: path}, nil
}

// Release drops the lock. It is safe to call on a nil receiver.
func (l *upgradeLock) Release() {
	if l == nil || l.handle == nil {
		return
	}
	_ = unlockUpgradeFile(l.handle)
	_ = l.handle.Close()
	l.handle = nil
}

// beaconOnce guards the "write the health beacon after the first accepted
// report" rule. A failed write leaves the once unspent so the next accepted
// report retries.
type healthBeaconState struct {
	mu      sync.Mutex
	written bool
	logged  bool
}

var healthBeacon healthBeaconState

// resetHealthBeacon is used by tests to force a fresh beacon attempt.
func resetHealthBeacon() {
	healthBeacon.mu.Lock()
	healthBeacon.written = false
	healthBeacon.logged = false
	healthBeacon.mu.Unlock()
}

// reportUpgradeHealth records that a report was accepted. It writes the beacon
// once per process (best effort) so a supervisor observing a fresh, correctly
// versioned beacon can confirm the restarted Agent came back healthy.
func reportUpgradeHealth() {
	healthBeacon.mu.Lock()
	if healthBeacon.written {
		healthBeacon.mu.Unlock()
		return
	}
	healthBeacon.mu.Unlock()

	path := explicitHealthFilePath()
	if path == "" {
		return
	}
	beacon := agentHealth{
		Version:      Version,
		PID:          os.Getpid(),
		Instance:     strings.TrimSpace(os.Getenv("CF_MONITOR_INSTANCE_ID")),
		StartedAtMs:  processStartedAtMs,
		ReportedAtMs: time.Now().UnixMilli(),
	}
	if err := writeAgentHealth(path, beacon); err != nil {
		healthBeacon.mu.Lock()
		if !healthBeacon.logged {
			logUpgrade("health beacon write failed: %v", err)
			healthBeacon.logged = true
		}
		healthBeacon.mu.Unlock()
		return
	}
	healthBeacon.mu.Lock()
	healthBeacon.written = true
	healthBeacon.mu.Unlock()
}

// explicitHealthFilePath resolves the beacon path from explicit configuration
// only (the --health-file flag or the state-directory environment). It returns
// "" when neither is set so ordinary runs do not create stray files.
func explicitHealthFilePath() string {
	if path := strings.TrimSpace(upgradeFlagHealthFile); path != "" {
		return path
	}
	if override := strings.TrimSpace(os.Getenv("CF_MONITOR_TRAFFIC_STATE_FILE")); override != "" {
		if dir := filepath.Dir(override); dir != "" && dir != "." {
			return filepath.Join(dir, upgradeHealthFile)
		}
	}
	if override := strings.TrimSpace(os.Getenv("CF_MONITOR_UPGRADE_STATE_DIR")); override != "" {
		return filepath.Join(override, upgradeHealthFile)
	}
	return ""
}

// upgradeHealthFilePath resolves the beacon path. An explicit value (from
// --health-file) wins; otherwise it lands in the state directory.
func upgradeHealthFilePath(explicit string) string {
	if trimmed := strings.TrimSpace(explicit); trimmed != "" {
		return trimmed
	}
	dir := upgradeStateDir()
	if dir == "" {
		return ""
	}
	return stateFile(dir, upgradeHealthFile)
}

// logUpgrade emits a line with the shared `upgrade:` prefix.
func logUpgrade(format string, args ...any) {
	log.Printf("upgrade: "+format, args...)
}

// formatUpgradeLog renders the canonical result line: command id, from→to,
// status and failure code.
func formatUpgradeLog(result upgradeResult) string {
	return fmt.Sprintf("command_id=%s %s→%s status=%s failure_code=%s",
		result.CommandID, result.FromVersion, result.FinalVersion, result.Status, result.FailureCode)
}
