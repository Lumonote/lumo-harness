// desktop-agent connects outbound to a device gateway, installs its approved
// registry closure, and accepts only fixed manifest runtime commands explicitly
// allowed by this device's operator. It has no control-plane credential.
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/lumo-harness/platform/registry/internal/artifactruntime"
	"github.com/lumo-harness/platform/registry/internal/plan"
	"github.com/lumo-harness/platform/registry/internal/provisioner"
	"github.com/lumo-harness/platform/registry/internal/trust"
)

type identity struct {
	Realm       string    `json:"realm"`
	NodeID      string    `json:"node_id"`
	Gateway     string    `json:"gateway"`
	Key         string    `json:"key"`
	Certificate string    `json:"certificate"`
	ExpiresAt   time.Time `json:"expires_at"`
}
type artifact struct {
	Name          string `json:"name"`
	Version       string `json:"version"`
	Digest        string `json:"digest"`
	PayloadDigest string `json:"payload_digest,omitempty"`
}
type policy struct {
	Name          string     `json:"name"`
	Version       string     `json:"version"`
	ClientVersion string     `json:"client_version"`
	Artifacts     []artifact `json:"artifacts"`
	Shape         plan.Shape `json:"shape"`
}
type command struct {
	ID        string          `json:"id"`
	Action    string          `json:"action"`
	Revision  int64           `json:"revision"`
	Body      json.RawMessage `json:"body"`
	ExpiresAt time.Time       `json:"expires_at"`
}

