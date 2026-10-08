package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// upgradeOptions carries the fully resolved inputs for one upgrade operation.
// Every path the engine touches comes from these fields, which in the
// supervisor are derived exclusively from its own argv (never the request file)
// to prevent a non-root writer from redirecting a root replacement.
type upgradeOptions struct {
	// targetVersion is "" (→ latest), "latest", or a concrete release tag.
	targetVersion string
	// commandID is the panel-issued command id, echoed into the result.
	commandID string
	// releaseBase overrides the default GitHub release base for the tag.
	releaseBase string
	instanceID  string
	installDir  string
	serviceName string
	installMode string
	// serviceMode is the resolved init system: systemd|openrc|launchctl|user|windows.
	serviceMode   string
	stateDir      string
	healthFile    string
	healthTimeout time.Duration
	proxy         string
	ghProxy       string
	// repository is the owner/repo used to build default download URLs.
	repository string
}

var upgradeGOOS = runtime.GOOS

// errChecksumMismatch distinguishes a failed SHA256 comparison from a transport
// failure so the caller can emit the precise failure_code.
var errChecksumMismatch = errors.New("checksum mismatch")

// sanitizeUpgradeInstanceID mirrors the installer's sanitize_instance_id: a
// lower-cased, restricted-to [a-z0-9_.-] identifier, capped at 48 characters.
func sanitizeUpgradeInstanceID(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = "default"
	}
	var builder strings.Builder
	for _, r := range strings.ToLower(raw) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '.', r == '-':
			builder.WriteRune(r)
		default:
			builder.WriteByte('-')
		}
	}
	cleaned := strings.Trim(builder.String(), "-")
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		cleaned = "default"
	}
	if len(cleaned) > 48 {
		cleaned = cleaned[:48]
	}
	return cleaned
}

var (
	releaseTagPattern    = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][A-Za-z0-9-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][A-Za-z0-9-]*))*)?(\+[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*)?$`)
	releaseTagLooseChars = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._+-]*$`)
)

// releaseTagIsSafe reproduces install.sh:release_tag_is_safe. It rejects empty
// values, path-ish input, `.`/`..` and any value that requires build metadata
// without being valid SemVer.
func releaseTagIsSafe(tag string) bool {
	if tag == "" || len(tag) > 128 {
		return false
	}
	if strings.Contains(tag, "..") || strings.HasSuffix(tag, ".") || strings.HasSuffix(tag, ".lock") {
		return false
	}
	if !releaseTagLooseChars.MatchString(tag) {
		return false
	}
	if !strings.Contains(tag, "+") {
		return true
	}
	return releaseTagPattern.MatchString(tag)
}

// upgradeAssetName is the release asset filename for the current OS/arch.
func upgradeAssetName() string {
	arch := runtime.GOARCH
	switch arch {
	case "amd64", "arm64":
	case "arm":
		arch = "arm"
	default:
		arch = "amd64"
	}
	name := fmt.Sprintf("%s-%s-%s", upgradeBinaryName, upgradeGOOS, arch)
	if upgradeGOOS == "windows" {
		name += ".exe"
	}
	return name
}

// upgradeBinaryFilename is the on-disk filename of the installed agent.
func upgradeBinaryFilename() string {
	if upgradeGOOS == "windows" {
		return upgradeBinaryName + ".exe"
	}
	return upgradeBinaryName
}

// escapeReleaseTag encodes `+` (build metadata) for use in a URL path segment.
func escapeReleaseTag(tag string) string {
	return strings.ReplaceAll(tag, "+", "%2B")
}

// upgradeRepository resolves the release repository, honouring the operator
// override for forks.
func upgradeRepository() string {
	if override := strings.TrimSpace(os.Getenv("CF_MONITOR_RELEASE_REPOSITORY")); override != "" {
		if strings.Count(override, "/") == 1 && !strings.ContainsAny(override, " \t\n") {
			return override
		}
	}
	return defaultUpgradeRepository
}

