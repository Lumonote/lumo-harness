package store

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

// schedulerTasksWithCancellation creates the one scheduler table this bridge reads.
// The real table belongs to the scheduler service; governance only ever reads
// task_id and state from it, so the fixture carries exactly those columns -- the
// same shape internal/device's fixture uses for the same reason.
func schedulerTasksWithCancellation(t *testing.T, s *Store) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), `CREATE TABLE IF NOT EXISTS scheduler_tasks (
	  task_id TEXT NOT NULL, attempt INTEGER NOT NULL, node_id TEXT NOT NULL,
	  state TEXT NOT NULL, PRIMARY KEY (task_id, attempt, node_id))`); err != nil {
		t.Fatal(err)
	}
}

func setSchedulerState(t *testing.T, s *Store, runID, state string) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(),
		`INSERT INTO scheduler_tasks(task_id,attempt,node_id,state) VALUES ($1,1,'device-a',$2)`, runID, state); err != nil {
		t.Fatal(err)
	}
}

func countCancels(t *testing.T, s *Store, runID string) int {
	t.Helper()
	return countRows(t, s, `SELECT count(*) FROM governance_device_commands
	  WHERE action='cancel_task' AND run_id=$1`, runID)
}

// A cancelled scheduler task has to reach the device that is running it. Until
// this bridge existed the two halves were simply not connected: the scheduler set
// CANCELLING, the device knew how to stop a run, and nothing carried one to the
// other. The task therefore kept running -- and on a single-slot device it kept
// the only execution slot occupied as well, which is why "cancel does nothing"
// degrades into "this machine is stuck".
func TestDispatchDeviceCancellationReachesTheRunningDevice(t *testing.T) {
	s := taskTestStore(t)
	schedulerTasksWithCancellation(t, s)
	ctx := context.Background()
	seedResultTask(t, s, "task", "")
	seedDeviceCommand(t, s, "task", "task-run-1", "device-a", "conn-a", "delivered")
	// Pin a body on the assignment that the cancel has to carry over. The marker
	// key is what makes "carried" distinguishable from "rebuilt": dispatchDeviceTask
	// builds the envelope from a fixed key set and would never produce it, so a
	// rebuilt body fails this assertion while a copied one passes.
	const marker = `{"run_id":"task-run-1","attempt":1,"marker":"carried-verbatim"}`
	if _, err := s.pool.Exec(ctx, `UPDATE governance_device_commands SET body=$1
	  WHERE action='execute_task' AND run_id='task-run-1'`, marker); err != nil {
		t.Fatal(err)
	}
	setSchedulerState(t, s, "task-run-1", "CANCELLING")

	n, err := s.DispatchDeviceCancellations(ctx, 4)
	if err != nil || n != 1 {
		t.Fatalf("dispatched %d cancellations, err=%v", n, err)
	}
	if got := countCancels(t, s, "task-run-1"); got != 1 {
		t.Fatalf("cancel rows = %d", got)
	}

	var action, nodeID, sessionRef string
	var body []byte
	if err := s.pool.QueryRow(ctx, `SELECT action,node_id,session_ref,body FROM governance_device_commands
	  WHERE action='cancel_task' AND run_id='task-run-1'`).Scan(&action, &nodeID, &sessionRef, &body); err != nil {
		t.Fatal(err)
	}
	// Addressed to the device that holds the run, and on the same session: the
	// device matches a cancel against the run it is executing, so a cancel that
	// lost either of these would arrive unable to identify its target.
	if nodeID != "device-a" || sessionRef != "task-session" {
		t.Fatalf("cancel addressed %s/%s", nodeID, sessionRef)
	}
	var envelope map[string]any
	if json.Unmarshal(body, &envelope) != nil || envelope["marker"] != "carried-verbatim" {
		t.Fatalf("cancel body was rebuilt rather than carried over: %s", body)
	}
	if n := countRows(t, s, `SELECT count(*) FROM governance_task_audit
	  WHERE task_id='task' AND event='device_execution_cancel_requested'`); n != 1 {
		t.Fatalf("cancel audit rows = %d", n)
	}

	// The loop runs every second, so a second pass must find nothing left to do
	// rather than piling up cancels for the same run.
	if n, err := s.DispatchDeviceCancellations(ctx, 4); err != nil || n != 0 {
		t.Fatalf("second pass dispatched %d, err=%v", n, err)
	}
	if got := countCancels(t, s, "task-run-1"); got != 1 {
		t.Fatalf("cancel rows after a repeat pass = %d", got)
	}
}

// Only a real cancellation produces a cancel. A task that is still running, or one
// that already finished, must not generate stop commands: the device answers
// "not in flight" to those, which is noise on the wire and noise in the audit
// trail, and it would train whoever reads the trail to ignore it.
func TestDispatchDeviceCancellationIgnoresTasksNobodyCancelled(t *testing.T) {
	s := taskTestStore(t)
	schedulerTasksWithCancellation(t, s)
	seedResultTask(t, s, "task", "")
	seedDeviceCommand(t, s, "task", "task-run-1", "device-a", "conn-a", "delivered")
	setSchedulerState(t, s, "task-run-1", "RUNNING")

	if n, err := s.DispatchDeviceCancellations(context.Background(), 4); err != nil || n != 0 {
		t.Fatalf("dispatched %d cancellations for a running task, err=%v", n, err)
	}
}

// A cancel must get through to a device already at its in-flight cap. The cap is a
// delivery budget for work, and the device holding the most work is exactly the
// one that most needs to be stoppable -- so the cancellation path deliberately
// does not consult it. This is the test that would fail if the two paths were ever
// merged back together.
func TestDispatchDeviceCancellationIgnoresTheInflightCap(t *testing.T) {
	s := taskTestStore(t)
	schedulerTasksWithCancellation(t, s)
	ctx := context.Background()
	seedResultTask(t, s, "task", "")
	seedDeviceCommand(t, s, "task", "task-run-1", "device-a", "conn-a", "delivered")
	for i := 0; i < 16; i++ {
		if _, err := s.pool.Exec(ctx, `INSERT INTO governance_device_commands
		  (id,realm,node_id,actor_id,revision,connection_id,action,state,expires_at)
		  VALUES ($1,'realm','device-a','operator',1,'conn-a','reconcile','queued',now()+interval '5 minutes')`,
			fmt.Sprintf("filler-%02d", i)); err != nil {
			t.Fatal(err)
		}
	}
	setSchedulerState(t, s, "task-run-1", "CANCELLING")

	if n, err := s.DispatchDeviceCancellations(ctx, 4); err != nil || n != 1 {
		t.Fatalf("dispatched %d cancellations at the in-flight cap, err=%v", n, err)
	}
}
