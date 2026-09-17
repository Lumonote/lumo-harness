package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func readReceipt(t *testing.T, dir, runID string) taskReceipt {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, runID+taskReceiptSuffix))
	if err != nil {
		t.Fatalf("receipt for %s: %v", runID, err)
	}
	var receipt taskReceipt
	if err := json.Unmarshal(raw, &receipt); err != nil {
		t.Fatalf("receipt for %s is invalid: %v", runID, err)
	}
	return receipt
}

// The control plane unmarshals this payload straight into its own TaskResult
// type, so the key set is a wire contract, not an implementation detail. A
// renamed or dropped key is rejected there, which drops the device connection
// rather than reporting a result -- loud, but only at runtime.
func TestTaskResultPayloadMatchesTheControlPlaneContract(t *testing.T) {
	receipt := taskReceipt{
		Version: 1, CommandID: "cmd", State: "COMPLETED", Summary: "done",
		Task:   taskEnvelope{TaskID: "task", RunID: "run", SessionRef: "session"},
		Output: json.RawMessage(`{"a":1}`),
	}
	raw, err := taskResultPayload(receipt, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"task_id": `"task"`, "run_id": `"run"`, "state": `"COMPLETED"`,
		"session_ref": `"session"`, "node_id": `"device-a"`, "summary": `"done"`,
		"output": `{"a":1}`,
	}
	if len(payload) != len(want) {
		t.Fatalf("payload keys = %v", payload)
	}
	for key, value := range want {
		if string(payload[key]) != value {
			t.Fatalf("%s = %s, want %s", key, payload[key], value)
		}
	}
	// An empty output is omitted rather than sent as null: the gateway caps a
	// single inbound frame at 1 MiB, and a task runner may legitimately return
	// nothing to say.
	receipt.Output = nil
	raw, err = taskResultPayload(receipt, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "output") {
		t.Fatalf("empty output was serialised: %s", raw)
	}
}

// Acceptance means "this run is durably recorded here". The control plane cannot
// roll that back, so a re-bind must fail rather than quietly replace the record.
func TestTaskInboxIsImmutableAndIdempotent(t *testing.T) {
	dir := t.TempDir()
	task := taskEnvelope{TaskID: "task", RunID: "run", Attempt: 1, WorkerID: "user:employee",
		ProjectID: "project", Title: "title", Intent: "intent", SessionRef: "session"}
	if _, created, err := persistTaskInbox(dir, "cmd-1", task); err != nil || !created {
		t.Fatalf("first inbox write: created=%v err=%v", created, err)
	}
	if _, created, err := persistTaskInbox(dir, "cmd-1", task); err != nil || created {
		t.Fatalf("inbox replay: created=%v err=%v", created, err)
	}
	if _, _, err := persistTaskInbox(dir, "cmd-2", task); err == nil {
		t.Fatal("run was re-bound to a second command")
	}
	other := task
	other.Intent = "different intent"
	if _, _, err := persistTaskInbox(dir, "cmd-1", other); err == nil {
		t.Fatal("run was re-bound to a different task")
	}
}

func TestTaskReceiptIsImmutable(t *testing.T) {
	dir := t.TempDir()
	receipt := taskReceipt{Version: 1, CommandID: "cmd", Task: taskEnvelope{TaskID: "task", RunID: "run"},
		State: "COMPLETED", Summary: "done", UpdatedAt: time.Unix(0, 0).UTC()}
	if err := persistTaskReceipt(dir, receipt); err != nil {
		t.Fatal(err)
	}
	if err := persistTaskReceipt(dir, receipt); err != nil {
		t.Fatalf("receipt replay: %v", err)
	}
	receipt.Summary = "changed"
	if err := persistTaskReceipt(dir, receipt); err == nil {
		t.Fatal("receipt was overwritten")
	}
}