// defaultReleaseBase builds the GitHub release base for a concrete tag, or the
// `latest/download` alias when the tag is empty or "latest".
func defaultReleaseBase(repository, tag string) string {
	if tag == "" || tag == "latest" {
		return fmt.Sprintf("https://github.com/%s/releases/latest/download", repository)
	}
	return fmt.Sprintf("https://github.com/%s/releases/download/%s", repository, escapeReleaseTag(tag))
}

// resolveUpgradePaths fills SERVICE_NAME / INSTALL_DIR / STATE_DIR / SERVICE_MODE
// from the instance id, mirroring install.sh apply_defaults so the supervisor's
// argv-derived defaults match what the installer created.
func resolveUpgradePaths(options *upgradeOptions) error {
	baseID := sanitizeUpgradeInstanceID(options.instanceID)
	if options.serviceName == "" {
		options.serviceName = "cf-vps-monitor-agent-" + baseID
	}
	if !agentServiceNameIsSafe(options.serviceName) {
		return fmt.Errorf("unsafe service name %q", options.serviceName)
	}
	if options.serviceMode == "" {
		options.serviceMode = agentUpgradeServiceMode()
	}
	switch options.serviceMode {
	case "systemd":
		if options.installDir == "" {
			options.installDir = "/opt/cf-vps-monitor/" + baseID
		}
		options.stateDir = filepath.Join(options.installDir, "state")
	case "openrc":
		if options.installDir == "" {
			options.installDir = "/opt/cf-vps-monitor/" + baseID
		}
		options.stateDir = filepath.Join(options.installDir, "state")
	case "launchctl":
		if options.installDir == "" {
			options.installDir = "/usr/local/cf-vps-monitor/" + baseID
		}
		options.stateDir = filepath.Join(options.installDir, "state")
	case "user":
		home := os.Getenv("HOME")
		dataHome := os.Getenv("XDG_DATA_HOME")
		if dataHome == "" && home != "" {
			dataHome = filepath.Join(home, ".local", "share")
		}
		if options.installDir == "" {
			options.installDir = filepath.Join(dataHome, "cf-vps-monitor", baseID)
		}
		stateHome := os.Getenv("XDG_STATE_HOME")
		if stateHome == "" && home != "" {
			stateHome = filepath.Join(home, ".local", "state")
		}
		options.stateDir = filepath.Join(stateHome, "cf-vps-monitor", baseID)
	case "windows":
		// Windows install path is resolved by the installer; the Agent only
		// delegates, so path defaults are not used here.
		if options.stateDir == "" {
			options.stateDir = upgradeStateDir()
		}
	default:
		if options.stateDir == "" {
			options.stateDir = upgradeStateDir()
		}
	}
	if options.stateDir == "" {
		options.stateDir = upgradeStateDir()
	}
	if options.repository == "" {
		options.repository = upgradeRepository()
	}
	if options.healthTimeout <= 0 {
		options.healthTimeout = defaultUpgradeHealthTimeout()
	}
	if options.healthFile == "" {
		options.healthFile = filepath.Join(options.stateDir, upgradeHealthFile)
	}
	return nil
}

// agentServiceNameIsSafe mirrors agent_service_name_is_safe.
func agentServiceNameIsSafe(name string) bool {
	if name == "" || name == "." || name == ".." || strings.HasPrefix(name, "-") {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9',
			r == '_', r == '.', r == '@', r == '-':
		default:
			return false
		}
	}
	return true
}

// agentUpgradeServiceMode detects the deployment style of the running Agent,
// mirroring install.sh:detect_service_mode. Used only to decide whether a root
// supervisor is required.
func agentUpgradeServiceMode() string {
	if override := strings.TrimSpace(os.Getenv("CF_MONITOR_SERVICE_MODE")); override != "" {
		switch override {
		case "systemd", "openrc", "launchctl", "user", "windows":
			return override
		}
	}
	switch upgradeGOOS {
	case "windows":
		return "windows"
	case "darwin":
		return "launchctl"
	}
	if commandExists("systemctl") && dirExists("/run/systemd/system") && commIsSystemd() {
		return "systemd"
	}
	if fileExists("/sbin/openrc-run") && fileExists("/run/openrc/softlevel") {
		return "openrc"
	}
	return "user"
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func commIsSystemd() bool {
	data, err := os.ReadFile("/proc/1/comm")
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(data)) == "systemd"
}