type runtimeCommandBody struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func (c command) runtimeBody() (runtimeCommandBody, error) {
	var body runtimeCommandBody
	decoder := json.NewDecoder(bytes.NewReader(c.Body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		return body, errors.New("desktop-agent: invalid runtime command body")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return body, errors.New("desktop-agent: runtime command body must be one JSON object")
	}
	return body, nil
}

func (c command) taskBody() (taskEnvelope, error) {
	var body taskEnvelope
	decoder := json.NewDecoder(bytes.NewReader(c.Body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		return body, errors.New("desktop-agent: invalid execute_task body")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return body, errors.New("desktop-agent: execute_task body must be one JSON object")
	}
	return body, validateTaskEnvelope(body)
}

// taskEnvelope is the only payload accepted by the execute_task command. It
// deliberately contains the immutable task contract, rather than a command,
// shell, environment or model selector. The local runner owns execution under
// its separately provisioned identity.
type taskEnvelope struct {
	TaskID         string          `json:"task_id"`
	RunID          string          `json:"run_id"`
	Attempt        int             `json:"attempt"`
	WorkerID       string          `json:"worker_id"`
	ProjectID      string          `json:"project_id"`
	Title          string          `json:"title"`
	Intent         string          `json:"intent"`
	IntentContract json.RawMessage `json:"intent_contract"`
	DeadlineMS     int64           `json:"deadline_ms"`
	SessionRef     string          `json:"session_ref"`
}

type taskInboxRecord struct {
	Version   int          `json:"version"`
	CommandID string       `json:"command_id"`
	Task      taskEnvelope `json:"task"`
	CreatedAt time.Time    `json:"created_at"`
}

type taskReceipt struct {
	Version   int             `json:"version"`
	CommandID string          `json:"command_id"`
	Task      taskEnvelope    `json:"task"`
	State     string          `json:"state"`
	Summary   string          `json:"summary"`
	Output    json.RawMessage `json:"output,omitempty"`
	UpdatedAt time.Time       `json:"updated_at"`
}

type taskRunnerRequest struct {
	Type      string       `json:"type"`
	CommandID string       `json:"command_id"`
	Task      taskEnvelope `json:"task"`
}

type taskRunnerResponse struct {
	State   string          `json:"state"`
	Summary string          `json:"summary"`
	Output  json.RawMessage `json:"output,omitempty"`
}

var taskIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$`)

func validateTaskEnvelope(task taskEnvelope) error {
	if !taskIDPattern.MatchString(task.TaskID) || !taskIDPattern.MatchString(task.RunID) ||
		task.Attempt < 1 || task.Attempt > 1_000_000 ||
		!strings.HasPrefix(task.WorkerID, "user:") || !taskIDPattern.MatchString(strings.TrimPrefix(task.WorkerID, "user:")) ||
		task.ProjectID == "" || !taskIDPattern.MatchString(task.ProjectID) || task.SessionRef == "" || len(task.SessionRef) > 160 {
		return errors.New("desktop-agent: execute_task identity is invalid")
	}
	if len([]rune(task.Title)) > 512 || strings.TrimSpace(task.Title) == "" || len([]rune(task.Intent)) > 16000 || strings.TrimSpace(task.Intent) == "" {
		return errors.New("desktop-agent: execute_task title or intent is invalid")
	}
	if task.DeadlineMS < 0 {
		return errors.New("desktop-agent: execute_task deadline is invalid")
	}
	if len(task.IntentContract) > 256<<10 || (len(task.IntentContract) > 0 && !json.Valid(task.IntentContract)) {
		return errors.New("desktop-agent: execute_task contract is invalid")
	}
	return nil
}

func createImmutableJSON(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		_ = os.Remove(path)
		return err
	}
	if closeErr != nil {
		_ = os.Remove(path)
		return closeErr
	}
	return nil
}

// One run occupies **two** files in the task directory, and they must not share a
// name. `createImmutableJSON` opens with O_EXCL, so the first writer wins and the
// second always sees ErrExist — and the ErrExist branch is written to mean "this
// record already exists, accept an identical replay, refuse a different one".
// Pointed at the wrong record type, that branch reads the inbox JSON as a receipt,
// finds it different, and reports `task result is immutable` — which is why
// `finishDeviceTask` used to log and return without ever sending `task_result`.
//
// The failure was invisible to both helpers' own tests because each is handed a
// fresh t.TempDir(): neither ever saw the other's file. See
// TestReceiptLandsAfterTheInboxRecordInTheSameDirectory, which walks the sequence
// that actually runs.
const (
	taskInboxSuffix   = ".inbox.json"
	taskReceiptSuffix = ".receipt.json"
)

func persistTaskInbox(dir string, commandID string, task taskEnvelope) (taskInboxRecord, bool, error) {
	record := taskInboxRecord{Version: 1, CommandID: commandID, Task: task, CreatedAt: time.Now().UTC()}
	path := filepath.Join(dir, task.RunID+taskInboxSuffix)
	err := createImmutableJSON(path, record)
	if err == nil {
		return record, true, nil
	}
	if !errors.Is(err, os.ErrExist) {
		return record, false, err
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		return record, false, readErr
	}
	var existing taskInboxRecord
	if json.Unmarshal(raw, &existing) != nil || existing.Version != 1 || existing.CommandID == "" || existing.Task.RunID != task.RunID {
		return record, false, errors.New("desktop-agent: task inbox record is invalid")
	}
	existingRaw, _ := json.Marshal(existing.Task)
	wantedRaw, _ := json.Marshal(task)
	if existing.CommandID != commandID || !bytes.Equal(existingRaw, wantedRaw) {
		return record, false, errors.New("desktop-agent: run ID is already bound to a different task")
	}
	return existing, false, nil
}

func persistTaskReceipt(dir string, receipt taskReceipt) error {
	path := filepath.Join(dir, receipt.Task.RunID+taskReceiptSuffix)
	err := createImmutableJSON(path, receipt)
	if err == nil || !errors.Is(err, os.ErrExist) {
		return err
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		return readErr
	}
	var existing taskReceipt
	if json.Unmarshal(raw, &existing) != nil {
		return errors.New("desktop-agent: task result record is invalid")
	}
	existingRaw, _ := json.Marshal(existing)
	wantedRaw, _ := json.Marshal(receipt)
	if !bytes.Equal(existingRaw, wantedRaw) {
		return errors.New("desktop-agent: task result is immutable")
	}
	return nil
}

func taskResultPayload(receipt taskReceipt, nodeID string) ([]byte, error) {
	payload := map[string]any{
		"task_id": receipt.Task.TaskID, "run_id": receipt.Task.RunID, "state": receipt.State,
		"session_ref": receipt.Task.SessionRef, "node_id": nodeID, "summary": receipt.Summary,
	}
	if len(receipt.Output) > 0 {
		payload["output"] = json.RawMessage(receipt.Output)
	}
	return json.Marshal(payload)
}

func runTaskRunner(ctx context.Context, socket, commandID string, task taskEnvelope) (taskRunnerResponse, error) {
	var out taskRunnerResponse
	if socket == "" {
		return out, errors.New("desktop-agent: task runner is not configured")
	}
	dialer := net.Dialer{Timeout: 5 * time.Second}
	conn, err := dialer.DialContext(ctx, "unix", socket)
	if err != nil {
		return out, errors.New("desktop-agent: task runner unavailable")
	}
	defer conn.Close()
	// Cancelling has to close the socket, not merely stop this side from waiting:
	// the deadline below is absolute, so a blocked Decode never observes a
	// cancelled context. Closing is also the only interruption the runner can
	// receive at all — the exchange is one request and one response, with no
	// mid-flight frame by design. Whether the runner actually stops on EOF is
	// decided on the far side of this socket, which is outside this repository;
	// see docs/superpowers/specs/2026-09-17-device-cancel-and-recovery-design.md.
	stopOnCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopOnCancel()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	if err = json.NewEncoder(conn).Encode(taskRunnerRequest{Type: "execute_task", CommandID: commandID, Task: task}); err != nil {
		return out, errors.New("desktop-agent: task runner request failed")
	}
	decoder := json.NewDecoder(io.LimitReader(conn, 1<<20+1))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&out); err != nil {
		return out, errors.New("desktop-agent: task runner response is invalid")
	}
	if out.State != "COMPLETED" && out.State != "FAILED" && out.State != "CANCELLED" {
		return out, errors.New("desktop-agent: task runner returned an invalid state")
	}
	if len(out.Output) > 900_000 || (len(out.Output) > 0 && !json.Valid(out.Output)) || len([]rune(out.Summary)) > 16000 {
		return out, errors.New("desktop-agent: task runner result exceeds the receipt contract")
	}
	if out.State == "COMPLETED" && strings.TrimSpace(out.Summary) == "" && len(out.Output) == 0 {
		return out, errors.New("desktop-agent: completed task has no deliverable")
	}
	return out, nil
}

// finishDeviceTask runs one already-accepted task to completion and reports the
// outcome over the device channel.
//
// Ordering is an invariant, not a detail: the receipt is persisted before
// anything is reported. Reporting an outcome the device keeps no local record of
// would leave the control plane holding a result that cannot be reconciled
// against the machine that produced it.
func finishDeviceTask(ctx context.Context, write func(message) error, socket, nodeID, inbox, commandID string, task taskEnvelope) {
	resp, err := runTaskRunner(ctx, socket, commandID, task)
	if err != nil {
		log.Printf("desktop-agent: task runner failed for %s: %v", task.RunID, err)
	}
	// The runner's own diagnostics are not forwarded: a failure summary that
	// varies with local conditions is not something the control plane can act on.
	receipt := taskReceipt{
		Version: 1, CommandID: commandID, Task: task,
		State: "FAILED", Summary: "device task runner failed", UpdatedAt: time.Now().UTC(),
	}
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		// A cancelled run is not a failed one. Reporting FAILED here would write a
		// false failure into the task ledger for work an operator deliberately
		// stopped, and FAILED and CANCELLED are not the same state downstream.
		// Checked before the error, because a cancelled run always has one.
		receipt.State, receipt.Summary = "CANCELLED", "task cancelled by the control plane"
	case err == nil:
		receipt.State, receipt.Summary, receipt.Output = resp.State, resp.Summary, resp.Output
	}
	if err = persistTaskReceipt(inbox, receipt); err != nil {
		log.Printf("desktop-agent: task receipt for %s was not persisted: %v", task.RunID, err)
		return
	}
	payload, err := taskResultPayload(receipt, nodeID)
	if err != nil {
		log.Printf("desktop-agent: task result for %s could not be encoded: %v", task.RunID, err)
		return
	}
	if err = write(message{Type: "task_result", CommandID: commandID, Result: payload}); err != nil {
		log.Printf("desktop-agent: task result for %s was not delivered: %v", task.RunID, err)
	}
}

// inflightTask records what the slot token cannot express: which run is executing
// right now, and how to stop it. The slot only answers "busy or not", so without
// this a cancel command would have nothing to match against.
//
// Keyed by run ID rather than by the original command ID, because a cancellation
// is about the task; the command that carried it is incidental.
type inflightTask struct {
	mu     sync.Mutex
	runID  string
	cancel context.CancelFunc
}

func (f *inflightTask) begin(runID string, cancel context.CancelFunc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.runID, f.cancel = runID, cancel
}

func (f *inflightTask) clear(runID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// Only the run that still owns the slot may clear it: a cancelled run and its
	// replacement overlap briefly, and the late finisher must not erase the newer
	// one's registration.
	if f.runID == runID {
		f.runID, f.cancel = "", nil
	}
}

// cancelIfRun stops the run identified by runID and reports whether anything was
// stopped. A cancel that matches nothing is not a failure — it normally means the
// command arrived after the task finished — but the caller has to know, so it can
// answer the control plane honestly instead of acknowledging a stop that never
// happened.
func (f *inflightTask) cancelIfRun(runID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.runID == "" || f.runID != runID {
		return false
	}
	f.cancel()
	return true
}

// recoverTaskInbox reports runs this device accepted but never finished.
//
// An inbox record is written before the assignment is acknowledged, and a receipt
// is written when the run ends — so a record without a receipt means this process
// died mid-run. The control plane keeps such a run in RUNNING with nothing left
// able to finish it, which is precisely the failure the result channel exists to
// remove, and a restart is the one moment it can be repaired.
//
// FAILED, not CANCELLED: the device no longer knows how far the run got, and
// CANCELLED means "the control plane stopped this on purpose". The summary says
// which one it was, because the two lead to different investigations (the task
// itself vs. this machine's stability).
func recoverTaskInbox(dir string, nodeID string, write func(message) error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		// A local problem must not become a total outage: failing here would take
		// the whole device offline over an unreadable directory.
		log.Printf("desktop-agent: task inbox could not be read: %v", err)
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), taskInboxSuffix) {
			continue
		}
		runID := strings.TrimSuffix(entry.Name(), taskInboxSuffix)
		receiptPath := filepath.Join(dir, runID+taskReceiptSuffix)
		if _, err := os.Stat(receiptPath); err == nil {
			continue // already finished, and reported when it finished
		} else if !errors.Is(err, os.ErrNotExist) {
			log.Printf("desktop-agent: task receipt for %s could not be checked: %v", runID, err)
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			log.Printf("desktop-agent: task inbox record for %s could not be read: %v", runID, err)
			continue
		}
		var record taskInboxRecord
		if json.Unmarshal(raw, &record) != nil || record.Version != 1 || record.Task.RunID != runID {
			log.Printf("desktop-agent: task inbox record for %s is invalid", runID)
			continue
		}
		// The receipt is persisted before anything is reported, for the same
		// reason finishDeviceTask does it: reporting an outcome this device keeps
		// no local record of leaves the control plane holding a result it cannot
		// reconcile against the machine that produced it.
		receipt := taskReceipt{
			Version: 1, CommandID: record.CommandID, Task: record.Task,
			State: "FAILED", Summary: "device restarted while the task was in flight",
			UpdatedAt: time.Now().UTC(),
		}
		if err := persistTaskReceipt(dir, receipt); err != nil {
			log.Printf("desktop-agent: recovered receipt for %s was not persisted: %v", runID, err)
			continue
		}
		payload, err := taskResultPayload(receipt, nodeID)
		if err != nil {
			log.Printf("desktop-agent: recovered result for %s could not be encoded: %v", runID, err)
			continue
		}
		if err := write(message{Type: "task_result", CommandID: record.CommandID, Result: payload}); err != nil {
			log.Printf("desktop-agent: recovered result for %s was not delivered: %v", runID, err)
		}
	}
}

type message struct {
	Type          string          `json:"type"`
	Revision      int64           `json:"revision,omitempty"`
	ClientVersion string          `json:"client_version,omitempty"`
	Installed     []artifact      `json:"installed,omitempty"`
	Error         string          `json:"error,omitempty"`
	CommandID     string          `json:"command_id,omitempty"`
	State         string          `json:"state,omitempty"`
	Result        json.RawMessage `json:"result,omitempty"`
	Policy        *policy         `json:"policy,omitempty"`
	Commands      []command       `json:"commands,omitempty"`
	OS            string          `json:"os,omitempty"`
	Arch          string          `json:"arch,omitempty"`
}
type options struct {
	gateway, realm, nodeID, stateDir, installDir, caFile, codeFile, clientVersion, allowed, taskRunnerSocket string
	trustFile, shapeJSON                                                                                     string
	shape                                                                                                    plan.Shape
	maxRuntime                                                                                               time.Duration
}

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run() error {
	var o options
	flag.StringVar(&o.gateway, "gateway", "", "HTTPS device gateway origin")
	flag.StringVar(&o.realm, "realm", "", "registered realm")
	flag.StringVar(&o.nodeID, "node", "", "registered node ID")
	flag.StringVar(&o.stateDir, "state-dir", "", "absolute private device identity directory")
	flag.StringVar(&o.installDir, "install-dir", "", "absolute approved artifact directory")
	flag.StringVar(&o.caFile, "server-ca", "", "optional gateway server CA PEM file; otherwise system roots")
	flag.StringVar(&o.trustFile, "trust-file", "", "absolute independently provisioned publisher trust file")
	flag.StringVar(&o.shapeJSON, "shape", "{}", "locally available capabilities as JSON")
	flag.StringVar(&o.codeFile, "enrollment-code-file", "", "file containing the one-time activation code")
	flag.StringVar(&o.clientVersion, "client-version", "0.1.0", "client version approved in device policy")
	flag.StringVar(&o.allowed, "allow-runtime-digests", "", "explicit local consent: comma-separated exact manifest digests permitted to execute")
	flag.StringVar(&o.taskRunnerSocket, "task-runner-socket", "", "optional absolute mode-0600 Unix socket for the provisioned task runner")
	flag.DurationVar(&o.maxRuntime, "max-runtime", time.Minute, "maximum lifetime of a locally approved process (up to 5m)")
	flag.Parse()
	if !filepath.IsAbs(o.trustFile) {
		return errors.New("desktop-agent: -trust-file is required")
	}
	if _, err := trust.LoadFile(o.trustFile); err != nil {
		return err
	}
	decoder := json.NewDecoder(strings.NewReader(o.shapeJSON))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&o.shape) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("desktop-agent: invalid -shape")
	}
	u, err := url.Parse(o.gateway)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("desktop-agent: gateway must be an exact HTTPS origin")
	}
	o.gateway = strings.TrimRight(o.gateway, "/")
	idPattern := regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	if !idPattern.MatchString(o.realm) || !idPattern.MatchString(o.nodeID) || !filepath.IsAbs(o.stateDir) || !filepath.IsAbs(o.installDir) || (o.taskRunnerSocket != "" && !filepath.IsAbs(o.taskRunnerSocket)) || o.maxRuntime <= 0 || o.maxRuntime > 5*time.Minute {
		return errors.New("desktop-agent: realm, node, absolute directories and a runtime limit up to 5m are required")
	}
	if filepath.Clean(o.stateDir) == string(filepath.Separator) || filepath.Clean(o.installDir) == string(filepath.Separator) {
		return errors.New("desktop-agent: dedicated identity and installation directories are required")
	}
	if o.taskRunnerSocket != "" && filepath.Clean(o.taskRunnerSocket) == string(filepath.Separator) {
		return errors.New("desktop-agent: a dedicated task runner socket is required")
	}
	for _, pair := range [][2]string{{o.stateDir, o.installDir}, {o.installDir, o.stateDir}, {o.installDir, o.trustFile}} {
		rel, err := filepath.Rel(pair[0], pair[1])
		if err != nil || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
			return errors.New("desktop-agent: identity, trust and artifact storage must not overlap")
		}
	}
	if err = os.MkdirAll(o.stateDir, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(o.stateDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("desktop-agent: identity directory must not be a symlink")
	}
	if err = os.Chmod(o.stateDir, 0o700); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	id, err := loadIdentity(ctx, o)
	if err != nil {
		return err
	}
	for {
		if !id.ExpiresAt.After(time.Now().Add(time.Hour)) {
			id, err = renewIdentity(ctx, o, id)
			if err != nil {
				return err
			}
		}
		err = connect(ctx, o, id)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			log.Print("desktop-agent: connection interrupted; reconnecting")
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(5 * time.Second):
		}
	}
}

func tlsConfig(o options, id identity) (*tls.Config, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS13}
	if o.caFile != "" {
		raw, err := os.ReadFile(o.caFile)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(raw) {
			return nil, errors.New("desktop-agent: invalid server CA")
		}
		config.RootCAs = pool
	}
	if id.Certificate != "" {
		pair, err := tls.X509KeyPair([]byte(id.Certificate), []byte(id.Key))
		if err != nil {
			return nil, err
		}
		config.Certificates = []tls.Certificate{pair}
	}
	return config, nil
}

func client(o options, id identity) (*http.Client, error) {
	config, err := tlsConfig(o, id)
	if err != nil {
		return nil, err
	}
	return &http.Client{Transport: &http.Transport{TLSClientConfig: config}, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}

func request(ctx context.Context, client *http.Client, endpoint string, input, output any) error {
	raw, err := json.Marshal(input)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return errors.New("desktop-agent: gateway request failed")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("desktop-agent: gateway returned HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(output)
}

func atomicJSON(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".device-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err = f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func csr(id identity) (string, error) {
	block, _ := pem.Decode([]byte(id.Key))
	if block == nil {
		return "", errors.New("desktop-agent: invalid private key")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return "", err
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})), nil
}

func loadIdentity(ctx context.Context, o options) (identity, error) {
	path := filepath.Join(o.stateDir, "identity.json")
	raw, err := os.ReadFile(path)
	if err == nil {
		var id identity
		if json.Unmarshal(raw, &id) != nil || id.Realm != o.realm || id.NodeID != o.nodeID || id.Gateway != o.gateway {
			return id, errors.New("desktop-agent: identity binding mismatch")
		}
		if id.Certificate != "" && o.codeFile == "" {
			return id, nil
		}
		return enroll(ctx, o, id)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return identity{}, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return identity{}, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return identity{}, err
	}
	id := identity{Realm: o.realm, NodeID: o.nodeID, Gateway: o.gateway, Key: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))}
	if err = atomicJSON(path, id); err != nil {
		return id, err
	}
	return enroll(ctx, o, id)
}

func enroll(ctx context.Context, o options, id identity) (identity, error) {
	if o.codeFile == "" {
		return id, errors.New("desktop-agent: first enrollment requires -enrollment-code-file")
	}
	raw, err := os.ReadFile(o.codeFile)
	if err != nil {
		return id, err
	}
	code := strings.TrimSpace(string(raw))
	if len(code) != 43 {
		return id, errors.New("desktop-agent: invalid enrollment code")
	}
	requestCSR, err := csr(id)
	if err != nil {
		return id, err
	}
	httpClient, err := client(o, identity{})
	if err != nil {
		return id, err
	}
	defer httpClient.CloseIdleConnections()
	var response struct {
		Certificate string    `json:"certificate"`
		ExpiresAt   time.Time `json:"expires_at"`
	}
	if err = request(ctx, httpClient, o.gateway+"/device/enroll", map[string]string{"realm": o.realm, "node_id": o.nodeID, "code": code, "csr": requestCSR}, &response); err != nil {
		return id, err
	}
	id.Certificate, id.ExpiresAt = response.Certificate, response.ExpiresAt
	if _, err = tlsConfig(o, id); err != nil {
		return id, err
	}
	return id, atomicJSON(filepath.Join(o.stateDir, "identity.json"), id)
}

func renewIdentity(ctx context.Context, o options, id identity) (identity, error) {
	requestCSR, err := csr(id)
	if err != nil {
		return id, err
	}
	httpClient, err := client(o, id)
	if err != nil {
		return id, err
	}
	defer httpClient.CloseIdleConnections()
	var response struct {
		Certificate string    `json:"certificate"`
		ExpiresAt   time.Time `json:"expires_at"`
	}
	if err = request(ctx, httpClient, o.gateway+"/device/renew", map[string]string{"csr": requestCSR}, &response); err != nil {
		return id, err
	}
	id.Certificate, id.ExpiresAt = response.Certificate, response.ExpiresAt
	if _, err = tlsConfig(o, id); err != nil {
		return id, err
	}
	return id, atomicJSON(filepath.Join(o.stateDir, "identity.json"), id)
}

func connect(parent context.Context, o options, id identity) error {
	tlsConf, err := tlsConfig(o, id)
	if err != nil {
		return err
	}
	dialer := websocket.Dialer{TLSClientConfig: tlsConf, HandshakeTimeout: 10 * time.Second}
	ws, res, err := dialer.DialContext(parent, "wss"+strings.TrimPrefix(o.gateway, "https")+"/device/connect", nil)
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err != nil {
		return errors.New("desktop-agent: device connection failed")
	}
	defer ws.Close()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	ws.SetReadLimit(4 << 20)
	_ = ws.SetReadDeadline(time.Now().Add(30 * time.Second))
	supervisor := artifactruntime.NewSupervisor(5 * time.Second)
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = supervisor.StopAll(shutdown)
	}()
	httpClient, err := client(o, id)
	if err != nil {
		return err
	}
	defer httpClient.CloseIdleConnections()
	installer := provisioner.New(o.gateway+"/device/registry", o.installDir)
	installer.Client = httpClient
	installer.TrustFile = o.trustFile
	var writeMu, snapshotMu sync.Mutex
	snapshot := message{Type: "heartbeat", ClientVersion: o.clientVersion, Error: "reconcile_required"}
	write := func(value message) error {
		if value.Type == "heartbeat" {
			value.OS, value.Arch = runtime.GOOS, runtime.GOARCH
			if value.OS == "darwin" {
				value.OS = "macos"
			}
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return ws.WriteJSON(value)
	}
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		defer ws.Close()
		defer cancel()
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			snapshotMu.Lock()
			value := snapshot
			snapshotMu.Unlock()
			if write(value) != nil {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !id.ExpiresAt.After(time.Now().Add(time.Hour)) {
					return
				}
			}
		}
	}()
	defer func() { cancel(); _ = ws.Close(); <-heartbeatDone }()
	incoming := make(chan message, 8)
	go func() {
		defer close(incoming)
		defer cancel()
		for {
			var next message
			if ws.ReadJSON(&next) != nil {
				return
			}
			_ = ws.SetReadDeadline(time.Now().Add(30 * time.Second))
			// Lease messages are consumed immediately even during a long download.
			if next.Type == "status" {
				continue
			}
			select {
			case incoming <- next:
			case <-ctx.Done():
				return
			}
		}
	}()
	reconcileTimer := time.NewTicker(time.Minute)
	defer reconcileTimer.Stop()
	var desired *policy
	var revision int64
	setSnapshot := func(state *provisioner.InstallState, err error) {
		next := message{Type: "heartbeat", ClientVersion: o.clientVersion, Revision: revision}
		if err != nil || state == nil {
			next.Revision = 0
			next.Error = "install_failed"
		} else {
			for _, item := range state.Installed {
				next.Installed = append(next.Installed, artifact{Name: item.Name, Version: item.Version, Digest: item.Digest, PayloadDigest: item.PayloadDigest})
			}
		}
		snapshotMu.Lock()
		snapshot = next
		snapshotMu.Unlock()
	}
	reconcile := func() error {
		if desired == nil {
			return errors.New("desktop-agent: no approved policy")
		}
		if desired.ClientVersion != o.clientVersion {
			err := errors.New("desktop-agent: client version does not match approved policy")
			setSnapshot(nil, err)
			return err
		}
		state, changed, err := installer.Reconcile(ctx, desired.Name, desired.Version, o.shape)
		setSnapshot(state, err)
		if err != nil || changed {
			_ = supervisor.StopAll(ctx)
		}
		if writeErr := writeSnapshot(&snapshotMu, &snapshot, write); writeErr != nil {
			cancel()
			return writeErr
		}
		return err
	}
	allowed := map[string]bool{}
	for _, digest := range strings.Split(o.allowed, ",") {
		if digest != "" {
			if !regexp.MustCompile(`^sha256:[0-9a-f]{64}$`).MatchString(digest) {
				return errors.New("desktop-agent: invalid locally approved digest")
			}
			allowed[digest] = true
		}
	}
	journal := filepath.Join(o.stateDir, "commands")
	if err = os.MkdirAll(journal, 0o700); err != nil {
		return err
	}
	taskInbox := filepath.Join(o.stateDir, "tasks")
	if err = os.MkdirAll(taskInbox, 0o700); err != nil {
		return err
	}
	// One execution slot per device. The control plane permits up to 16 in-flight
	// commands per node, but that is a delivery budget, not a claim about how many
	// tasks this machine can actually run. Over-capacity work is refused rather
	// than queued: the inbox contract records "received" and has no field for
	// "waiting", so queueing would have to be invented somewhere else.
	taskSlot := make(chan struct{}, 1)
	inflight := &inflightTask{}
	// Runs this device accepted but never finished are still RUNNING in the control
	// plane, and nothing else can close them: the assignment was acknowledged, so
	// the scheduler is waiting for a result this process died before sending. The
	// socket is up by now, which is the earliest moment that repair can be
	// reported. write() is mutex-guarded, so this does not race the heartbeat.
	recoverTaskInbox(taskInbox, o.nodeID, write)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-reconcileTimer.C:
			if err := reconcile(); err != nil {
				log.Print("desktop-agent: artifact reconciliation failed")
			}
		case next, ok := <-incoming:
			if !ok {
				return errors.New("desktop-agent: device disconnected")
			}
			if next.Type == "desired" {
				if next.Policy == nil || next.Revision < 1 {
					return errors.New("desktop-agent: invalid desired policy")
				}
				_ = supervisor.StopAll(ctx)
				desired, revision = next.Policy, next.Revision
				installer.PinnedDigests = map[string]string{}
				for _, item := range desired.Artifacts {
					key := item.Name + "@" + item.Version
					if _, exists := installer.PinnedDigests[key]; exists {
						return errors.New("desktop-agent: duplicate approved artifact")
					}
					installer.PinnedDigests[key] = item.Digest
				}
				if err := reconcile(); err != nil {
					log.Print("desktop-agent: artifact reconciliation failed")
				}
				continue
			}
			if next.Type != "commands" {
				return errors.New("desktop-agent: unknown gateway message")
			}
			for _, cmd := range next.Commands {
				result := message{Type: "result", CommandID: cmd.ID, State: "failed", Result: json.RawMessage(`{"error":"command_denied"}`)}
				if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(cmd.ID) {
					return errors.New("desktop-agent: invalid command ID")
				}
				claimed, err := os.OpenFile(filepath.Join(journal, cmd.ID), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
				if err != nil {
					if !errors.Is(err, os.ErrExist) {
						return err
					}
					if write(result) != nil {
						return errors.New("desktop-agent: result delivery failed")
					}
					continue
				}
				_, err = claimed.WriteString("claimed\n")
				if err == nil {
					err = claimed.Sync()
				}
				closeErr := claimed.Close()
				if err != nil {
					return err
				}
				if closeErr != nil {
					return closeErr
				}
				var acceptedTask taskEnvelope
				// The per-task context is created at acceptance, not when the
				// goroutine starts: a cancel can arrive in the window between the
				// two, and it would have nothing to cancel if registration waited.
				var acceptedContext context.Context
				accepted := false
				if cmd.ExpiresAt.After(time.Now()) && cmd.Revision == revision && desired != nil {
					switch cmd.Action {
					case "execute_task":
						// A device that cannot run tasks must refuse the assignment
						// rather than accept and then report FAILED. Acceptance is
						// what moves the task to RUNNING in the control plane, so
						// accepting work that will never run writes a false
						// RUNNING into the task ledger.
						if o.taskRunnerSocket == "" {
							break
						}
						task, taskErr := cmd.taskBody()
						if taskErr != nil {
							log.Printf("desktop-agent: execute_task body was refused: %v", taskErr)
							break
						}
						slotFree := false
						select {
						case taskSlot <- struct{}{}:
							slotFree = true
						default:
						}
						if !slotFree {
							log.Printf("desktop-agent: task %s refused, an execution is already in flight", task.RunID)
							break
						}
						// The assignment must be durable before it is acknowledged:
						// the control plane treats acceptance as "persisted in the
						// local task inbox", so acknowledging first would be a lie
						// it cannot roll back if this process dies.
						if _, _, inboxErr := persistTaskInbox(taskInbox, cmd.ID, task); inboxErr != nil {
							<-taskSlot
							log.Printf("desktop-agent: task %s was not persisted locally: %v", task.RunID, inboxErr)
							break
						}
						taskCtx, taskCancel := context.WithCancel(ctx)
						inflight.begin(task.RunID, taskCancel)
						acceptedTask, acceptedContext, accepted = task, taskCtx, true
						result.State = "completed"
						result.Result = json.RawMessage(`{"accepted":true}`)
					case "cancel_task":
						// Cancelling is not a state change in this process: the run
						// either stops — and then reports CANCELLED through the ordinary
						// result path, which owns the receipt, its immutability and its
						// fencing — or it was never in flight and there is nothing to
						// report. "Nothing to cancel" is an answer rather than a failure
						// (the command normally arrived just after the task finished), so
						// this is acknowledged either way and the flag is what lets the
						// control plane tell the two apart.
						//
						// Gated by Revision like every other command, so the issuer has to
						// send the revision this connection is on rather than the one the
						// task was placed under: a policy that changed since placement
						// must not make a stop unreachable.
						task, taskErr := cmd.taskBody()
						if taskErr != nil {
							log.Printf("desktop-agent: cancel_task body was refused: %v", taskErr)
							break
						}
						stopped := inflight.cancelIfRun(task.RunID)
						if !stopped {
							log.Printf("desktop-agent: cancel for %s matched no in-flight run", task.RunID)
						}
						result.State = "completed"
						result.Result, _ = json.Marshal(map[string]bool{"cancelled": stopped})
					case "reconcile":
						if reconcile() == nil {
							result.State = "completed"
							result.Result = json.RawMessage(`{"converged":true}`)
						}
					case "start":
						body, bodyErr := cmd.runtimeBody()
						if bodyErr != nil {
							break
						}
						consented := false
						for _, item := range desired.Artifacts {
							if item.Name == body.Name && item.Version == body.Version && allowed[item.Digest] {
								consented = true
							}
						}
						if consented && reconcile() == nil && ctx.Err() == nil && cmd.ExpiresAt.After(time.Now()) {
							spec, err := installer.RuntimeSpec(body.Name, body.Version)
							if err == nil {
								status, err := supervisor.Start(spec)
								if err == nil {
									result.State = "completed"
									result.Result, _ = json.Marshal(status)
									go func(runtimeID string, startedAt time.Time) {
										select {
										case <-ctx.Done():
										case <-time.After(o.maxRuntime):
										}
										stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
										defer cancel()
										if current, ok := supervisor.Status(runtimeID); ok && current.StartedAt.Equal(startedAt) {
											_, _ = supervisor.Stop(stop, runtimeID)
										}
									}(spec.ID, status.StartedAt)
								}
							}
						}
					case "stop":
						body, bodyErr := cmd.runtimeBody()
						if bodyErr != nil {
							break
						}
						status, err := supervisor.Stop(ctx, body.Name+"@"+body.Version)
						if err == nil {
							result.State = "completed"
							result.Result, _ = json.Marshal(status)
						}
					}
				}
				if write(result) != nil {
					return errors.New("desktop-agent: result delivery failed")
				}
				// Acceptance is on the wire before execution begins. The control
				// plane refuses a task result for a command it has not already seen
				// accepted, so this goroutine must not start any earlier -- and it
				// must not run inline, or a long task would stall the heartbeat.
				if accepted {
					go func(commandID string, task taskEnvelope, taskCtx context.Context) {
						defer func() { <-taskSlot }()
						// Deregisters before the slot is released, so a cancel that
						// arrives after the run ends finds nothing rather than
						// stopping whatever takes the slot next. clear() is keyed by
						// run ID, so a replacement that already began is untouched.
						defer inflight.clear(task.RunID)
						finishDeviceTask(taskCtx, write, o.taskRunnerSocket, o.nodeID, taskInbox, commandID, task)
					}(cmd.ID, acceptedTask, acceptedContext)
				}
			}
		}
	}
}

func writeSnapshot(mu *sync.Mutex, snapshot *message, write func(message) error) error {
	mu.Lock()
	value := *snapshot
	mu.Unlock()
	return write(value)
}
