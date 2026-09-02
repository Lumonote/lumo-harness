package artifactruntime

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestSupervisorStartsLogsAndStopsSignedEntrypoint(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the local process adapter uses POSIX signals")
	}
	dir := t.TempDir()
	entrypoint := filepath.Join(dir, "payload", "run")
	if err := os.MkdirAll(filepath.Dir(entrypoint), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entrypoint, []byte("#!/bin/sh\necho ready\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	logs := filepath.Join(dir, "runtime-logs", "demo.log")
	supervisor := NewSupervisor(time.Second)
	status, err := supervisor.Start(Spec{ID: "demo@1.0.0", Executable: entrypoint, Dir: filepath.Join(dir, "payload"), LogPath: logs})
	if err != nil || status.State != StateRunning || status.PID == 0 {
		t.Fatalf("start = %+v, %v", status, err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		raw, readErr := os.ReadFile(logs)
		if readErr == nil && strings.Contains(string(raw), "ready") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("runtime log did not contain ready: %q, err=%v", raw, readErr)
		}
		time.Sleep(10 * time.Millisecond)
	}
	stopped, err := supervisor.Stop(context.Background(), "demo@1.0.0")
	if err != nil || stopped.State != StateStopped || stopped.ExitCode == nil {
		t.Fatalf("stop = %+v, %v", stopped, err)
	}
}

func TestSupervisorRejectsUnsafeSpec(t *testing.T) {
	supervisor := NewSupervisor(time.Second)
	if _, err := supervisor.Start(Spec{ID: "bad", Executable: "relative", Dir: "/tmp", LogPath: "/tmp/log"}); err == nil {
		t.Fatal("relative paths must be rejected")
	}
	if _, err := supervisor.Start(Spec{ID: "bad", Executable: "/tmp/outside", Dir: "/tmp/root", LogPath: "/tmp/log"}); err == nil {
		t.Fatal("entrypoint outside artifact root must be rejected")
	}
}
