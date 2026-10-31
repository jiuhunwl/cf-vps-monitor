package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// upgradeInvocation enumerates how the process was asked to act on upgrades.
type upgradeInvocation int

const (
	upgradeNone upgradeInvocation = iota
	upgradeVersion
	upgradeSubcommand
	upgradeApply
	upgradeSupervisor
)

// Package-level upgrade flags registered on the default flag set. They let the
// long-running Agent learn its instance identity and health beacon path so the
// in-process upgrade manager can act on panel-issued tasks. Defaults are inert:
// with no upgrade activity, behaviour is unchanged.
var (
	upgradeFlagReleaseTag    string
	upgradeFlagInstanceID    string
	upgradeFlagInstallDir    string
	upgradeFlagServiceName   string
	upgradeFlagInstallMode   string
	upgradeFlagServiceMode   string
	upgradeFlagHealthTimeout int
	upgradeFlagHealthFile    string
	upgradeFlagProxy         string
	upgradeFlagGhProxy       string
	upgradeFlagGhProxyAllow  string
)

// registerUpgradeFlags wires the upgrade-related flags onto the default flag
// set. It is called from init() so `--help` lists them alongside the existing
// options without changing any existing flag's semantics.
func registerUpgradeFlags() {
	flag.StringVar(&upgradeFlagReleaseTag, "release-tag", "", "Target release tag for the upgrade path (empty = latest)")
	flag.StringVar(&upgradeFlagInstanceID, "instance-id", "default", "Instance id used to derive default upgrade paths")
	flag.StringVar(&upgradeFlagInstallDir, "install-dir", "", "Install directory for the upgrade path")
	flag.StringVar(&upgradeFlagServiceName, "service-name", "", "Service name for the upgrade path")
	flag.StringVar(&upgradeFlagInstallMode, "install-mode", "", "Install mode for the upgrade path (auto, system, user)")
	flag.StringVar(&upgradeFlagServiceMode, "service-mode", "", "Init system for the upgrade path (systemd, openrc, launchctl, user, windows)")
	flag.IntVar(&upgradeFlagHealthTimeout, "upgrade-health-timeout", 0, "Seconds to wait for the restarted Agent to report the target version")
	flag.StringVar(&upgradeFlagHealthFile, "health-file", "", "Path to the Agent health beacon (default: <state dir>/agent-health.json)")
	flag.StringVar(&upgradeFlagProxy, "proxy", "", "HTTP(S) proxy used for upgrades")
	flag.StringVar(&upgradeFlagGhProxy, "install-ghproxy", "", "GitHub proxy prefix used for upgrades")
	flag.StringVar(&upgradeFlagGhProxyAllow, "install-ghproxy-allowlist", "", "Comma-separated GitHub proxy prefixes the panel may select for upgrades")
	// Intercepted before flag.Parse; declared so -h remains informative.
	flag.Bool("upgrade-supervisor", false, "Run the root upgrade supervisor (intercepted before flag parsing)")
	flag.Bool("upgrade-apply", false, "Apply one upgrade request as root (intercepted before flag parsing)")
	flag.Bool("once", false, "With --upgrade-supervisor, process a single request and exit")
	flag.Bool("version", false, "Print the Agent version and exit")
}

// handleUpgradeCLI intercepts upgrade invocations before normal flag parsing and
// Agent initialisation, exactly like handleDirectoryCollectorCLI. It returns
// (handled, exitCode); when handled is false the caller continues unchanged.
func handleUpgradeCLI(args []string, stdout, stderr io.Writer) (bool, int) {
	invocation := detectUpgradeInvocation(args)
	if invocation == upgradeNone {
		return false, 0
	}
	if invocation == upgradeVersion {
		fmt.Fprintln(stdout, Version)
		return true, 0
	}

	// 监督/应用调用由单元文件（最新安装器写出）驱动，执行的可能是稍旧的
	// 二进制：未知旗标必须在解析前跳过而不是让进程退出，否则一次重烘焙就
	// 打死所有下发的升级。人类手敲的 `upgrade` 子命令保持快速报错（防手滑）。
	if invocation == upgradeSupervisor || invocation == upgradeApply {
		args = filterUnknownUpgradeFlags(args)
	}

	options, once, err := parseUpgradeOptions(args, stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return true, 0
		}
		logUpgrade("%v", err)
		return true, 2
	}

	switch invocation {
	case upgradeApply:
		return true, runUpgradeApply(options, stdout, stderr)
	case upgradeSupervisor:
		return true, runUpgradeSupervisor(options, once, stdout, stderr)
	case upgradeSubcommand:
		return true, runUpgradeSubcommand(options, stdout, stderr)
	default:
		return false, 0
	}
}

