package computerbridge

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestGenerationLockExcludesOtherHandlesAndReleasesWithoutUnlink(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("OS locking unavailable")
	}
	path := filepath.Join(t.TempDir(), "bridge.generation")
	release, err := lockGeneration(path)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := lockGeneration(path); err == nil {
		second()
		release()
		t.Fatal("two active generations acquired the same inode")
	}
	if _, err := os.Stat(path); err != nil {
		release()
		t.Fatal(err)
	}
	release()
	third, err := lockGeneration(path)
	if err != nil {
		t.Fatal("released OS lock did not become available", err)
	}
	third()
	if _, err := os.Stat(path); err != nil {
		t.Fatal("generation lock inode was removed", err)
	}
}

func TestGenerationLockProcessFixture(t *testing.T) {
	path := os.Getenv("LUMO_CUA_LOCK_PROCESS_PATH")
	if path == "" {
		return
	}
	_, err := lockGeneration(path)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate an exception dropping the shutdown callback. GC must not close
	// the descriptor and silently release an uncertain live generation.
	runtime.GC()
	_, _ = os.Stdout.WriteString("locked\n")
	_, _ = io.Copy(io.Discard, os.Stdin)
}
func TestGenerationLockSurvivesContentionAndReleasesAfterHostDeath(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("OS locking unavailable")
	}
	path := filepath.Join(t.TempDir(), "generation")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestGenerationLockProcessFixture$")
	child.Env = append(os.Environ(), "LUMO_CUA_LOCK_PROCESS_PATH="+path)
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer child.Process.Kill()
	ready, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || ready != "locked\n" {
		t.Fatalf("child failed to acquire OS lock: %q %v", ready, err)
	}
	if release, err := lockGeneration(path); err == nil {
		release()
		t.Fatal("second process displaced a live lock holder")
	}
	if err = child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	release, err := lockGeneration(path)
	if err != nil {
		t.Fatal("kernel did not release lock after host death", err)
	}
	release()
}

func TestGenerationLockRejectsSymlinkWithoutChangingItsTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires an extra Windows privilege")
	}
	root := t.TempDir()
	target := filepath.Join(root, "target")
	link := filepath.Join(root, "bridge.generation")
	if err := os.WriteFile(target, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if release, err := lockGeneration(link); err == nil {
		release()
		t.Fatal("symlink lock target accepted")
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "preserve" {
		t.Fatalf("lock target changed: %q %v", content, err)
	}
}
