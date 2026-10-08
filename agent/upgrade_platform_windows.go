//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// openNoFollow has no O_NOFOLLOW equivalent on Windows; the atomic writer already
// avoids following links by staging and renaming.
func openNoFollow(path string, flag int, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flag, perm)
}

// moveFileAtomic replaces the destination in a single MoveFileEx call.
func moveFileAtomic(source, destination string) error {
	sourcePtr, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	destinationPtr, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(sourcePtr, destinationPtr, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}

// Windows retains its existing state location and LockFileEx semantics.
func platformAcquireUpgradeLock(options upgradeOptions) (*os.File, string, error) {
	path := stateFile(options.stateDir, upgradeLockFile)
	file, err := lockUpgradeFile(path)
	return file, path, err
}

// lockUpgradeFile uses a non-blocking exclusive region lock.
func lockUpgradeFile(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	overlapped := new(windows.Overlapped)
	if err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped); err != nil {
		file.Close()
		return nil, fmt.Errorf("upgrade lock is already held: %w", err)
	}
	return file, nil
}

func unlockUpgradeFile(file *os.File) error {
	overlapped := new(windows.Overlapped)
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, overlapped)
}

// platformRestartService is unreachable on Windows: upgrades are delegated to
// install-windows.ps1, which owns stop/replace/start.
func platformRestartService(mode, serviceName, installDir, stateDir string) error {
	return fmt.Errorf("self-replacement is not supported on Windows; use the installer")
}

// serviceActive reports whether the scheduled task exists and is running.
func serviceActive(mode, serviceName, stateDir string) bool {
	if serviceName == "" {
		return false
	}
	script := fmt.Sprintf("if ((Get-ScheduledTask -TaskName '%s' -ErrorAction SilentlyContinue).State -eq 'Running') { exit 0 } else { exit 1 }",
		strings.ReplaceAll(serviceName, "'", "''"))
	return exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script).Run() == nil
}

func supervisorUnitPresent(mode, serviceName string) bool { return false }

// spawnDetachedUpgradeApply launches a detached self-apply process.
func spawnDetachedUpgradeApply(options upgradeOptions) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	command := exec.Command(executable, upgradeApplyArgs(options)...)
	command.Env = os.Environ()
	command.Stdin = nil
	command.Stdout = nil
	command.Stderr = nil
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP}
	return command.Start()
}

// platformSupportsSelfReplace is false on Windows: the running .exe cannot be
// renamed over itself, so the installer performs the swap.
func platformSupportsSelfReplace() bool { return false }

// delegateUpgradeToInstaller runs the bundled install-windows.ps1 in -Upgrade
// mode, reusing the Agent's own configuration environment, then confirms the
// restart through the health beacon. It never pretends to self-replace.
func delegateUpgradeToInstaller(options upgradeOptions) upgradeResult {
	started := time.Now()
	result := upgradeResult{
		CommandID:     options.commandID,
		TargetVersion: options.targetVersion,
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

	script := locateWindowsInstaller(options.installDir)
	if script == "" {
		return finish(upgradeStatusFailed, upgradeFailureUnsupportedPlatform,
			"install-windows.ps1 was not found next to the Agent; run the installer to upgrade on Windows")
	}

	instanceID := sanitizeUpgradeInstanceID(options.instanceID)
	arguments := []string{
		"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
		"-Upgrade",
		"-InstanceId", instanceID,
		"-Server", os.Getenv("CF_MONITOR_SERVER"),
		"-Token", os.Getenv("CF_MONITOR_TOKEN"),
		"-Name", os.Getenv("CF_MONITOR_NAME"),
		"-InstallDir", options.installDir,
		"-ServiceName", options.serviceName,
	}
	if options.ghProxy != "" {
		arguments = append(arguments, "-InstallGhproxy", options.ghProxy)
	}
	if options.proxy != "" {
		arguments = append(arguments, "-Proxy", options.proxy)
	}
	if options.targetVersion != "" && options.targetVersion != "latest" {
		arguments = append(arguments, "-ReleaseTag", options.targetVersion)
	}

	output, err := exec.Command("powershell.exe", arguments...).CombinedOutput()
	if err != nil {
		tail := strings.TrimSpace(string(output))
		if len(tail) > 400 {
			tail = tail[len(tail)-400:]
		}
		return finish(upgradeStatusFailed, upgradeFailureReplaceFailed,
			fmt.Sprintf("installer upgrade failed: %v: %s", err, tail))
	}
	if err := waitHealthy(options, options.targetVersion, result.StartedAtMs); err != nil {
		return finish(upgradeStatusFailed, upgradeFailureHealthTimeout, err.Error())
	}
	result.FinalVersion = options.targetVersion
	return finish(upgradeStatusSuccess, "", "delegated upgrade verified")
}

func locateWindowsInstaller(installDir string) string {
	candidates := []string{
		filepath.Join(installDir, "install-windows.ps1"),
	}
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(executable), "install-windows.ps1"))
	}
	for _, candidate := range candidates {
		if fileExists(candidate) {
			return candidate
		}
	}
	return ""
}