const upgradeHealthTimeoutEnv = "CF_MONITOR_UPGRADE_HEALTH_TIMEOUT"

func defaultUpgradeHealthTimeout() time.Duration {
	if raw := strings.TrimSpace(os.Getenv(upgradeHealthTimeoutEnv)); raw != "" {
		if seconds, err := parsePositiveSeconds(raw); err == nil {
			return seconds
		}
	}
	return 60 * time.Second
}

func parsePositiveSeconds(raw string) (time.Duration, error) {
	var seconds int
	if _, err := fmt.Sscanf(raw, "%d", &seconds); err != nil || seconds <= 0 {
		return 0, fmt.Errorf("invalid duration %q", raw)
	}
	return time.Duration(seconds) * time.Second, nil
}

// resolveTarget returns the concrete release tag to install, resolving "latest"
// (or an empty value) through a lightweight HEAD request that writes nothing.
func resolveTarget(options upgradeOptions) (string, error) {
	target := strings.TrimSpace(options.targetVersion)
	if target != "" && target != "latest" {
		if !releaseTagIsSafe(target) {
			return "", fmt.Errorf("%w: unsafe release tag %q", errInvalidTarget, target)
		}
		return target, nil
	}
	tag, err := resolveLatestReleaseTag(options)
	if err != nil {
		return "", err
	}
	return tag, nil
}

var errInvalidTarget = errors.New("invalid target")

// resolveLatestReleaseTag follows the GitHub `releases/latest` redirect and
// reads the concrete tag from the Location header without downloading a binary.
func resolveLatestReleaseTag(options upgradeOptions) (string, error) {
	repository := options.repository
	if repository == "" {
		repository = upgradeRepository()
	}
	raw := fmt.Sprintf("https://github.com/%s/releases/latest", repository)
	if options.ghProxy != "" {
		raw = options.ghProxy + "/" + raw
	}
	if err := validateUpgradeDownloadURL(raw); err != nil {
		return "", err
	}
	client := &http.Client{
		Timeout: 20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: upgradeTransport(options.proxy),
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodHead, raw, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "cf-vps-monitor-agent/"+Version)
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	location := response.Header.Get("Location")
	marker := "/releases/tag/"
	index := strings.Index(location, marker)
	if index < 0 {
		return "", fmt.Errorf("cannot resolve latest release tag from %q", location)
	}
	tag := location[index+len(marker):]
	if slash := strings.IndexAny(tag, "?#"); slash >= 0 {
		tag = tag[:slash]
	}
	if !releaseTagIsSafe(tag) {
		return "", fmt.Errorf("resolved unsafe tag %q", tag)
	}
	return tag, nil
}

// upgradeTransport builds an HTTP transport that honours an explicit proxy while
// otherwise falling back to the ambient environment.
var upgradeTransport = func(proxy string) http.RoundTripper {
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment}
	if proxy != "" {
		if parsed, err := url.Parse(proxy); err == nil {
			transport.Proxy = http.ProxyURL(parsed)
		}
	}
	return transport
}

// validateUpgradeDownloadURL allows signed HTTPS redirects, but never credentials
// or a protocol downgrade. Configuration URLs have separate stricter validation.
func validateUpgradeDownloadURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return errors.New("upgrade download must use an https:// URL without credentials")
	}
	return nil
}

func upgradeDownloadRedirect(request *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("too many upgrade download redirects")
	}
	return validateUpgradeDownloadURL(request.URL.String())
}

// downloadToFile streams a URL to a local path using the shared transport.
func downloadToFile(rawURL, destination string, options upgradeOptions) error {
	if err := validateUpgradeDownloadURL(rawURL); err != nil {
		return err
	}
	client := &http.Client{Timeout: 5 * time.Minute, Transport: upgradeTransport(options.proxy), CheckRedirect: upgradeDownloadRedirect}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "cf-vps-monitor-agent/"+Version)
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d fetching %s", response.StatusCode, rawURL)
	}
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(file, response.Body); err != nil {
		file.Close()
		os.Remove(destination)
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(destination)
		return err
	}
	return file.Close()
}

