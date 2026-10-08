//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestUpgradeLockRejectsSymlinksWithoutCreatingOrModifyingTarget(t *testing.T) {
	for _, exists := range []bool{false, true} {
		t.Run(map[bool]string{false: "absent", true: "existing"}[exists], func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "outside")
			if exists {
				if err := os.WriteFile(target, []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			path := filepath.Join(root, "upgrade.lock")
			if err := os.Symlink(target, path); err != nil {
				t.Fatal(err)
			}
			file, err := lockUpgradeFile(path)
			if file != nil {
				file.Close()
			}
			if err == nil {
				t.Fatal("symlink lock accepted")
			}
			if exists {
				body, err := os.ReadFile(target)
				if err != nil || string(body) != "keep" {
					t.Fatalf("target changed: %q %v", body, err)
				}
			} else if _, err := os.Stat(target); !os.IsNotExist(err) {
				t.Fatalf("target created: %v", err)
			}
		})
	}
}

func TestUpgradeLockRejectsNonRegularHardLinkedAndSharedFiles(t *testing.T) {
	for _, kind := range []string{"directory", "fifo", "hardlink", "shared"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "upgrade.lock")
			var err error
			switch kind {
			case "directory":
				err = os.Mkdir(path, 0700)
			case "fifo":
				err = unix.Mkfifo(path, 0600)
			case "hardlink":
				target := filepath.Join(root, "target")
				if err = os.WriteFile(target, []byte("keep"), 0600); err == nil {
					err = os.Link(target, path)
				}
			case "shared":
				if err = os.WriteFile(path, nil, 0600); err == nil {
					err = os.Chmod(path, 0666)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			file, err := lockUpgradeFile(path)
			if file != nil {
				file.Close()
			}
			if err == nil {
				t.Fatalf("%s lock accepted", kind)
			}
		})
	}
}

func TestUpgradeLockRemainsSameInodeAcrossRelease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upgrade.lock")
	first, err := lockUpgradeFile(path)
	if err != nil {
		t.Fatal(err)
	}
	flags, err := unix.FcntlInt(first.Fd(), unix.F_GETFD, 0)
	if err != nil || flags&unix.FD_CLOEXEC == 0 {
		first.Close()
		t.Fatalf("lock descriptor is inheritable: flags=%d err=%v", flags, err)
	}
	before, err := first.Stat()
	if err != nil {
		first.Close()
		t.Fatal(err)
	}
	lock := &upgradeLock{handle: first, path: path}
	defer lock.Release()
	second, err := lockUpgradeFile(path)
	if second != nil {
		second.Close()
	}
	if err == nil {
		t.Fatal("second holder admitted")
	}
	lock.Release()
	after, err := os.Stat(path)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("lock removed or replaced: %v", err)
	}
	third, err := lockUpgradeFile(path)
	if err != nil {
		t.Fatal(err)
	}
	(&upgradeLock{handle: third, path: path}).Release()
}

func TestPrivilegedUpgradeDirectoryRejectsRelativeAndWritablePaths(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0777); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"", ".", root, root + "/../other", filepath.Join(root, "missing")} {
		dir, err := openRootUpgradeDirectory(path)
		if dir != nil {
			dir.Close()
		}
		if err == nil {
			t.Fatalf("unsafe root lock directory accepted: %q", path)
		}
	}
}

func TestNonRootSupervisorRetainsStateLockLocation(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires a non-root test process")
	}
	state := t.TempDir()
	lock, err := acquireUpgradeLock(upgradeOptions{stateDir: state, installDir: filepath.Join(t.TempDir(), "unused")})
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if lock.path != filepath.Join(state, upgradeLockFile) {
		t.Fatalf("unexpected lock path %s", lock.path)
	}
}

func TestRootSupervisorIgnoresAgentOwnedStateLock(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root in an isolated filesystem")
	}
	install := t.TempDir()
	dir, err := openRootUpgradeDirectory(install)
	if err != nil {
		t.Skipf("requires TMPDIR under a root-owned non-writable directory chain, not shared /tmp: %v", err)
	}
	dir.Close()
	state := filepath.Join(install, "state")
	if err := os.Mkdir(state, 0777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(state, 0777); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(install, "must-not-exist")
	if err := os.Symlink(target, filepath.Join(state, upgradeLockFile)); err != nil {
		t.Fatal(err)
	}
	lock, err := acquireUpgradeLock(upgradeOptions{installDir: install, stateDir: state})
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if lock.path != filepath.Join(install, upgradeLockFile) {
		t.Fatalf("root used state lock: %s", lock.path)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("state link target created: %v", err)
	}
}

func TestUpgradeLockRejectsDifferentOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root in an isolated filesystem")
	}
	path := filepath.Join(t.TempDir(), "upgrade.lock")
	if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(path, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	file, err := lockUpgradeFile(path)
	if file != nil {
		file.Close()
	}
	if err == nil {
		t.Fatal("foreign-owned lock accepted")
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != "keep" {
		t.Fatalf("file changed: %q %v", content, err)
	}
}
