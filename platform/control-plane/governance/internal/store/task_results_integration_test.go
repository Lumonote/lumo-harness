package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

func taskTestStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN is required for task transaction tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	schema := "lumo_task_" + hex.EncodeToString(suffix[:])
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	s := New(pool)
	if err := s.Init(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Init(ctx); err != nil {
		t.Fatalf("schema migration is not idempotent: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO governance_users(realm,id,display_name,status) VALUES ('realm','manager','Manager','active'),('realm','employee','Employee','active')`); err != nil {
		t.Fatal(err)
	}
	return s
}

func seedResultTask(t *testing.T, s *Store, id, parent string) domain.DelegatedTask {
	t.Helper()
	task := domain.DelegatedTask{ID: id, Realm: "realm", Title: id, Intent: "produce " + id,
		RequesterUserID: "manager", AssigneeUserID: "employee", AssigneeWorkerID: "user:employee",
		State: domain.DelegationRunning, BusinessState: domain.BusinessExecuting,
		IntentContract: &domain.IntentContract{ParentTaskID: parent, AcceptanceCriteria: []string{"cited result"}}}
	task, _, err := s.CreateDelegatedTaskWithRun(context.Background(), task, domain.TaskRun{
		ID: id + "-run-1", WorkerID: "user:employee", AssignedNodeID: "device-a", State: domain.DelegationRunning,
	})
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func resultFor(id string) domain.TaskResult {
	return domain.TaskResult{TaskID: id, RunID: id + "-run-1", State: domain.DelegationCompleted,
		NodeID: "device-a", SessionRef: id + "-session", Summary: "analysis delivered", Output: json.RawMessage(`{"a":1,"b":2}`)}
}

// passingGate 是 §24.7 组合验证闸门的通过事实（P6c）。本文件测的是验收链本身，
// 不是闸门——闸门的判据与打回落点由 internal/domain/coordinator_test.go 覆盖，
// 这里只负责把 `complete` 这条边喂成「验证通过」，让验收链的断言保持原意。
func passingGate() domain.IntegrationGateFacts {
	return domain.IntegrationGateFacts{ContractTestsPass: true, SmokePass: true}
}

func reviewResult(t *testing.T, s *Store, id string) {
	t.Helper()
	for _, event := range []string{"submit_review", "complete"} {
		if _, err := s.TransitionBusinessTask(context.Background(), "realm", id, event, "manager", passingGate()); err != nil {
			t.Fatal(err)
		}
	}
}

func TestResultReceiptAndParentAcceptance(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "parent", "")
	seedResultTask(t, s, "child", "parent")
	if _, err := s.RecordTaskResult(ctx, "realm", resultFor("parent"), "runtime"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", "parent", "submit_review", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	// 子任务未验收是**结构前置条件**（ErrConflict，不改状态），它先于 §24.7 闸门判定，
	// 所以这里喂通过事实：要断言的是「过早验收被拒」，不是「闸门打回」。
	if _, err := s.TransitionBusinessTask(ctx, "realm", "parent", "complete", "manager", passingGate()); !errors.Is(err, ErrConflict) {
		t.Fatalf("premature completion: %v", err)
	}
	first, err := s.RecordTaskResult(ctx, "realm", resultFor("child"), "runtime")
	if err != nil {
		t.Fatal(err)
	}
	replay := resultFor("child")
	replay.Output = json.RawMessage(`{ "b": 2, "a": 1 }`)
	second, err := s.RecordTaskResult(ctx, "realm", replay, "runtime")
	if err != nil || !first.CreatedAt.Equal(second.CreatedAt) {
		t.Fatalf("receipt replay changed: %#v, %v", second, err)
	}
	replay.Summary = "different output"
	if _, err := s.RecordTaskResult(ctx, "realm", replay, "runtime"); !errors.Is(err, ErrConflict) {
		t.Fatalf("mutable result: %v", err)
	}
	progress, err := s.CollaborationProgress(ctx, "realm", "parent")
	if err != nil {
		t.Fatal(err)
	}
	if progress.Summary.AwaitingReview != 1 || progress.Summary.Unresolved != 1 || len(progress.Children) != 1 || progress.Children[0].Result == nil || len(progress.Children[0].Result.Output) != 0 {
		t.Fatalf("progress = %#v", progress)
	}
	// Human/device output has no pre-execution closed-output witness. Preserve
	// its immutable result, but neither it nor its parent can claim acceptance.
	if _, err := s.TransitionBusinessTask(ctx, "realm", "child", "submit_review", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", "child", "complete", "manager", passingGate()); !errors.Is(err, ErrConflict) {
		t.Fatalf("unproven human output completed: %v", err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", "parent", "complete", "manager", passingGate()); !errors.Is(err, ErrConflict) {
		t.Fatalf("unverified child did not block parent: %v", err)
	}
	var notifications int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_audit WHERE task_id='parent' AND event='child_result'`).Scan(&notifications); err != nil {
		t.Fatal(err)
	}
	if notifications != 1 {
		t.Fatalf("result notification count = %d", notifications)
	}
	if _, err := s.UpdateTaskRun(ctx, "realm", "child", "child-run-1", domain.DelegationRunning, "", "", "", ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("late runtime update: %v", err)
	}
}

func TestOldResultsCannotFinishNewRunsOrCrossRealm(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "task", "")
	failed := resultFor("task")
	failed.State = domain.DelegationFailed
	if _, err := s.RecordTaskResult(ctx, "realm", failed, "runtime"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateNextTaskRun(ctx, "realm", "task", domain.TaskRun{ID: "run-2", WorkerID: "user:employee", State: domain.DelegationRunning}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecordTaskResult(ctx, "realm", failed, "runtime"); err != nil {
		t.Fatal(err)
	}
	task, err := s.GetDelegationTask(ctx, "realm", "task")
	if err != nil || task.State != domain.DelegationRunning {
		t.Fatalf("old receipt changed current run: %#v, %v", task, err)
	}
	if _, err := s.RecordTaskResult(ctx, "realm", resultFor("task"), "runtime"); !errors.Is(err, ErrConflict) {
		t.Fatalf("old success accepted: %v", err)
	}
	if _, err := s.RecordTaskResult(ctx, "other-realm", failed, "runtime"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-realm result: %v", err)
	}
}

func TestConcurrentReceiptReplayProducesOneNotification(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "parent", "")
	seedResultTask(t, s, "child", "parent")
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.RecordTaskResult(ctx, "realm", resultFor("child"), "runtime"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_results WHERE task_id='child'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("receipt count %d: %v", count, err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_audit WHERE task_id='parent' AND event='child_result'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("notification count %d: %v", count, err)
	}
}

func TestFeedbackMustMatchExecutionWorkerAndCannotDoubleCount(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "task", "")
	outcome := domain.DispatchOutcome{ID: "outcome", Realm: "realm", TaskID: "task", RunID: "task-run-1", WorkerID: "user:manager", Outcome: domain.OutcomeAccepted, CreatedBy: "manager"}
	if err := s.RecordDispatchOutcome(ctx, outcome); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("mismatched worker accepted: %v", err)
	}
	outcome.WorkerID = "user:employee"
	if err := s.RecordDispatchOutcome(ctx, outcome); err != nil {
		t.Fatal(err)
	}
	outcome.ID = "replayed-outcome"
	if err := s.RecordDispatchOutcome(ctx, outcome); !errors.Is(err, ErrConflict) {
		t.Fatalf("feedback double counted: %v", err)
	}
}

// Unknown human/device impact must not be made acceptable by changing the
// sign-off actor or by splitting work into more tasks. Independent reviewed
// closed output has a separate positive chain in run_review_test.go.
func TestUnknownImpactCannotBeApprovedBySelfOrAnotherActor(t *testing.T) {
	for _, actor := range []string{"user:employee", "manager"} {
		t.Run(actor, func(t *testing.T) {
			s := taskTestStore(t)
			ctx := context.Background()
			seedResultTask(t, s, "task", "")
			if _, err := s.RecordTaskResult(ctx, "realm", resultFor("task"), "runtime"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.TransitionBusinessTask(ctx, "realm", "task", "submit_review", "manager", passingGate()); err != nil {
				t.Fatal(err)
			}
			if _, err := s.TransitionBusinessTask(ctx, "realm", "task", "complete", actor, passingGate()); !errors.Is(err, ErrConflict) {
				t.Fatalf("unknown output accepted by %s: %v", actor, err)
			}
			var completions int
			if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_audit WHERE task_id='task' AND event='complete'`).Scan(&completions); err != nil || completions != 0 {
				t.Fatalf("rejected acceptance wrote success audit: %d %v", completions, err)
			}
		})
	}
}