// checksumFor locates the expected lowercase SHA256 for a filename in a
// SHA256SUMS document, tolerating the `*` binary marker and any directory prefix.
func checksumFor(sums string, filename string) string {
	for _, line := range strings.Split(sums, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := strings.TrimPrefix(fields[len(fields)-1], "*")
		name = filepath.Base(name)
		if name == filename {
			return strings.ToLower(fields[0])
		}
	}
	return ""
}

// verifyChecksum enforces SHA256 equality against the published SHA256SUMS.
// There is deliberately no bypass: a missing entry or a mismatch is fatal.
func verifyChecksum(binaryPath, filename, sumsURL string, options upgradeOptions) error {
	sumsPath := filepath.Join(filepath.Dir(binaryPath), ".upgrade-sums."+filename)
	if err := downloadToFile(sumsURL, sumsPath, options); err != nil {
		return fmt.Errorf("download SHA256SUMS: %w", err)
	}
	data, err := os.ReadFile(sumsPath)
	os.Remove(sumsPath)
	if err != nil {
		return err
	}
	expected := checksumFor(string(data), filename)
	if expected == "" {
		return fmt.Errorf("%w: %s missing from SHA256SUMS", errChecksumMismatch, filename)
	}
	actual, err := sha256FileHex(binaryPath)
	if err != nil {
		return err
	}
	if actual != expected {
		return fmt.Errorf("%w: %s expected %s got %s", errChecksumMismatch, filename, expected, actual)
	}
	return nil
}

func sha256FileHex(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// downloadAndVerify downloads the target asset into the install directory as a
// sibling staging file, verifies SHA256SUMS, and marks it executable. The
// staging file shares the target's directory so the later rename is atomic.
func downloadAndVerify(options upgradeOptions, target, releaseBase string) (string, error) {
	base := releaseBase
	if base == "" {
		base = defaultReleaseBase(options.repository, target)
	}
	base = strings.TrimRight(base, "/")
	asset := upgradeAssetName()
	binaryURL := base + "/" + asset
	sumsURL := base + "/SHA256SUMS"

	staging := filepath.Join(options.installDir, fmt.Sprintf("%s.new.%d", upgradeBinaryFilename(), os.Getpid()))
	if err := downloadToFile(binaryURL, staging, options); err != nil {
		os.Remove(staging)
		return "", fmt.Errorf("download %s: %w", binaryURL, err)
	}
	if err := verifyChecksum(staging, asset, sumsURL, options); err != nil {
		os.Remove(staging)
		return "", err
	}
	if err := os.Chmod(staging, 0o755); err != nil {
		os.Remove(staging)
		return "", err
	}
	return staging, nil
}

// backupCurrent preserves the current binary as a single `.bak` sibling. The
// previous backup (if any) is overwritten — only the most recent is retained.
func backupCurrent(options upgradeOptions) (string, error) {
	target := filepath.Join(options.installDir, upgradeBinaryFilename())
	backup := target + upgradeBackupSuffix
	if err := copyFileMode(target, backup, 0o755); err != nil {
		return "", err
	}
	return backup, nil
}

// atomicReplace performs the same-directory rename that rebinds the path to a
// new inode without touching the running process's old inode.
func atomicReplace(source, destination string) error {
	return moveFileAtomic(source, destination)
}

// restartService delegates the init-system specific restart to the platform.
func restartService(options upgradeOptions) error {
	return platformRestartService(options.serviceMode, options.serviceName, options.installDir, options.stateDir)
}

// Overridable seams. Production initialises these to the real platform and
// self-replacement implementations; tests replace them to avoid touching the
// host service manager.
var (
	upgradeRestartService     = restartService
	upgradeServiceIsActive    = serviceActive
	upgradeSelfReplaceSupport = platformSupportsSelfReplace
)

// waitHealthy polls until the service is active and the beacon reports the
// target version with a report timestamp no older than the upgrade start.
func waitHealthy(options upgradeOptions, target string, startedAtMs int64) error {
	timeout := options.healthTimeout
	if timeout <= 0 {
		timeout = defaultUpgradeHealthTimeout()
	}
	deadline := time.Now().Add(timeout)
	for {
		if upgradeServiceIsActive(options.serviceMode, options.serviceName, options.stateDir) {
			if beacon, err := readAgentHealth(options.healthFile); err == nil {
				if beacon.Version == target && beacon.ReportedAtMs >= startedAtMs {
					return nil
				}
			}
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("agent did not report version %s within %s", target, timeout)
		}
		time.Sleep(time.Second)
	}
}

// rollback restores the backup into place and restarts the service, then waits
// for the (previous) version's beacon to reappear.
func rollback(options upgradeOptions, backup string) error {
	target := filepath.Join(options.installDir, upgradeBinaryFilename())
	staging := target + fmt.Sprintf(".new.%d", os.Getpid())
	if err := copyFileMode(backup, staging, 0o755); err != nil {
		return err
	}
	if err := moveFileAtomic(staging, target); err != nil {
		os.Remove(staging)
		return err
	}
	if err := upgradeRestartService(options); err != nil {
		return err
	}
	deadline := time.Now().Add(options.healthTimeout)
	for {
		if upgradeServiceIsActive(options.serviceMode, options.serviceName, options.stateDir) {
			if beacon, err := readAgentHealth(options.healthFile); err == nil && beacon.Version == Version {
				return nil
			}
			// A successful restart with the previous version on disk is enough
			// even when a fresh beacon has not landed yet.
			if !time.Now().Before(deadline) {
				return nil
			}
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("previous version did not recover within %s", options.healthTimeout)
		}
		time.Sleep(time.Second)
	}
}

// cleanup removes the temporary staging artifact, leaving the retained `.bak`.
func cleanup(options upgradeOptions) {
	pattern := filepath.Join(options.installDir, upgradeBinaryName+".new.*")
	if options.serviceMode == "windows" {
		pattern = filepath.Join(options.installDir, upgradeBinaryName+".exe.new.*")
	}
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return
	}
	for _, match := range matches {
		_ = os.Remove(match)
	}
}