// The command switch refuses execute_task before it ever calls the runner; this
// pins the second line of defence, and the shape of the runner's reply.
// The production sequence is inbox-then-receipt in the **same** directory:
// `execute_task` persists the inbox record, and `finishDeviceTask` later persists
// the receipt beside it. Each helper has its own test above, but each of those is
// handed a fresh t.TempDir() — so neither ever sees the other's file, and the one
// thing that never gets exercised is the sequence that actually runs.
//
// This test walks that sequence, because "both helpers are correct in isolation"
// is precisely what a shared-path collision looks like from the inside.
func TestReceiptLandsAfterTheInboxRecordInTheSameDirectory(t *testing.T) {
	dir := t.TempDir()
	task := taskEnvelope{TaskID: "task", RunID: "run", Attempt: 1, WorkerID: "user:employee",
		ProjectID: "project", Title: "title", Intent: "intent", SessionRef: "session"}
	if _, _, err := persistTaskInbox(dir, "cmd-1", task); err != nil {
		t.Fatalf("inbox: %v", err)
	}
	receipt := taskReceipt{Version: 1, CommandID: "cmd-1", Task: task,
		State: "COMPLETED", Summary: "done", UpdatedAt: time.Unix(0, 0).UTC()}
	if err := persistTaskReceipt(dir, receipt); err != nil {
		t.Fatalf("receipt after inbox in the same directory: %v", err)
	}
}

func TestTaskRunnerContract(t *testing.T) {
	task := taskEnvelope{TaskID: "task", RunID: "run"}
	if _, err := runTaskRunner(context.Background(), "", "cmd", task); err == nil {
		t.Fatal("a device without a runner socket accepted a task")
	}
	if _, err := runTaskRunner(context.Background(), filepath.Join(t.TempDir(), "absent.sock"), "cmd", task); err == nil {
		t.Fatal("an unreachable runner was treated as success")
	}

	socket := filepath.Join(t.TempDir(), "runner.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Skipf("unix sockets are unavailable here: %v", err)
	}
	defer listener.Close()
	replies := make(chan taskRunnerResponse, 4)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			var request taskRunnerRequest
			_ = json.NewDecoder(conn).Decode(&request)
			_ = json.NewEncoder(conn).Encode(<-replies)
			_ = conn.Close()
		}
	}()

	replies <- taskRunnerResponse{State: "COMPLETED", Summary: "delivered"}
	resp, err := runTaskRunner(context.Background(), socket, "cmd", task)
	if err != nil || resp.State != "COMPLETED" || resp.Summary != "delivered" {
		t.Fatalf("runner response = %#v, %v", resp, err)
	}

	// A state the control plane does not model must not be forwarded verbatim.
	replies <- taskRunnerResponse{State: "BROKEN", Summary: "?"}
	if _, err := runTaskRunner(context.Background(), socket, "cmd", task); err == nil {
		t.Fatal("an unmodelled runner state was accepted")
	}
	// COMPLETED without a deliverable would be recorded as a finished task.
	replies <- taskRunnerResponse{State: "COMPLETED"}
	if _, err := runTaskRunner(context.Background(), socket, "cmd", task); err == nil {
		t.Fatal("a completed task without a deliverable was accepted")
	}
}

// A cancel has to reach the running task, not merely be recorded. The delivery
// mechanism is the run's own context, so this pins the wiring that makes the
// match mean something.
func TestCancelStopsTheMatchingRun(t *testing.T) {
	var f inflightTask
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.begin("run-1", cancel)
	if !f.cancelIfRun("run-1") {
		t.Fatal("cancel did not match the in-flight run")
	}
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatalf("the run's context was not cancelled: %v", ctx.Err())
	}
}

// A cancel for anything else stops nothing, and says so. It normally arrives just
// after the task finished, so reporting it as a failure would turn an ordinary
// race into an incident -- but so would acknowledging a stop that never happened.
func TestCancelOfAnUnknownRunStopsNothing(t *testing.T) {
	var f inflightTask
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.begin("run-1", cancel)
	if f.cancelIfRun("run-2") {
		t.Fatal("cancel matched a run that was not in flight")
	}
	if ctx.Err() != nil {
		t.Fatal("an unmatched cancel stopped a run")
	}
	if !f.cancelIfRun("run-1") {
		t.Fatal("the in-flight run became unreachable after a missed cancel")
	}
}

