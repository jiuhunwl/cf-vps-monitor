package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestHandleUpgradeCLIVersion(t *testing.T) {
	original := Version
	Version = "v9.9.9"
	t.Cleanup(func() { Version = original })

	var stdout, stderr bytes.Buffer
	handled, code := handleUpgradeCLI([]string{"--version"}, &stdout, &stderr)
	if !handled || code != 0 {
		t.Fatalf("handled=%v code=%d, want true/0", handled, code)
	}
	if strings.TrimSpace(stdout.String()) != "v9.9.9" {
		t.Fatalf("version output=%q", stdout.String())
	}
}

func TestHandleUpgradeCLINonUpgradeArgsAreNotIntercepted(t *testing.T) {
	invocations := [][]string{
		{},
		{"--server", "https://example.test", "--token", "t"},
		{"--mode", "http"},
		{"--name", "upgrade"},
		{"--disk-usage-check"},
	}
	for _, args := range invocations {
		var stdout, stderr bytes.Buffer
		handled, code := handleUpgradeCLI(args, &stdout, &stderr)
		if handled || code != 0 {
			t.Fatalf("args=%v handled=%v code=%d, want false/0", args, handled, code)
		}
	}
}

func TestDetectUpgradeInvocation(t *testing.T) {
	cases := []struct {
		args []string
		want upgradeInvocation
	}{
		{[]string{"upgrade"}, upgradeSubcommand},
		{[]string{"upgrade", "--release-tag", "v1.2.3"}, upgradeSubcommand},
		{[]string{"--upgrade-apply"}, upgradeApply},
		{[]string{"--upgrade-supervisor", "--once"}, upgradeSupervisor},
		{[]string{"--version"}, upgradeVersion},
		{[]string{"--name", "upgrade"}, upgradeNone},
		{[]string{"--interval", "5"}, upgradeNone},
	}
	for _, tc := range cases {
		if got := detectUpgradeInvocation(tc.args); got != tc.want {
			t.Fatalf("args=%v got=%d want=%d", tc.args, got, tc.want)
		}
	}
}

func TestHandleUpgradeCLIRejectsUnknownFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	handled, code := handleUpgradeCLI([]string{"upgrade", "--bogus"}, &stdout, &stderr)
	if !handled || code != 2 {
		t.Fatalf("handled=%v code=%d, want true/2", handled, code)
	}
}

func TestHandleUpgradeCLIHelpIsSuccess(t *testing.T) {
	var stdout, stderr bytes.Buffer
	handled, code := handleUpgradeCLI([]string{"upgrade", "--help"}, &stdout, &stderr)
	if !handled || code != 0 {
		t.Fatalf("handled=%v code=%d, want true/0", handled, code)
	}
}

func TestHandleUpgradeCLIRejectsUnsafeProxy(t *testing.T) {
	var stdout, stderr bytes.Buffer
	handled, code := handleUpgradeCLI([]string{"upgrade", "--proxy", "socks5://127.0.0.1"}, &stdout, &stderr)
	if !handled || code != 2 {
		t.Fatalf("handled=%v code=%d, want true/2", handled, code)
	}
}

func TestParseUpgradeOptionsUnifiesHealthTimeoutAliases(t *testing.T) {
	options, _, err := parseUpgradeOptions([]string{"upgrade", "--health-timeout", "45"}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if options.healthTimeout != 45*time.Second {
		t.Fatalf("healthTimeout=%v, want 45s", options.healthTimeout)
	}
	options, _, err = parseUpgradeOptions([]string{"upgrade", "--mode", "systemd"}, &bytes.Buffer{})
	if err != nil || options.serviceMode != "systemd" {
		t.Fatalf("serviceMode=%q err=%v", options.serviceMode, err)
	}
}

func TestUpgradeApplyArgsCarriesStateForDetachedSelf(t *testing.T) {
	args := upgradeApplyArgs(upgradeOptions{
		stateDir:      "/var/state",
		installDir:    "/opt/agent",
		serviceName:   "cf-vps-monitor-agent-default",
		healthFile:    "/var/state/agent-health.json",
		healthTimeout: 60 * time.Second,
		serviceMode:   "systemd",
		instanceID:    "default",
	})
	joined := strings.Join(args, " ")
	for _, want := range []string{"--upgrade-apply", "--state-dir /var/state", "--install-dir /opt/agent", "--service-name cf-vps-monitor-agent-default", "--service-mode systemd"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args %q missing %q", joined, want)
		}
	}
}

