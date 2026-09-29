//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// openNoFollow opens a file refusing to traverse a symlink at the final path
// component. Writers always stage in the same directory and rename, so only
// readers need this.
func openNoFollow(path string, flag int, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flag|syscall.O_NOFOLLOW, perm)
}

// moveFileAtomic is a same-directory rename. On Unix it rebinds the path to a
// new inode without disturbing the running process's open inode, avoiding
// ETXTBSY.
func moveFileAtomic(source, destination string) error {
	return os.Rename(source, destination)
}

// lockUpgradeFile takes a non-blocking exclusive advisory lock via flock.
func lockUpgradeFile(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("upgrade lock is already held: %w", err)
	}
	return file, nil
}

func unlockUpgradeFile(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}

// platformRestartService restarts the deployment-appropriate service.
func platformRestartService(mode, serviceName, installDir, stateDir string) error {
	switch mode {
	case "systemd":
		return runUpgradeCommand("systemctl", "restart", serviceName)
	case "openrc":
		return runUpgradeCommand("rc-service", serviceName, "restart")
	case "launchctl":
		return runUpgradeCommand("launchctl", "kickstart", "-k", "system/"+serviceName)
	case "user":
		return restartUserModeService(installDir, stateDir)
	default:
		return fmt.Errorf("unsupported service mode for restart: %q", mode)
	}
}

// serviceActive reports whether the deployment is currently running.
func serviceActive(mode, serviceName, stateDir string) bool {
	switch mode {
	case "systemd":
		return exec.Command("systemctl", "is-active", "--quiet", serviceName).Run() == nil
	case "openrc":
		return exec.Command("rc-service", serviceName, "status").Run() == nil
	case "launchctl":
		return exec.Command("launchctl", "print", "system/"+serviceName).Run() == nil
	case "user":
		return userModeServiceActive(stateDir)
	default:
		return false
	}
}

// supervisorUnitPresent reports whether the root upgrade helper unit exists.
func supervisorUnitPresent(mode, serviceName string) bool {
	switch mode {
	case "systemd":
		return fileExists("/etc/systemd/system/" + serviceName + "-upgrade.service")
	case "openrc":
		return fileExists("/etc/init.d/" + serviceName + "-upgrade")
	default:
		return false
	}
}

// spawnDetachedUpgradeApply starts a self-invocation that outlives the calling
// Agent so it can replace the binary and restart the service.
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
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return command.Start()
}

// platformSupportsSelfReplace reports whether the running Agent can rename its
// own binary (true on Unix, false on Windows).
func platformSupportsSelfReplace() bool { return true }

// delegateUpgradeToInstaller is a no-op on Unix; delegation is Windows-only.
func delegateUpgradeToInstaller(upgradeOptions) upgradeResult {
	return upgradeResult{
		Status:      upgradeStatusFailed,
		FailureCode: upgradeFailureUnsupportedPlatform,
		Reason:      "installer delegation is only used on Windows",
	}
}

func runUpgradeCommand(name string, args ...string) error {
	output, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message != "" {
			return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, message)
		}
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return nil
}

func restartUserModeService(installDir, stateDir string) error {
	stopUserModeService(stateDir)
	start := filepath.Join(installDir, "start.sh")
	output, err := exec.Command(start).CombinedOutput()
	if err != nil {
		return fmt.Errorf("start.sh failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func userModeServiceActive(stateDir string) bool {
	data, err := os.ReadFile(filepath.Join(stateDir, "agent.pid"))
	if err != nil {
		return false
	}
	pid := strings.TrimSpace(string(data))
	if pid == "" {
		return false
	}
	return processAlive(pid)
}

func stopUserModeService(stateDir string) {
	data, err := os.ReadFile(filepath.Join(stateDir, "agent.pid"))
	if err != nil {
		return
	}
	pid := strings.TrimSpace(string(data))
	if pid == "" {
		return
	}
	if value, err := strconv.Atoi(pid); err == nil {
		_ = syscall.Kill(value, syscall.SIGTERM)
	}
}

func processAlive(pid string) bool {
	value, err := strconv.Atoi(strings.TrimSpace(pid))
	if err != nil || value <= 0 {
		return false
	}
	if err := syscall.Kill(value, 0); err != nil {
		return !errors.Is(err, syscall.EPERM)
	}
	return true
}
