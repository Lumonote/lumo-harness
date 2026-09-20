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
	reviewResult(t, s, "child")
	if _, err := s.TransitionBusinessTask(ctx, "realm", "child", "archive", "manager", domain.IntegrationGateFacts{}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", "parent", "complete", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", "parent", "complete", "manager", passingGate()); err != nil {
		t.Fatalf("review replay: %v", err)
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

// §24.8 规则 1（派发者不验收自己的活）在治理面的落点：**记录，不阻断**。
//
// 两个身份都取自既有事实，不由调用方声明：dispatcher = 任务的承接人
// （`assignee_worker_id` = `user:employee`），reviewer = 本次 complete 的操作者。
// 因此「谁来点 complete」决定了这条审计字段是否出现——这正是它防得住的地方：
// 想把自查自签洗成正常流程，只能换个人来点。
func TestSelfReviewIsRecordedWhenAssigneeSignsOffOwnWork(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "task", "")
	if _, err := s.RecordTaskResult(ctx, "realm", resultFor("task"), "runtime"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", "task", "submit_review", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}

	// 承接人自己签：记 `reviewer_self_review`。
	if _, err := s.TransitionBusinessTask(ctx, "realm", "task", "complete", "user:employee", passingGate()); err != nil {
		t.Fatal(err)
	}
	var selfReviewed bool
	if err := s.pool.QueryRow(ctx, `SELECT (detail->>'reviewer_self_review')::boolean FROM governance_task_audit
	  WHERE realm='realm' AND task_id='task' AND event='complete'`).Scan(&selfReviewed); err != nil {
		t.Fatal(err)
	}
	if !selfReviewed {
		t.Fatal("承接人自签未被记为 self-review")
	}
	// 同一条审计里的影响面事实：单任务的批次里可证的只有「本批 1 个任务」这一项，
	// 阈值入参本身记成「没有这个数」（缺键），见下一条用例的完整断言。
	var batchTasks int
	var artifactsPresent bool
	if err := s.pool.QueryRow(ctx, `SELECT (detail->'review_impact'->>'batch_tasks')::int, detail->'review_impact' ? 'artifacts'
	  FROM governance_task_audit WHERE realm='realm' AND task_id='task' AND event='complete'`).Scan(&batchTasks, &artifactsPresent); err != nil {
		t.Fatal(err)
	}
	if batchTasks != 1 || artifactsPresent {
		t.Fatalf("batch_tasks=%d artifacts_present=%v, want 1 / false", batchTasks, artifactsPresent)
	}
}

// 自查自签的记录里要能看出**本批有多大**——这是阈值校准唯一的原料。
//
// 阈值入参（产出物数）在治理面没有生产者，所以它记成「缺这个数」；这里钉住的是另一半：
// 可证的那部分必须真的记下来，而且记的是**下界**（本批进入 DONE 的任务数）。
func TestSelfReviewRecordCarriesTheProvableImpactFacts(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "parent", "")
	seedResultTask(t, s, "child-a", "parent")
	seedResultTask(t, s, "child-b", "parent")
	for _, id := range []string{"parent", "child-a", "child-b"} {
		if _, err := s.RecordTaskResult(ctx, "realm", resultFor(id), "runtime"); err != nil {
			t.Fatal(err)
		}
	}
	// 子任务由另一个人验收（manager ≠ 承接人 user:employee），它们不该带自查自签的记录。
	reviewResult(t, s, "child-a")
	reviewResult(t, s, "child-b")
	if _, err := s.TransitionBusinessTask(ctx, "realm", "parent", "submit_review", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", "parent", "complete", "user:employee", passingGate()); err != nil {
		t.Fatal(err)
	}

	var reason, disposition string
	var proven, artifactsPresent bool
	var batchTasks int
	if err := s.pool.QueryRow(ctx, `SELECT detail->>'reviewer_ineligibility', detail->>'review_disposition',
	  (detail->'review_impact'->>'artifacts_proven')::boolean, detail->'review_impact' ? 'artifacts',
	  (detail->'review_impact'->>'batch_tasks')::int
	  FROM governance_task_audit WHERE realm='realm' AND task_id='parent' AND event='complete'`).Scan(
		&reason, &disposition, &proven, &artifactsPresent, &batchTasks); err != nil {
		t.Fatal(err)
	}
	// 理由按闭集记，不只留一个布尔值：聚合面（「本月多少次审查因同源被拒」）要的是一次 GROUP BY。
	if reason != string(domain.ReviewerSelfReview) {
		t.Fatalf("reviewer_ineligibility = %q, want %q", reason, domain.ReviewerSelfReview)
	}
	// 影响面判不出来时**不假设它小**：档位记 `impact-unprovable`，而不是「可证地低于阈值」。
	// 而且阈值入参只记「没有这个数」——记 0 等于替后来读这份记录的人断言「影响面小」。
	if proven || artifactsPresent || disposition != string(domain.ReviewImpactUnprovable) {
		t.Fatalf("proven=%v artifacts_present=%v disposition=%q, want false / false / %q",
			proven, artifactsPresent, disposition, domain.ReviewImpactUnprovable)
	}
	// 可证的代理：本批 2 个子任务 + 本任务（每个进入 DONE 的任务都要求过一条带交付物的完成结果）。
	if batchTasks != 3 {
		t.Fatalf("batch_tasks = %d, want 3", batchTasks)
	}
}

func TestReviewerSelfReviewFieldIsAbsentWhenSomeoneElseSignsOff(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "task", "")
	if _, err := s.RecordTaskResult(ctx, "realm", resultFor("task"), "runtime"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", "task", "submit_review", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	// 另一个人签：**不该出现这个字段**。字段的存在本身就是信号，
	// 于是「没出现」必须能与「出现了但为 false」区分开——所以这条查的是 NULL 而不是 false。
	if _, err := s.TransitionBusinessTask(ctx, "realm", "task", "complete", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	var present, impactPresent bool
	if err := s.pool.QueryRow(ctx, `SELECT detail ? 'reviewer_self_review', detail ? 'review_impact' FROM governance_task_audit
	  WHERE realm='realm' AND task_id='task' AND event='complete'`).Scan(&present, &impactPresent); err != nil {
		t.Fatal(err)
	}
	if present {
		t.Fatal("非承接人签署却记了 self-review")
	}
	// 影响面事实只在**有发现**的那条审计上出现：没有不合格的审查者时，它记的是
	// 「这次改动多大」，而 §24.8 的判据管的是审查者，不是改动——把这两件事混进同一条记录，
	// 会让「本批影响面」这个字段在每一次正常完成上出现一次，失去信号价值。
	if impactPresent {
		t.Fatal("审查者合格却记了影响面事实")
	}
}
