package domain

import (
	"testing"
	"time"
)

func TestProgressRequiresActionableBlockers(t *testing.T) {
	good := TaskProgressUpdate{RunID: "r", Status: "blocked", Percent: 35, Summary: "Implemented the query", NextStep: "Obtain staging access", BlockedReason: "Missing staging grant"}
	for _, change := range []func(*TaskProgressUpdate){
		func(p *TaskProgressUpdate) { p.Percent = 101 },
		func(p *TaskProgressUpdate) { p.Percent = -1 },
		func(p *TaskProgressUpdate) { p.ExpectedRevision = -1 },
		func(p *TaskProgressUpdate) { p.Status = "completed" },
		func(p *TaskProgressUpdate) { p.BlockedReason = "" },
		func(p *TaskProgressUpdate) { p.NextStep = "" },
		func(p *TaskProgressUpdate) { p.Status = "on_track" },
	} {
		invalid := good
		change(&invalid)
		if err := invalid.Validate(); err == nil {
			t.Fatalf("invalid progress accepted: %+v", invalid)
		}
	}
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestProgressHealthKeepsAttemptAndAcceptanceBoundaries(t *testing.T) {
	now := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	old := now.Add(-25 * time.Hour)
	task := DelegatedTask{State: DelegationRunning, BusinessState: BusinessExecuting, CreatedAt: old}
	run := TaskRun{ID: "r2", State: DelegationRunning, CreatedAt: now}
	p := TaskProgress{RunID: "r1", Percent: 100, Status: "blocked", DueAt: &old, UpdatedAt: old}
	if h := ProgressHealth(task, &run, &p, now); h.Blocked || h.Overdue || h.Stale {
		t.Fatalf("old attempt affected health: %+v", h)
	}
	p.RunID = run.ID
	if h := ProgressHealth(task, &run, &p, now); !h.Blocked || !h.Overdue || !h.Stale {
		t.Fatalf("current warning disappeared: %+v", h)
	}
	if !TaskProgressWritable(task, run) {
		t.Fatal("active run should accept a checkpoint")
	}
	task.State = DelegationCompleted
	task.BusinessState = BusinessInReview
	if TaskProgressWritable(task, run) {
		t.Fatal("completed execution accepted new progress")
	}
	h := ProgressHealth(task, &run, &p, now)
	s := SummarizeWorkforce([]WorkforceProgressItem{{Task: task, Run: &run, Progress: &p, Health: h}})
	if !h.AwaitingReview || s.Accepted != 0 {
		t.Fatalf("100 percent bypassed acceptance: %+v", s)
	}
	task.BusinessState = BusinessDone
	if h := ProgressHealth(task, &run, &p, now); h.Blocked || h.Overdue || h.Stale {
		t.Fatalf("accepted task still alerted: %+v", h)
	}
}