// copyFileMode copies source to destination, applying mode, and replacing any
// existing file atomically via a same-directory temporary.
func copyFileMode(source, destination string, mode os.FileMode) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(destination), "."+filepath.Base(destination)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := moveFileAtomic(tmpName, destination); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

// applyUpgrade runs the full download → verify → backup → replace → restart →
// health-confirm pipeline with automatic rollback, and returns the result.
//
// Idempotency: when the target equals the running version it returns
// already_latest without downloading, restarting, or touching any file.
func applyUpgrade(options upgradeOptions, task upgradeTask) upgradeResult {
	// The task is authoritative for the target; the supervisor/CLI may also have
	// resolved it onto the options, but the task always wins.
	if strings.TrimSpace(task.TargetVersion) != "" {
		options.targetVersion = task.TargetVersion
	}
	if options.repository == "" {
		options.repository = upgradeRepository()
	}
	started := time.Now()
	result := upgradeResult{
		CommandID:     task.ID,
		TargetVersion: task.TargetVersion,
		FromVersion:   Version,
		FinalVersion:  Version,
		StartedAtMs:   started.UnixMilli(),
	}
	finish := func(status, code, reason string) upgradeResult {
		result.Status = status
		result.FailureCode = code
		result.Reason = reason
		result.FinishedAtMs = time.Now().UnixMilli()
		logUpgrade("%s", formatUpgradeLog(result))
		return result
	}

	if options.installDir == "" {
		if err := resolveUpgradePaths(&options); err != nil {
			return finish(upgradeStatusFailed, upgradeFailureInvalidTarget, err.Error())
		}
	}
	if err := os.MkdirAll(options.installDir, 0o755); err != nil {
		return finish(upgradeStatusFailed, upgradeFailureStagingFailed, err.Error())
	}

	target, err := resolveTarget(options)
	if err != nil {
		if errors.Is(err, errInvalidTarget) {
			return finish(upgradeStatusFailed, upgradeFailureInvalidTarget, err.Error())
		}
		return finish(upgradeStatusFailed, upgradeFailureProbeFailed, err.Error())
	}
	result.TargetVersion = target

	// Idempotent no-op: never download, restart, or mutate anything.
	if target == Version {
		result.FinalVersion = Version
		return finish(upgradeStatusAlreadyLatest, "", "already at target version")
	}

	staging, err := downloadAndVerify(options, target, task.ReleaseBase)
	if err != nil {
		code := upgradeFailureDownloadFailed
		if errors.Is(err, errChecksumMismatch) {
			code = upgradeFailureChecksumMismatch
		}
		cleanup(options)
		return finish(upgradeStatusFailed, code, err.Error())
	}

	backup, err := backupCurrent(options)
	if err != nil {
		cleanup(options)
		return finish(upgradeStatusFailed, upgradeFailureStagingFailed, err.Error())
	}

	targetPath := filepath.Join(options.installDir, upgradeBinaryFilename())
	if err := atomicReplace(staging, targetPath); err != nil {
		cleanup(options)
		return finish(upgradeStatusFailed, upgradeFailureReplaceFailed, err.Error())
	}

	if err := upgradeRestartService(options); err != nil {
		if rbErr := rollback(options, backup); rbErr != nil {
			cleanup(options)
			return finish(upgradeStatusFailed, upgradeFailureRollbackFailed, fmt.Sprintf("restart failed: %v; rollback failed: %v", err, rbErr))
		}
		cleanup(options)
		return finish(upgradeStatusRolledBack, upgradeFailureRestartFailed, err.Error())
	}

	if err := waitHealthy(options, target, result.StartedAtMs); err != nil {
		if rbErr := rollback(options, backup); rbErr != nil {
			cleanup(options)
			return finish(upgradeStatusFailed, upgradeFailureRollbackFailed, fmt.Sprintf("health check failed: %v; rollback failed: %v", err, rbErr))
		}
		cleanup(options)
		return finish(upgradeStatusRolledBack, upgradeFailureHealthTimeout, err.Error())
	}

	cleanup(options)
	result.FinalVersion = target
	return finish(upgradeStatusSuccess, "", "upgrade verified")
}

