package main

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// A deliberately separate projection: never serialize identity (private key or certificate).
type localAgentStatus struct {
	Version              int       `json:"version"`
	PID                  int       `json:"pid"`
	State                string    `json:"state"`
	Connected            bool      `json:"connected"`
	Paused               bool      `json:"paused"`
	GatewayState         string    `json:"gateway_state"`
	CertificateExpires   time.Time `json:"certificate_expires"`
	CertificateExpiresMS int64     `json:"certificate_expires_ms"`
	LastGatewayAt        time.Time `json:"last_gateway_at"`
	LastGatewayAtMS      int64     `json:"last_gateway_at_ms"`
	UpdatedAtMS          int64     `json:"updated_at_ms"`
	ActiveTasks          int       `json:"active_tasks"`
	Error                string    `json:"error,omitempty"`
}

type localStatusReporter struct {
	mu    sync.Mutex
	file  string
	value localAgentStatus
}

func newLocalStatusReporter(o options) *localStatusReporter {
	return &localStatusReporter{file: o.statusFile, value: localAgentStatus{Version: 1, PID: os.Getpid()}}
}

func (r *localStatusReporter) update(change func(*localAgentStatus)) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	change(&r.value)
	r.value.UpdatedAtMS = time.Now().UnixMilli()
	if !r.value.CertificateExpires.IsZero() {
		r.value.CertificateExpiresMS = r.value.CertificateExpires.UnixMilli()
	}
	if !r.value.LastGatewayAt.IsZero() {
		r.value.LastGatewayAtMS = r.value.LastGatewayAt.UnixMilli()
	}
	if r.file != "" {
		if err := atomicJSON(r.file, r.value); err != nil {
			log.Print("desktop-agent: local status could not be persisted")
		}
	}
}

func validateLocalFiles(o options) error {
	for _, file := range []string{o.statusFile, o.controlFile} {
		if file == "" {
			continue
		}
		if !filepath.IsAbs(file) || filepath.Dir(filepath.Clean(file)) != filepath.Clean(o.stateDir) || filepath.Base(file) == "identity.json" {
			return errors.New("desktop-agent: status/control files must be dedicated files inside state-dir")
		}
		info, err := os.Lstat(file)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil && (!info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0)) {
			return errors.New("desktop-agent: local control/status must be private regular files")
		}
	}
	if o.statusFile != "" && o.statusFile == o.controlFile {
		return errors.New("desktop-agent: status and control must be separate files")
	}
	return nil
}

// Missing or malformed configured controls fail closed. The desktop writes atomically.
func locallyPaused(o options) bool {
	if o.controlFile == "" {
		return false
	}
	info, err := os.Lstat(o.controlFile)
	if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return true
	}
	raw, err := os.ReadFile(o.controlFile)
	if err != nil || len(raw) > 1024 {
		return true
	}
	var control struct {
		Paused *bool `json:"paused"`
	}
	return json.Unmarshal(raw, &control) != nil || control.Paused == nil || *control.Paused
}
