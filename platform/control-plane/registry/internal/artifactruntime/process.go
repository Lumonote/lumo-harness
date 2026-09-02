// Package artifactruntime supervises the intentionally small local-process
// runtime for signed Component payloads. It is not a container orchestrator:
// the caller must already have verified the manifest, payload, and entrypoint.
package artifactruntime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

type State string

const (
	StateRunning State = "running"
	StateStopped State = "stopped"
	StateExited  State = "exited"
	StateFailed  State = "failed"
)

// Spec is resolved from an already verified, signed manifest. All paths are
// absolute so the supervisor never needs to interpolate operator input into a
// command or a working directory.
type Spec struct {
	ID         string
	Executable string
	Args       []string
	Dir        string
	LogPath    string
}

// Status is a safe local projection: it includes no command arguments or
// payload path, because those may reveal operator topology in a UI/API.
type Status struct {
	ID        string     `json:"id"`
	State     State      `json:"state"`
	PID       int        `json:"pid,omitempty"`
	StartedAt time.Time  `json:"started_at,omitempty"`
	ExitedAt  *time.Time `json:"exited_at,omitempty"`
	ExitCode  *int       `json:"exit_code,omitempty"`
	Message   string     `json:"message,omitempty"`
}

type process struct {
	spec    Spec
	cmd     *exec.Cmd
	log     *os.File
	done    chan struct{}
	status  Status
	stopped bool
}

// Supervisor owns the child processes launched by a single node runtime
// adapter. Its state intentionally lives in memory: after the adapter itself
// restarts, it must not claim to supervise orphaned processes.
type Supervisor struct {
	mu          sync.RWMutex
	processes   map[string]*process
	stopTimeout time.Duration
}

func NewSupervisor(stopTimeout time.Duration) *Supervisor {
	if stopTimeout <= 0 {
		stopTimeout = 10 * time.Second
	}
	return &Supervisor{processes: make(map[string]*process), stopTimeout: stopTimeout}
}

func (s *Supervisor) Start(spec Spec) (Status, error) {
	if err := validateSpec(spec); err != nil {
		return Status{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.processes[spec.ID]; ok && existing.status.State == StateRunning {
		return existing.status, nil
	}

	info, err := os.Lstat(spec.Executable)
	if err != nil {
		return Status{}, fmt.Errorf("runtime: entrypoint unavailable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return Status{}, errors.New("runtime: entrypoint must be a regular non-symlink file")
	}
	if err := os.Chmod(spec.Executable, info.Mode()|0o500); err != nil {
		return Status{}, fmt.Errorf("runtime: mark entrypoint executable: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(spec.LogPath), 0o700); err != nil {
		return Status{}, fmt.Errorf("runtime: create log directory: %w", err)
	}
	logFile, err := os.OpenFile(spec.LogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return Status{}, fmt.Errorf("runtime: open log file: %w", err)
	}

	cmd := exec.Command(spec.Executable, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return Status{}, fmt.Errorf("runtime: start process: %w", err)
	}
	startedAt := time.Now().UTC()
	p := &process{
		spec: spec, cmd: cmd, log: logFile, done: make(chan struct{}),
		status: Status{ID: spec.ID, State: StateRunning, PID: cmd.Process.Pid, StartedAt: startedAt},
	}
	s.processes[spec.ID] = p
	go s.wait(p)
	return p.status, nil
}

func (s *Supervisor) wait(p *process) {
	err := p.cmd.Wait()
	now := time.Now().UTC()
	code := 0
	if p.cmd.ProcessState != nil {
		code = p.cmd.ProcessState.ExitCode()
	}
	_ = p.log.Close()

	s.mu.Lock()
	p.status.PID = 0
	p.status.ExitedAt = &now
	p.status.ExitCode = &code
	if p.stopped {
		p.status.State = StateStopped
	} else if err != nil || code != 0 {
		p.status.State = StateFailed
		if err != nil {
			p.status.Message = "process exited unsuccessfully"
		}
	} else {
		p.status.State = StateExited
	}
	close(p.done)
	s.mu.Unlock()
}

func (s *Supervisor) Status(id string) (Status, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.processes[id]
	if !ok {
		return Status{}, false
	}
	return p.status, true
}

func (s *Supervisor) Statuses() []Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	statuses := make([]Status, 0, len(s.processes))
	for _, p := range s.processes {
		statuses = append(statuses, p.status)
	}
	return statuses
}

// Stop requests graceful termination, then escalates after the supplied
// context or the supervisor's bounded default timeout. A missing process is
// treated as already stopped, keeping lifecycle callers idempotent.
func (s *Supervisor) Stop(ctx context.Context, id string) (Status, error) {
	s.mu.Lock()
	p, ok := s.processes[id]
	if !ok {
		s.mu.Unlock()
		return Status{ID: id, State: StateStopped}, nil
	}
	if p.status.State != StateRunning {
		status := p.status
		s.mu.Unlock()
		return status, nil
	}
	p.stopped = true
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		p.stopped = false
		s.mu.Unlock()
		return Status{}, fmt.Errorf("runtime: terminate process: %w", err)
	}
	done := p.done
	s.mu.Unlock()

	waitCtx := ctx
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		waitCtx, cancel = context.WithTimeout(ctx, s.stopTimeout)
		defer cancel()
	}
	select {
	case <-done:
	case <-waitCtx.Done():
		if err := p.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return Status{}, fmt.Errorf("runtime: kill process: %w", err)
		}
		<-done
	}
	status, _ := s.Status(id)
	return status, nil
}

func (s *Supervisor) StopAll(ctx context.Context) error {
	s.mu.RLock()
	ids := make([]string, 0, len(s.processes))
	for id := range s.processes {
		ids = append(ids, id)
	}
	s.mu.RUnlock()
	for _, id := range ids {
		if _, err := s.Stop(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Supervisor) LogPath(id string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.processes[id]
	if !ok {
		return "", false
	}
	return p.spec.LogPath, true
}

func validateSpec(spec Spec) error {
	if spec.ID == "" || len(spec.ID) > 256 {
		return errors.New("runtime: id is required and must be at most 256 bytes")
	}
	if !filepath.IsAbs(spec.Executable) || !filepath.IsAbs(spec.Dir) || !filepath.IsAbs(spec.LogPath) {
		return errors.New("runtime: executable, dir, and log path must be absolute")
	}
	rel, err := filepath.Rel(spec.Dir, spec.Executable)
	if err != nil || rel == "." || rel == ".." || len(rel) >= 3 && rel[:3] == ".."+string(filepath.Separator) {
		return errors.New("runtime: executable must be below the artifact directory")
	}
	if len(spec.Args) > 32 {
		return errors.New("runtime: too many arguments")
	}
	for _, arg := range spec.Args {
		if len(arg) > 4096 || containsNUL(arg) {
			return errors.New("runtime: invalid argument")
		}
	}
	return nil
}

func containsNUL(value string) bool {
	for _, char := range value {
		if char == 0 {
			return true
		}
	}
	return false
}