// A run that overwrites a newer registration would make the newer run
// uncancellable, and a cancelled run and its replacement do overlap briefly.
func TestClearLeavesANewerRunRegistered(t *testing.T) {
	var f inflightTask
	_, cancelFirst := context.WithCancel(context.Background())
	defer cancelFirst()
	f.begin("run-1", cancelFirst)
	_, cancelSecond := context.WithCancel(context.Background())
	defer cancelSecond()
	f.begin("run-2", cancelSecond)
	f.clear("run-1") // the cancelled run finishing late
	if !f.cancelIfRun("run-2") {
		t.Fatal("the replacement run was deregistered by its predecessor")
	}
}

// A cancelled run is CANCELLED, not FAILED. No runner is configured here, so the
// runner always errors -- the only thing that can produce CANCELLED is the context,
// which is exactly the distinction: the state must come from the cancellation
// rather than from the error that follows it. FAILED would put a false failure
// into the task ledger for work an operator deliberately stopped.
func TestCancelledRunIsRecordedAsCancelledNotFailed(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var delivered []message
	write := func(m message) error { delivered = append(delivered, m); return nil }
	task := taskEnvelope{TaskID: "task", RunID: "run", SessionRef: "session"}
	finishDeviceTask(ctx, write, "", "device-a", dir, "cmd-1", task)

	if got := readReceipt(t, dir, "run").State; got != "CANCELLED" {
		t.Fatalf("cancelled run was recorded as %q", got)
	}
	if len(delivered) != 1 || delivered[0].Type != "task_result" {
		t.Fatalf("the outcome was not reported over the result channel: %+v", delivered)
	}
}

// A device that dies mid-run leaves an inbox record with no receipt, and the
// control plane keeps that run RUNNING forever: the assignment was acknowledged,
// so the scheduler is waiting for a result nothing will ever send. A restart is
// the one moment the device can repair it.
func TestRestartReportsRunsThatNeverFinished(t *testing.T) {
	dir := t.TempDir()
	task := taskEnvelope{TaskID: "task", RunID: "run", SessionRef: "session"}
	if _, _, err := persistTaskInbox(dir, "cmd-1", task); err != nil {
		t.Fatal(err)
	}
	var delivered []message
	recoverTaskInbox(dir, "device-a", func(m message) error { delivered = append(delivered, m); return nil })

	if len(delivered) != 1 {
		t.Fatalf("expected exactly one recovered result, got %d", len(delivered))
	}
	receipt := readReceipt(t, dir, "run")
	if receipt.State != "FAILED" {
		t.Fatalf("recovered run was recorded as %q", receipt.State)
	}
	// The summary names the cause, because "the runner failed" and "this machine
	// restarted" lead to different investigations.
	if !strings.Contains(receipt.Summary, "restarted") {
		t.Fatalf("summary does not say what happened: %q", receipt.Summary)
	}
}

// Recovery must leave finished work alone: the receipt is the record that it
// finished, and re-sending it would be a duplicate result for the same run.
func TestRestartLeavesFinishedRunsAlone(t *testing.T) {
	dir := t.TempDir()
	task := taskEnvelope{TaskID: "task", RunID: "run", SessionRef: "session"}
	if _, _, err := persistTaskInbox(dir, "cmd-1", task); err != nil {
		t.Fatal(err)
	}
	if err := persistTaskReceipt(dir, taskReceipt{Version: 1, CommandID: "cmd-1", Task: task,
		State: "COMPLETED", Summary: "done", UpdatedAt: time.Unix(0, 0).UTC()}); err != nil {
		t.Fatal(err)
	}
	var delivered []message
	recoverTaskInbox(dir, "device-a", func(m message) error { delivered = append(delivered, m); return nil })
	if len(delivered) != 0 {
		t.Fatalf("recovery re-reported a finished run: %+v", delivered)
	}
}
