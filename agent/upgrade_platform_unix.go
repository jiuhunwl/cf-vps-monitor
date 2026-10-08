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

	"golang.org/x/sys/unix"
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

// openRootUpgradeDirectory pins every directory before checking ownership.
// Root never follows aliases or traverses a directory writable by the Agent.
func openRootUpgradeDirectory(path string) (*os.File, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("privileged upgrade install directory must be absolute")
	}
	for _, part := range strings.Split(path, "/") {
		if part == ".." {
			return nil, errors.New("privileged upgrade install directory must not contain parent traversal")
		}
	}
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	fd, err := unix.Open("/", flags, 0)
	if err != nil {
		return nil, err
	}
	defer func() {
		if fd >= 0 {
			_ = unix.Close(fd)
		}
	}()
	check := func() error {
		var info unix.Stat_t
		if err := unix.Fstat(fd, &info); err != nil {
			return err
		}
		if info.Uid != 0 || info.Mode&0022 != 0 || info.Mode&unix.S_IFMT != unix.S_IFDIR {
			return errors.New("privileged upgrade directory chain must be root-owned and not group/other-writable")
		}
		return nil
	}
	if err := check(); err != nil {
		return nil, err
	}
	clean := filepath.Clean(path)
	for _, part := range strings.Split(strings.TrimPrefix(clean, "/"), "/") {
		if part == "" {
			continue
		}
		next, err := unix.Openat(fd, part, flags, 0)
		if err != nil {
			return nil, fmt.Errorf("open privileged upgrade directory: %w", err)
		}
		_ = unix.Close(fd)
		fd = next
		if err := check(); err != nil {
			return nil, err
		}
	}
	directory := os.NewFile(uintptr(fd), clean)
	fd = -1 // ownership transferred to directory
	return directory, nil
}

func platformAcquireUpgradeLock(options upgradeOptions) (*os.File, string, error) {
	if os.Geteuid() != 0 {
		path := stateFile(options.stateDir, upgradeLockFile)
		file, err := lockUpgradeFile(path)
		return file, path, err
	}
	directory, err := openRootUpgradeDirectory(options.installDir)
	if err != nil {
		return nil, "", err
	}
	defer directory.Close()
	path := filepath.Join(options.installDir, upgradeLockFile)
	fd, err := unix.Openat(int(directory.Fd()), upgradeLockFile,
		unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, path, err
	}
	file, err := finishUpgradeLock(os.NewFile(uintptr(fd), path))
	return file, path, err
}

// lockUpgradeFile is the non-root state-file path. Do not use it to select a
// privileged lock: platformAcquireUpgradeLock also pins a trusted parent chain.
func lockUpgradeFile(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	return finishUpgradeLock(file)
}

func finishUpgradeLock(file *os.File) (*os.File, error) {
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || stat.Nlink != 1 || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 {
		file.Close()
		return nil, errors.New("upgrade lock must be a private, single-link regular file owned by the current user")
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