// detectUpgradeInvocation scans the arguments for an upgrade entry point. It
// never mistakes a flag value for the bare `upgrade` subcommand: only args[0]
// can be that subcommand.
func detectUpgradeInvocation(args []string) upgradeInvocation {
	hasVersion, hasApply, hasSupervisor := false, false, false
	for _, argument := range args {
		if argument == "--" {
			break
		}
		if !strings.HasPrefix(argument, "-") {
			continue
		}
		name, _, _ := strings.Cut(strings.TrimLeft(argument, "-"), "=")
		switch name {
		case "version":
			hasVersion = true
		case "upgrade-apply":
			hasApply = true
		case "upgrade-supervisor":
			hasSupervisor = true
		}
	}
	switch {
	case hasApply:
		return upgradeApply
	case hasSupervisor:
		return upgradeSupervisor
	case hasVersion:
		return upgradeVersion
	case len(args) > 0 && args[0] == "upgrade":
		return upgradeSubcommand
	default:
		return upgradeNone
	}
}

// upgradeStringFlags / upgradeBoolFlags enumerate the flags parseUpgradeOptions
// registers. The tolerant pre-filter drops anything else (with its standalone
// value) so unit files written by a newer installer never hard-fail an older
// binary's supervisor/apply invocation.
var upgradeStringFlags = map[string]bool{
	"release-tag": true, "release-base": true, "instance-id": true,
	"install-dir": true, "service-name": true, "install-mode": true,
	"mode": true, "service-mode": true, "health-file": true,
	"state-dir": true, "proxy": true, "install-ghproxy": true,
	"install-ghproxy-allowlist": true, "health-timeout": true,
	"upgrade-health-timeout": true,
}

var upgradeBoolFlags = map[string]bool{
	"upgrade-apply": true, "upgrade-supervisor": true,
	"once": true, "version": true, "h": true, "help": true,
}

// filterUnknownUpgradeFlags drops flags that this binary's flag set does not
// know (with their standalone values), so unit files written by a newer
// installer never hard-fail an older binary's supervisor/apply invocation.
// Only machine-written invocations go through this; the human-facing `upgrade`
// subcommand keeps fail-fast typo protection.
func filterUnknownUpgradeFlags(args []string) []string {
	if len(args) == 0 {
		return args
	}
	filtered := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" || !strings.HasPrefix(arg, "-") {
			filtered = append(filtered, arg)
			continue
		}
		name := strings.TrimLeft(arg, "-")
		inline := false
		if eq := strings.Index(name, "="); eq >= 0 {
			name = name[:eq]
			inline = true
		}
		if upgradeStringFlags[name] || upgradeBoolFlags[name] {
			filtered = append(filtered, arg)
			// 独立值形式的字符串旗标：把它的值也原样保留。
			if !inline && upgradeStringFlags[name] && i+1 < len(args) {
				i++
				filtered = append(filtered, args[i])
			}
			continue
		}
		// 未知旗标：连同独立值一起丢弃（值形态 `-x v` 的 v 不会以 - 开头）。
		if !inline && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			i++
		}
	}
	return filtered
}

