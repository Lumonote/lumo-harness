package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

// seedDeviceCommand stages the node, the connection lease and one execute_task
// command exactly as the device gateway leaves them once it has handed the
// assignment to a device.
//
// state is written directly rather than driven through CompleteDeviceCommand
// because that method's acceptance path also demands PLACED scheduler rows; the
// only thing these tests need from it is its outcome, which is the precondition
// RecordDeviceTaskResult is defined against.
func seedDeviceCommand(t *testing.T, s *Store, taskID, runID, nodeID, connection, state string) (commandID string) {
	t.Helper()
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_desktop_nodes
	  (realm,id,cluster_id,owner_user_id,display_name,os,arch,client_version,capacity,status,scheduling_eligible)
	  VALUES ('realm',$1,'cluster','employee',$1,'macos','amd64','1.0.0',4,'ONLINE',true)`, nodeID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_device_connections
	  (realm,node_id,revision,public_key_hash,certificate_serial,certificate_expires,connection_id,connection_expires,applied_revision)
	  VALUES ('realm',$1,1,'hash','serial',now()+interval '1 hour',$2,now()+interval '1 hour',1)`,
		nodeID, connection); err != nil {
		t.Fatal(err)
	}
	commandID = "cmd-" + nodeID
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_device_commands
	  (id,realm,node_id,actor_id,revision,connection_id,action,state,expires_at,run_id,attempt,session_ref)
	  VALUES ($1,'realm',$2,'device-gateway',1,$3,'execute_task',$4,now()+interval '5 minutes',$5,1,$6)`,
		commandID, nodeID, connection, state, runID, taskID+"-session"); err != nil {
		t.Fatal(err)
	}
	return commandID
}

func storedResult(t *testing.T, s *Store, runID string) domain.TaskResult {
	t.Helper()
	var payload []byte
	if err := s.pool.QueryRow(context.Background(),
		`SELECT payload FROM governance_task_results WHERE run_id=$1`, runID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var stored domain.TaskResult
	if err := json.Unmarshal(payload, &stored); err != nil {
		t.Fatal(err)
	}
	return stored
}

func countRows(t *testing.T, s *Store, query string, args ...any) int {
	t.Helper()
	var n int
	if err := s.pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestDeviceResultRequiresAcceptanceAndReusesTheReceiptPath(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "parent", "")
	seedResultTask(t, s, "task", "parent")
	commandID := seedDeviceCommand(t, s, "task", "task-run-1", "device-a", "conn-a", "delivered")

	// A device that reports a result before it acknowledged the assignment would
	// skip the PLACED -> RUNNING transition entirely.
	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "conn-a", commandID, resultFor("task")); !errors.Is(err, ErrConflict) {
		t.Fatalf("result accepted before the command was acknowledged: %v", err)
	}
	if n := countRows(t, s, `SELECT count(*) FROM governance_task_results WHERE task_id='task'`); n != 0 {
		t.Fatalf("results written for an unacknowledged command: %d", n)
	}

	if _, err := s.pool.Exec(ctx, `UPDATE governance_device_commands SET state='completed' WHERE id=$1`, commandID); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "conn-a", commandID, resultFor("task")); err != nil {
		t.Fatal(err)
	}
	// Replay is idempotent; a different payload for the same run is not. Both
	// come from the shared receipt path, not from a device-specific INSERT.
	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "conn-a", commandID, resultFor("task")); err != nil {
		t.Fatalf("device receipt replay: %v", err)
	}
	changed := resultFor("task")
	changed.Summary = "a different outcome"
	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "conn-a", commandID, changed); !errors.Is(err, ErrConflict) {
		t.Fatalf("device result was mutable: %v", err)
	}
	if n := countRows(t, s, `SELECT count(*) FROM governance_task_results WHERE task_id='task'`); n != 1 {
		t.Fatalf("result rows = %d", n)
	}

	task, err := s.GetDelegationTask(ctx, "realm", "task")
	if err != nil || task.BusinessState != domain.BusinessVerifying {
		t.Fatalf("task after device result: %#v, %v", task, err)
	}
	// The actor distinguishes a device report from a worker report in the audit
	// trail; losing it would make the two indistinguishable after the fact.
	if n := countRows(t, s, `SELECT count(*) FROM governance_task_audit WHERE task_id='task' AND event='execution_result' AND actor='device:device-a'`); n != 1 {
		t.Fatalf("device execution_result audit rows = %d", n)
	}
	// The parent notification proves the device path shares the whole receipt
	// transaction rather than reimplementing the writes.
	if n := countRows(t, s, `SELECT count(*) FROM governance_task_audit WHERE task_id='parent' AND event='child_result'`); n != 1 {
		t.Fatalf("parent notifications = %d", n)
	}
	if stored := storedResult(t, s, "task-run-1"); stored.NodeID != "device-a" || stored.SessionRef != "task-session" {
		t.Fatalf("stored result identity = %#v", stored)
	}
}

func TestDeviceResultIdentityIsTakenFromTheCommandRow(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "task", "")
	commandID := seedDeviceCommand(t, s, "task", "task-run-1", "device-a", "conn-a", "completed")

	// Every one of these is a device claiming to speak for something the command
	// row says it does not own. They are refused rather than silently corrected,
	// because this is the entry point for writing into someone else's run.
	for name, mutate := range map[string]func(*domain.TaskResult){
		"run":     func(r *domain.TaskResult) { r.RunID = "other-run" },
		"session": func(r *domain.TaskResult) { r.SessionRef = "other-session" },
		"task":    func(r *domain.TaskResult) { r.TaskID = "other-task" },
	} {
		foreign := resultFor("task")
		mutate(&foreign)
		if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "conn-a", commandID, foreign); !errors.Is(err, ErrConflict) {
			t.Fatalf("foreign %s accepted: %v", name, err)
		}
	}

	// The node identity is the authenticated connection's, not the payload's:
	// it is the one field a device cannot influence, so it is overwritten.
	spoofed := resultFor("task")
	spoofed.NodeID = "device-elsewhere"
	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "conn-a", commandID, spoofed); err != nil {
		t.Fatal(err)
	}
	if stored := storedResult(t, s, "task-run-1"); stored.NodeID != "device-a" {
		t.Fatalf("payload node identity survived: %q", stored.NodeID)
	}
}

func TestDeviceResultCannotWriteAnotherDevicesRun(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	// The run is bound to device-a; device-b holds a command that names it.
	seedResultTask(t, s, "task", "")
	commandID := seedDeviceCommand(t, s, "task", "task-run-1", "device-b", "conn-b", "completed")

	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-b", "conn-b", commandID, resultFor("task")); !errors.Is(err, ErrConflict) {
		t.Fatalf("device-b wrote device-a's run: %v", err)
	}
	if n := countRows(t, s, `SELECT count(*) FROM governance_task_results WHERE task_id='task'`); n != 0 {
		t.Fatalf("cross-device result rows = %d", n)
	}
}

func TestDeviceResultHonoursTheConnectionFence(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "task", "")
	commandID := seedDeviceCommand(t, s, "task", "task-run-1", "device-a", "conn-a", "completed")
	result := resultFor("task")

	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "stale-conn", commandID, result); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale connection accepted: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE governance_device_connections SET connection_expires=now()-interval '1 minute' WHERE node_id='device-a'`); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "conn-a", commandID, result); !errors.Is(err, ErrConflict) {
		t.Fatalf("expired connection accepted: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE governance_device_connections SET connection_expires=now()+interval '1 hour',revision=2 WHERE node_id='device-a'`); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "conn-a", commandID, result); !errors.Is(err, ErrConflict) {
		t.Fatalf("revision drift accepted: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE governance_device_connections SET revision=1 WHERE node_id='device-a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE governance_desktop_nodes SET status='REVOKED' WHERE id='device-a'`); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "conn-a", commandID, result); !errors.Is(err, ErrConflict) {
		t.Fatalf("revoked node accepted: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE governance_desktop_nodes SET status='ONLINE' WHERE id='device-a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE governance_users SET status='suspended' WHERE id='employee'`); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "conn-a", commandID, result); !errors.Is(err, ErrConflict) {
		t.Fatalf("suspended owner accepted: %v", err)
	}
}

func TestDeviceResultOnlyAppliesToTaskCommandsWithALiveRun(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "task", "")
	commandID := seedDeviceCommand(t, s, "task", "task-run-1", "device-a", "conn-a", "completed")
	if _, err := s.pool.Exec(ctx, `UPDATE governance_device_commands SET action='reconcile',run_id='',session_ref='' WHERE id=$1`, commandID); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-a", "conn-a", commandID, resultFor("task")); !errors.Is(err, ErrConflict) {
		t.Fatalf("non-task command accepted a task result: %v", err)
	}

	// A command whose run is gone cannot supply the authoritative identity, so
	// the result must be refused rather than trusted on the device's word.
	ghost := seedDeviceCommand(t, s, "ghost", "ghost-run-1", "device-c", "conn-c", "completed")
	orphan := resultFor("ghost")
	if err := s.RecordDeviceTaskResult(ctx, "realm", "device-c", "conn-c", ghost, orphan); !errors.Is(err, ErrConflict) {
		t.Fatalf("result accepted for a missing run: %v", err)
	}
}