// upgradeManager tracks panel-issued upgrade tasks and the results waiting to be
// reported from the Agent runtime. It never blocks the report loop.
type upgradeManager struct {
	mu          sync.Mutex
	pending     []upgradeResult
	queuedIDs   map[string]bool
	reportedIDs map[string]bool
}

var upgradeRuntime = &upgradeManager{
	queuedIDs:   map[string]bool{},
	reportedIDs: map[string]bool{},
}

// processTasks reacts to server-issued upgrade tasks. For the target-equals-
// current case it records already_latest immediately (zero side effects). For a
// real upgrade it either writes a request file for the root supervisor
// (systemd/openrc) or spawns a detached self-apply (launchctl/user/windows).
func (m *upgradeManager) processTasks(tasks []upgradeTask) {
	if len(tasks) == 0 {
		return
	}
	options := agentRuntimeUpgradeOptions()
	if err := resolveUpgradePaths(&options); err != nil {
		logUpgrade("cannot resolve instance paths: %v", err)
		return
	}
	for _, task := range tasks {
		if strings.TrimSpace(task.ID) == "" {
			continue
		}
		m.mu.Lock()
		if m.queuedIDs[task.ID] {
			m.mu.Unlock()
			continue
		}
		m.queuedIDs[task.ID] = true
		m.mu.Unlock()

		target := strings.TrimSpace(task.TargetVersion)
		if target != "" && target != "latest" && target == Version {
			m.enqueue(upgradeResult{
				CommandID:     task.ID,
				TargetVersion: target,
				FromVersion:   Version,
				FinalVersion:  Version,
				Status:        upgradeStatusAlreadyLatest,
				Reason:        "already at target version",
				StartedAtMs:   time.Now().UnixMilli(),
				FinishedAtMs:  time.Now().UnixMilli(),
			})
			continue
		}

		requestOptions := options
		requestOptions.targetVersion = target
		requestOptions.releaseBase = task.ReleaseBase
		requestOptions.proxy = firstNonEmpty(task.Proxy, options.proxy)
		requestOptions.ghProxy = firstNonEmpty(task.GhProxy, options.ghProxy)

		switch options.serviceMode {
		case "systemd", "openrc":
			if !supervisorUnitPresent(options.serviceMode, options.serviceName) {
				m.enqueue(upgradeResult{
					CommandID:     task.ID,
					TargetVersion: target,
					FromVersion:   Version,
					FinalVersion:  Version,
					Status:        upgradeStatusFailed,
					FailureCode:   upgradeFailureUnsupportedPlatform,
					Reason:        "root upgrade supervisor is not installed; run the installer once to enable panel-driven upgrades",
					StartedAtMs:   time.Now().UnixMilli(),
					FinishedAtMs:  time.Now().UnixMilli(),
				})
				continue
			}
			request := upgradeRequest{
				CommandID:     task.ID,
				TargetVersion: target,
				ReleaseBase:   task.ReleaseBase,
				Proxy:         requestOptions.proxy,
				GhProxy:       requestOptions.ghProxy,
				RequestedAtMs: time.Now().UnixMilli(),
			}
			if err := writeUpgradeRequest(options.stateDir, request); err != nil {
				m.enqueue(upgradeResult{
					CommandID:     task.ID,
					TargetVersion: target,
					FromVersion:   Version,
					FinalVersion:  Version,
					Status:        upgradeStatusFailed,
					FailureCode:   upgradeFailureProbeFailed,
					Reason:        err.Error(),
					StartedAtMs:   time.Now().UnixMilli(),
					FinishedAtMs:  time.Now().UnixMilli(),
				})
			}
		default:
			writeUpgradeRequestIfPossible(options.stateDir, task)
			if err := spawnDetachedUpgradeApply(options); err != nil {
				m.enqueue(upgradeResult{
					CommandID:     task.ID,
					TargetVersion: target,
					FromVersion:   Version,
					FinalVersion:  Version,
					Status:        upgradeStatusFailed,
					FailureCode:   upgradeFailureUnsupportedPlatform,
					Reason:        err.Error(),
					StartedAtMs:   time.Now().UnixMilli(),
					FinishedAtMs:  time.Now().UnixMilli(),
				})
			}
		}
	}
}

