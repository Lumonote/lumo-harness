package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLocalStatusIsPrivateAndHasNoIdentitySecrets(t *testing.T) {
	dir := t.TempDir()
	o := options{stateDir: dir, statusFile: filepath.Join(dir, "status.json")}
	if err := validateLocalFiles(o); err != nil {
		t.Fatal(err)
	}
	r := newLocalStatusReporter(o)
	r.update(func(s *localAgentStatus) {
		s.State = "connected"
		s.Connected = true
		s.LastGatewayAt = time.Now()
		s.CertificateExpires = time.Now().Add(time.Hour)
	})
	raw, err := os.ReadFile(o.statusFile)
	if err != nil {
		t.Fatal(err)
	}
	var status localAgentStatus
	if err = json.Unmarshal(raw, &status); err != nil || !status.Connected || status.LastGatewayAtMS <= 0 || status.CertificateExpiresMS <= status.LastGatewayAtMS {
		t.Fatalf("bad status: %s", raw)
	}
	if strings.Contains(string(raw), "private_key") || strings.Contains(string(raw), "BEGIN CERTIFICATE") {
		t.Fatal("identity secret exposed")
	}
	info, _ := os.Stat(o.statusFile)
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatal("status is not private")
	}
}

func TestLocalPauseFailsClosedAndCanResume(t *testing.T) {
	dir := t.TempDir()
	o := options{stateDir: dir, controlFile: filepath.Join(dir, "control.json")}
	if !locallyPaused(o) {
		t.Fatal("missing control must pause")
	}
	for _, raw := range []string{`{}`, `no-json`, `{"paused":"false"}`, `{"paused":true}`} {
		if err := os.WriteFile(o.controlFile, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		if !locallyPaused(o) {
			t.Fatalf("must pause: %s", raw)
		}
	}
	if err := atomicJSON(o.controlFile, map[string]bool{"paused": false}); err != nil {
		t.Fatal(err)
	}
	if locallyPaused(o) {
		t.Fatal("explicit false must resume")
	}
	if locallyPaused(options{}) {
		t.Fatal("standalone CLI without control preserves behaviour")
	}
}

func TestLocalProjectionCannotOverwriteIdentityOrEscape(t *testing.T) {
	dir := t.TempDir()
	for _, path := range []string{filepath.Join(dir, "identity.json"), filepath.Join(dir, "..", "escape.json"), "status.json"} {
		if validateLocalFiles(options{stateDir: dir, statusFile: path}) == nil {
			t.Fatalf("accepted %s", path)
		}
	}
	path := filepath.Join(dir, "same.json")
	if validateLocalFiles(options{stateDir: dir, statusFile: path, controlFile: path}) == nil {
		t.Fatal("same files accepted")
	}
}