// parseUpgradeOptions builds the option set from the dedicated flag set. Because
// this runs before flag.Parse, the main flag set is untouched.
func parseUpgradeOptions(args []string, stderr io.Writer) (upgradeOptions, bool, error) {
	options := upgradeOptions{}
	if len(args) > 0 && args[0] == "upgrade" {
		args = args[1:]
	}
	var (
		once             bool
		healthTimeoutSec int
		serviceModeAlias string
	)
	flags := flag.NewFlagSet("upgrade", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.StringVar(&options.targetVersion, "release-tag", "", "Target release tag (empty = latest)")
	flags.StringVar(&options.releaseBase, "release-base", "", "Release base URL override")
	flags.StringVar(&options.instanceID, "instance-id", "default", "Instance id")
	flags.StringVar(&options.installDir, "install-dir", "", "Install directory")
	flags.StringVar(&options.serviceName, "service-name", "", "Service name")
	flags.StringVar(&options.installMode, "install-mode", "", "Install mode (auto, system, user)")
	flags.StringVar(&options.serviceMode, "mode", "", "Init system (systemd, openrc, launchctl, user, windows)")
	flags.StringVar(&serviceModeAlias, "service-mode", "", "Alias for --mode")
	flags.IntVar(&healthTimeoutSec, "health-timeout", 0, "Seconds to wait for the restarted Agent")
	flags.IntVar(&healthTimeoutSec, "upgrade-health-timeout", 0, "Alias for --health-timeout")
	flags.StringVar(&options.healthFile, "health-file", "", "Health beacon path")
	flags.StringVar(&options.stateDir, "state-dir", "", "State directory")
	flags.StringVar(&options.proxy, "proxy", "", "HTTP(S) proxy")
	flags.StringVar(&options.ghProxy, "install-ghproxy", "", "GitHub proxy prefix")
	flags.StringVar(&options.ghProxyAllowlistRaw, "install-ghproxy-allowlist", "", "Comma-separated GitHub proxy prefixes the panel may select")
	flags.Bool("upgrade-apply", false, "Apply one upgrade request")
	flags.Bool("upgrade-supervisor", false, "Run the upgrade supervisor")
	flags.BoolVar(&once, "once", false, "Process one request then exit")
	flags.Bool("version", false, "Print version")
	if err := flags.Parse(args); err != nil {
		return options, once, err
	}
	if flags.NArg() != 0 {
		return options, once, fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}
	if options.serviceMode == "" {
		options.serviceMode = serviceModeAlias
	}
	if healthTimeoutSec > 0 {
		options.healthTimeout = time.Duration(healthTimeoutSec) * time.Second
	}

	normalizedProxy, err := normalizeProxyURL("--proxy", options.proxy)
	if err != nil {
		return options, once, err
	}
	options.proxy = normalizedProxy
	normalizedGhProxy, err := normalizeProxyURL("--install-ghproxy", options.ghProxy)
	if err != nil {
		return options, once, err
	}
	options.ghProxy = normalizedGhProxy
	if err := requireHTTPSURL("--install-ghproxy", options.ghProxy); err != nil {
		return options, once, err
	}
	allowlist, err := parseGhProxyAllowlist("--install-ghproxy-allowlist", options.ghProxyAllowlistRaw)
	if err != nil {
		return options, once, err
	}
	options.ghProxyAllowlist = allowlist
	if err := requireHTTPSURL("--release-base", options.releaseBase); err != nil {
		return options, once, err
	}
	if options.targetVersion != "" && options.targetVersion != "latest" && !releaseTagIsSafe(options.targetVersion) {
		return options, once, fmt.Errorf("--release-tag must be a safe tag of at most 128 ASCII characters")
	}
	return options, once, nil
}

// runUpgradeApply executes one upgrade request as the current user/root. On
// Windows it delegates to install-windows.ps1 because a running .exe cannot be
// replaced.
func runUpgradeApply(options upgradeOptions, stdout, stderr io.Writer) int {
	if err := resolveUpgradePaths(&options); err != nil {
		fmt.Fprintf(stderr, "upgrade: %v\n", err)
		return 1
	}
	task, err := loadApplyTask(&options)
	if err != nil {
		writeMiscUpgradeResult(options, upgradeStatusFailed, upgradeFailureInvalidTarget, err.Error())
		fmt.Fprintf(stderr, "upgrade: %v\n", err)
		return 1
	}
	result := runPlatformUpgrade(options, task)
	if err := writeUpgradeResult(options.stateDir, result); err != nil {
		fmt.Fprintf(stderr, "upgrade: cannot write result: %v\n", err)
	}
	fmt.Fprintln(stdout, formatUpgradeLog(result))
	return exitCodeForResult(result)
}

// runUpgradeSupervisor is the root supervisor entry point. With --once it
// processes a single request (driven by a systemd path unit); otherwise it polls
// (openrc has no path units).
func runUpgradeSupervisor(options upgradeOptions, once bool, stdout, stderr io.Writer) int {
	if err := resolveUpgradePaths(&options); err != nil {
		fmt.Fprintf(stderr, "upgrade: %v\n", err)
		return 1
	}
	lock, err := acquireUpgradeLock(options)
	if err != nil {
		logUpgrade("supervisor cannot acquire lock: %v", err)
		return 1
	}
	defer lock.Release()

	for {
		handled, err := superviseOnce(options, stderr)
		if err != nil {
			logUpgrade("supervisor iteration failed: %v", err)
			if once {
				return 1
			}
		}
		if once {
			if !handled {
				return 0
			}
			return 0
		}
		time.Sleep(5 * time.Second)
	}
}

// superviseOnce processes a single pending request if one exists.
func superviseOnce(options upgradeOptions, stderr io.Writer) (bool, error) {
	request, err := readUpgradeRequest(options.stateDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	if strings.TrimSpace(request.CommandID) == "" || strings.TrimSpace(request.TargetVersion) == "" {
		_ = writeUpgradeResult(options.stateDir, upgradeResult{
			CommandID:    request.CommandID,
			Status:       upgradeStatusFailed,
			FailureCode:  upgradeFailureInvalidTarget,
			Reason:       "request is missing command_id or target_version",
			StartedAtMs:  time.Now().UnixMilli(),
			FinishedAtMs: time.Now().UnixMilli(),
		})
		_ = removeUpgradeRequest(options.stateDir)
		return true, nil
	}
	if err := validateUpgradeRequest(request); err != nil {
		_ = writeUpgradeResult(options.stateDir, upgradeResult{
			CommandID:     request.CommandID,
			TargetVersion: request.TargetVersion,
			FromVersion:   Version,
			FinalVersion:  Version,
			Status:        upgradeStatusFailed,
			FailureCode:   upgradeFailureInvalidTarget,
			Reason:        err.Error(),
			StartedAtMs:   time.Now().UnixMilli(),
			FinishedAtMs:  time.Now().UnixMilli(),
		})
		_ = removeUpgradeRequest(options.stateDir)
		logUpgrade("supervisor rejected request: %v", err)
		return true, nil
	}

	opts := options
	opts.commandID = request.CommandID
	opts.targetVersion = request.TargetVersion
	if supplied := requestOriginFields(request); supplied != "" {
		logUpgrade("ignoring request-supplied download origin [%s]; the supervisor trusts only its own argv", supplied)
	}
	task := supervisorTask(opts, request)
	result := runPlatformUpgrade(opts, task)
	if result.CommandID == "" {
		result.CommandID = request.CommandID
	}
	if err := writeUpgradeResult(options.stateDir, result); err != nil {
		fmt.Fprintf(stderr, "upgrade: cannot write result: %v\n", err)
		return true, err
	}
	if err := removeUpgradeRequest(options.stateDir); err != nil {
		logUpgrade("supervisor could not remove request: %v", err)
	}
	return true, nil
}

// supervisorTask assembles the work item for a privileged upgrade. Only
// command_id and target_version are taken from the request; the download origin
// (release base, proxy, ghproxy) always comes from options — that is, from the
// argv of the process the installer launched as root.
//
// Why this matters: upgrade-request.json lives in $STATE_DIR, which install.sh
// chowns to the unprivileged agent user, so its contents are attacker-chosen.
// If the request could redirect the download, a rogue agent user would point
// release_base at a host serving both a malicious binary and a SHA256SUMS that
// matches it. Checksum verification cannot detect an attacker-chosen origin, so
// the substitution would pass every check — and the replaced binary is then
// executed as root by the disk-usage collector unit (User=root). That would
// defeat the NoNewPrivileges/ProtectSystem sandbox the systemd unit sets up.
func supervisorTask(options upgradeOptions, request upgradeRequest) upgradeTask {
	commandID := strings.TrimSpace(request.CommandID)
	if commandID == "" {
		commandID = options.commandID
	}
	// request 文件由非 root Agent 写入，下载来源默认只认 argv；唯一例外是
	// 面板下发的 ghproxy 命中了安装器批准的白名单——文件写入者只能在 root
	// 批准的镜像里选择，无法把下载指向任意主机。未命中则回退 argv 默认值。
	ghProxy := options.ghProxy
	if requested := strings.TrimSpace(request.GhProxy); requested != "" && requested != ghProxy && ghProxyAllowlisted(options, requested) {
		ghProxy = requested
	}
	return upgradeTask{
		ID:            commandID,
		TargetVersion: request.TargetVersion,
		ReleaseBase:   options.releaseBase,
		Proxy:         options.proxy,
		GhProxy:       ghProxy,
	}
}

// ghProxyAllowlisted reports whether the panel-requested accelerator was
// approved by the root-side installer argv. An empty allowlist keeps the
// historical "argv only" behaviour for units installed before the flag existed.
func ghProxyAllowlisted(options upgradeOptions, candidate string) bool {
	for _, allowed := range options.ghProxyAllowlist {
		if allowed == candidate {
			return true
		}
	}
	return false
}

// parseGhProxyAllowlist splits and validates the comma-separated allowlist.
// Empty segments are dropped so trailing commas never smuggle an entry in.
func parseGhProxyAllowlist(flagName, raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var allowlist []string
	for _, segment := range strings.Split(raw, ",") {
		entry := strings.TrimSpace(segment)
		if entry == "" {
			continue
		}
		normalized, err := normalizeProxyURL(flagName, entry)
		if err != nil {
			return nil, err
		}
		if err := requireHTTPSURL(flagName, normalized); err != nil {
			return nil, err
		}
		allowlist = append(allowlist, normalized)
	}
	return allowlist, nil
}

// requestOriginFields names the download-origin fields a request attempted to
// set. They are reported for diagnostics and then discarded, never honoured.
func requestOriginFields(request upgradeRequest) string {
	var names []string
	if strings.TrimSpace(request.ReleaseBase) != "" {
		names = append(names, "release_base")
	}
	if strings.TrimSpace(request.Proxy) != "" {
		names = append(names, "proxy")
	}
	if strings.TrimSpace(request.GhProxy) != "" {
		names = append(names, "ghproxy")
	}
	return strings.Join(names, ",")
}

// runUpgradeSubcommand implements the bare `upgrade` subcommand. On systemd and
// openrc it enqueues the request for the root supervisor and waits for the
// result; on launchctl/user it applies directly.
func runUpgradeSubcommand(options upgradeOptions, stdout, stderr io.Writer) int {
	if err := resolveUpgradePaths(&options); err != nil {
		fmt.Fprintf(stderr, "upgrade: %v\n", err)
		return 1
	}
	options.commandID = newUpgradeCommandID()
	switch options.serviceMode {
	case "systemd", "openrc":
		if !supervisorUnitPresent(options.serviceMode, options.serviceName) {
			fmt.Fprintf(stderr, "upgrade: root upgrade supervisor is not installed; run the installer once to enable panel-driven upgrades\n")
			return 1
		}
		request := upgradeRequest{
			CommandID:     options.commandID,
			TargetVersion: options.targetVersion,
			ReleaseBase:   options.releaseBase,
			Proxy:         options.proxy,
			GhProxy:       options.ghProxy,
			RequestedAtMs: time.Now().UnixMilli(),
		}
		if err := writeUpgradeRequest(options.stateDir, request); err != nil {
			fmt.Fprintf(stderr, "upgrade: cannot enqueue request: %v\n", err)
			return 1
		}
		result, err := waitForUpgradeResult(options)
		if err != nil {
			fmt.Fprintf(stderr, "upgrade: %v\n", err)
			return 1
		}
		fmt.Fprintln(stdout, formatUpgradeLog(result))
		return exitCodeForResult(result)
	default:
		return runUpgradeApply(options, stdout, stderr)
	}
}

// waitForUpgradeResult polls for the supervisor-produced result matching this
// command id, honouring the health timeout with a generous margin.
func waitForUpgradeResult(options upgradeOptions) (upgradeResult, error) {
	timeout := options.healthTimeout
	if timeout <= 0 {
		timeout = defaultUpgradeHealthTimeout()
	}
	deadline := time.Now().Add(timeout + 2*time.Minute)
	for {
		if result, err := readUpgradeResult(options.stateDir); err == nil {
			if result.CommandID == options.commandID {
				return result, nil
			}
		}
		if !time.Now().Before(deadline) {
			return upgradeResult{}, errors.New("timed out waiting for the upgrade supervisor")
		}
		time.Sleep(2 * time.Second)
	}
}

// runPlatformUpgrade routes to self-replacement or installer delegation.
func runPlatformUpgrade(options upgradeOptions, task upgradeTask) upgradeResult {
	if upgradeSelfReplaceSupport() {
		return applyUpgrade(options, task)
	}
	return delegateUpgradeToInstaller(options)
}

// loadApplyTask builds the task from explicit flags or the pending request file.
func loadApplyTask(options *upgradeOptions) (upgradeTask, error) {
	if strings.TrimSpace(options.targetVersion) != "" {
		return upgradeTask{
			ID:            options.commandID,
			TargetVersion: options.targetVersion,
			ReleaseBase:   options.releaseBase,
			Proxy:         options.proxy,
			GhProxy:       options.ghProxy,
		}, nil
	}
	request, err := readUpgradeRequest(options.stateDir)
	if err != nil {
		return upgradeTask{}, fmt.Errorf("no --release-tag and no upgrade request found: %w", err)
	}
	if options.commandID == "" {
		options.commandID = request.CommandID
	}
	options.targetVersion = request.TargetVersion
	if supplied := requestOriginFields(request); supplied != "" {
		logUpgrade("ignoring request-supplied download origin [%s]; only argv-provided origins are trusted", supplied)
	}
	return supervisorTask(*options, request), nil
}

func writeMiscUpgradeResult(options upgradeOptions, status, code, reason string) {
	if options.stateDir == "" {
		return
	}
	_ = writeUpgradeResult(options.stateDir, upgradeResult{
		CommandID:    options.commandID,
		Status:       status,
		FailureCode:  code,
		Reason:       reason,
		FromVersion:  Version,
		FinalVersion: Version,
		StartedAtMs:  time.Now().UnixMilli(),
		FinishedAtMs: time.Now().UnixMilli(),
	})
}

// validateUpgradeRequest enforces the request-file allowlist. Neither the paths
// nor the download origin are honoured from the request — only target_version
// drives behaviour. The origin fields are still shape-checked as defence in
// depth, so a malformed request fails loudly instead of being silently dropped.
func validateUpgradeRequest(request upgradeRequest) error {
	target := strings.TrimSpace(request.TargetVersion)
	if target == "" {
		return errors.New("target_version is required")
	}
	if target != "latest" && !releaseTagIsSafe(target) {
		return fmt.Errorf("unsafe target_version %q", target)
	}
	if err := requireHTTPSURL("release_base", request.ReleaseBase); err != nil {
		return err
	}
	if _, err := normalizeProxyURL("proxy", request.Proxy); err != nil {
		return err
	}
	if err := requireHTTPSURL("ghproxy", request.GhProxy); err != nil {
		return err
	}
	return nil
}

// requireHTTPSURL mirrors install.sh:require_https_url.
func requireHTTPSURL(name, value string) error {
	if value == "" {
		return nil
	}
	if !strings.HasPrefix(value, "https://") {
		return fmt.Errorf("%s must use an https:// URL", name)
	}
	if strings.ContainsAny(value, " \t\n\r@?#") {
		return fmt.Errorf("%s must not contain credentials, query, fragment, or whitespace", name)
	}
	return nil
}

// normalizeProxyURL mirrors install.sh:normalize_proxy_url.
func normalizeProxyURL(name, value string) (string, error) {
	value = strings.TrimRight(value, "/")
	if value == "" {
		return "", nil
	}
	if !strings.HasPrefix(value, "http://") && !strings.HasPrefix(value, "https://") {
		return "", fmt.Errorf("%s must use an http:// or https:// URL", name)
	}
	if strings.ContainsAny(value, " \t\n\r@?#") {
		return "", fmt.Errorf("%s must not contain credentials, query, fragment, or whitespace", name)
	}
	return value, nil
}

// upgradeApplyArgs renders the args for a detached self-apply invocation.
func upgradeApplyArgs(options upgradeOptions) []string {
	args := []string{
		"--upgrade-apply",
		"--state-dir", options.stateDir,
		"--install-dir", options.installDir,
		"--service-name", options.serviceName,
		"--health-file", options.healthFile,
		"--health-timeout", strconv.Itoa(int(options.healthTimeout / time.Second)),
	}
	if options.serviceMode != "" {
		args = append(args, "--service-mode", options.serviceMode)
	}
	if len(options.ghProxyAllowlist) > 0 {
		args = append(args, "--install-ghproxy-allowlist", strings.Join(options.ghProxyAllowlist, ","))
	}
	if options.instanceID != "" {
		args = append(args, "--instance-id", options.instanceID)
	}
	return args
}

// agentRuntimeUpgradeOptions assembles the option set used by the in-process
// manager from the registered flags and environment.
func agentRuntimeUpgradeOptions() upgradeOptions {
	timeout := defaultUpgradeHealthTimeout()
	if upgradeFlagHealthTimeout > 0 {
		timeout = time.Duration(upgradeFlagHealthTimeout) * time.Second
	}
	return upgradeOptions{
		targetVersion: upgradeFlagReleaseTag,
		instanceID:    firstNonEmpty(os.Getenv("CF_MONITOR_INSTANCE_ID"), upgradeFlagInstanceID, "default"),
		installDir:    upgradeFlagInstallDir,
		serviceName:   upgradeFlagServiceName,
		installMode:   upgradeFlagInstallMode,
		serviceMode:   upgradeFlagServiceMode,
		stateDir:      upgradeStateDir(),
		healthFile:    upgradeHealthFilePath(upgradeFlagHealthFile),
		healthTimeout: timeout,
		proxy:         upgradeFlagProxy,
		ghProxy:       upgradeFlagGhProxy,
		ghProxyAllowlist: func() []string {
			allowlist, err := parseGhProxyAllowlist("--install-ghproxy-allowlist", upgradeFlagGhProxyAllow)
			if err != nil {
				return nil
			}
			return allowlist
		}(),
	}
}

func exitCodeForResult(result upgradeResult) int {
	switch result.Status {
	case upgradeStatusSuccess, upgradeStatusAlreadyLatest:
		return 0
	default:
		return 1
	}
}

// newUpgradeCommandID generates a unique, opaque id for CLI-initiated upgrades.
func newUpgradeCommandID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("cli-%d", time.Now().UnixNano())
	}
	return "cli-" + hex.EncodeToString(buffer)
}