func writeUpgradeRequestIfPossible(stateDir string, task upgradeTask) {
	if stateDir == "" {
		return
	}
	request := upgradeRequest{
		CommandID:     task.ID,
		TargetVersion: strings.TrimSpace(task.TargetVersion),
		ReleaseBase:   task.ReleaseBase,
		Proxy:         task.Proxy,
		GhProxy:       task.GhProxy,
		RequestedAtMs: time.Now().UnixMilli(),
	}
	_ = writeUpgradeRequest(stateDir, request)
}

// refreshResultFile folds a supervisor-written result into the pending queue.
func (m *upgradeManager) refreshResultFile() {
	stateDir := upgradeStateDir()
	if stateDir == "" {
		return
	}
	result, err := readUpgradeResult(stateDir)
	if err != nil || strings.TrimSpace(result.CommandID) == "" || strings.HasPrefix(result.CommandID, "cli-") || result.Status == "" {
		return
	}
	m.mu.Lock()
	if !m.reportedIDs[result.CommandID] {
		m.reportedIDs[result.CommandID] = true
		m.pending = append(m.pending, result)
	}
	m.mu.Unlock()
}

func (m *upgradeManager) enqueue(result upgradeResult) {
	m.mu.Lock()
	if !m.reportedIDs[result.CommandID] {
		m.reportedIDs[result.CommandID] = true
		m.pending = append(m.pending, result)
	}
	m.mu.Unlock()
}

// snapshot returns the results to attach to the next report, refreshing from the
// supervisor result file first.
func (m *upgradeManager) snapshot() []upgradeResult {
	m.refreshResultFile()
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.pending) == 0 {
		return nil
	}
	out := make([]upgradeResult, min(len(m.pending), maxUpgradeResultsPerEnvelope))
	copy(out, m.pending)
	return out
}

// The latest disk result is intentionally retained for restart/idempotent
// replay. Acknowledging one upload must not unlink a newer supervisor result.

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