// upgrade-request.json sits in $STATE_DIR, which install.sh chowns to the
// unprivileged agent user. A hostile request must therefore not be able to
// redirect where the privileged supervisor downloads from: with an
// attacker-chosen origin the SHA256SUMS comparison is vacuous (the attacker
// serves binary and sums from the same host), and the substituted binary is
// later executed as root by the disk-usage collector unit.
func TestSupervisorTaskIgnoresRequestSuppliedOrigin(t *testing.T) {
	options := upgradeOptions{
		commandID:   "cmd-argv",
		releaseBase: "https://github.com/jiuhunwl/cf-vps-monitor/releases/download/v1.0.0",
		proxy:       "http://127.0.0.1:10808",
		ghProxy:     "https://ghproxy.example.org",
	}
	hostile := upgradeRequest{
		CommandID:     "cmd-hostile",
		TargetVersion: "v9.9.9",
		ReleaseBase:   "https://attacker.example.com/releases/download/v9.9.9",
		Proxy:         "http://attacker.example.com:8080",
		GhProxy:       "https://attacker.example.com",
	}

	task := supervisorTask(options, hostile)
	if task.ReleaseBase != options.releaseBase {
		t.Fatalf("ReleaseBase=%q, want argv value %q", task.ReleaseBase, options.releaseBase)
	}
	if task.Proxy != options.proxy {
		t.Fatalf("Proxy=%q, want argv value %q", task.Proxy, options.proxy)
	}
	if task.GhProxy != options.ghProxy {
		t.Fatalf("GhProxy=%q, want argv value %q", task.GhProxy, options.ghProxy)
	}
	// target_version and command_id still come from the request: those are the
	// only inputs the panel legitimately controls.
	if task.TargetVersion != "v9.9.9" || task.ID != "cmd-hostile" {
		t.Fatalf("task=%+v, want the request's target version and command id", task)
	}
}

// The dangerous shape: the operator configured no origin, so argv carries none.
// The request must not get to fill that gap.
func TestSupervisorTaskLeavesOriginEmptyWhenArgvHasNone(t *testing.T) {
	hostile := upgradeRequest{
		CommandID:     "cmd-1",
		TargetVersion: "v9.9.9",
		ReleaseBase:   "https://attacker.example.com/releases/download/v9.9.9",
		Proxy:         "http://attacker.example.com:8080",
		GhProxy:       "https://attacker.example.com",
	}

	task := supervisorTask(upgradeOptions{}, hostile)
	if task.ReleaseBase != "" || task.Proxy != "" || task.GhProxy != "" {
		t.Fatalf("task=%+v, want every origin field empty", task)
	}
	if fields := requestOriginFields(hostile); fields != "release_base,proxy,ghproxy" {
		t.Fatalf("requestOriginFields=%q, want release_base,proxy,ghproxy", fields)
	}
}

func TestSupervisorTaskFallsBackToArgvCommandID(t *testing.T) {
	task := supervisorTask(upgradeOptions{commandID: "cmd-argv"}, upgradeRequest{TargetVersion: "v1.2.3"})
	if task.ID != "cmd-argv" {
		t.Fatalf("ID=%q, want cmd-argv", task.ID)
	}
	if task.TargetVersion != "v1.2.3" {
		t.Fatalf("TargetVersion=%q, want v1.2.3", task.TargetVersion)
	}
}
