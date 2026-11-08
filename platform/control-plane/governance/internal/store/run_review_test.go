package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func seedReviewExecution(t *testing.T, s *Store, id, agent, model string, closed bool) domain.TaskResult {
	t.Helper()
	ctx := context.Background()
	connectors := `[]`
	if !closed {
		connectors = `["external"]`
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_agent_presets(realm,id,project_id,name,owner_user_id,status,provider,model_ref,connector_ids,knowledge_space_ids,revision,max_concurrency) VALUES('realm',$1,'project',$1,'employee','active','provider',$2,$3,'[]',1,2) ON CONFLICT(realm,id) DO NOTHING`, agent, model, connectors); err != nil {
		t.Fatal(err)
	}
	task := domain.DelegatedTask{ID: id, Realm: "realm", Title: id, Intent: "deliver " + id, ProjectID: "project", RequesterUserID: "manager", AssigneeUserID: "employee", AssigneeWorkerID: "agent:" + agent, State: domain.DelegationRunning, BusinessState: domain.BusinessExecuting, IntentContract: &domain.IntentContract{Objective: "deliver " + id, AcceptanceCriteria: []string{"every text entry is supported"}}}
	_, _, err := s.CreateDelegatedTaskWithRun(ctx, task, domain.TaskRun{ID: id + "-run", WorkerID: "agent:" + agent, State: "RUNNING", SchedulerTaskID: id + "-run", AssignedNodeID: "node-" + agent, SessionRef: "session-" + id})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `INSERT INTO governance_worker_heartbeats(realm,worker_id,node_id,instance_id,preset_revision,max_concurrency,status) VALUES('realm',$1,$2,'boot',1,2,'active') ON CONFLICT(realm,worker_id,node_id) DO UPDATE SET updated_at=now()`, "agent:"+agent, "node-"+agent); err != nil {
		t.Fatal(err)
	}
	return domain.TaskResult{TaskID: id, RunID: id + "-run", State: "COMPLETED", NodeID: "node-" + agent, SessionRef: "session-" + id, Summary: "delivered", Output: json.RawMessage(`[{"type":"text","text":"one"},{"type":"text","text":"two"},{"type":"text","text":"three"}]`)}
}

func prepareReviewExecution(t *testing.T, s *Store, result domain.TaskResult, model string) domain.PreparedRunExecution {
	t.Helper()
	out, err := s.PrepareRunExecution(context.Background(), "realm", result.RunID, PrepareRunExecutionRequest{NodeID: result.NodeID, SessionRef: result.SessionRef, PresetRevision: 1, Provider: "provider", Model: model})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func recordReviewExecution(t *testing.T, s *Store, result domain.TaskResult) {
	t.Helper()
	if _, err := s.RecordTrustedTaskResult(context.Background(), "realm", result, "runtime"); err != nil {
		t.Fatal(err)
	}
}

func reviewVerdict(digest, verdict string) json.RawMessage {
	raw, _ := json.Marshal([]map[string]string{{"type": "text", "text": fmt.Sprintf(`{"verdict":%q,"manifest_digest":%q}`, verdict, digest)}})
	return raw
}

func TestRunReviewForcesExactIndependentEvidence(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	producer := seedReviewExecution(t, s, "producer", "producer-agent", "model-a", true)
	snapshot := prepareReviewExecution(t, s, producer, "model-a")
	if snapshot.Snapshot.OutputProfile != domain.ClosedTextOutputProfile {
		t.Fatal("closed profile missing")
	}
	if _, err := s.RecordTaskResult(ctx, "realm", producer, "manager"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("browser forged prepared result: %v", err)
	}
	recordReviewExecution(t, s, producer)
	if _, err := s.pool.Exec(ctx, `UPDATE governance_delegation_tasks SET intent='mutated intent',intent_contract='{"objective":"mutated intent","acceptance_criteria":["different criterion"]}' WHERE id='producer'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", producer.TaskID, "submit_review", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", producer.TaskID, "complete", "manager", passingGate()); !errors.Is(err, ErrConflict) {
		t.Fatalf("missing review bypassed: %v", err)
	}
	reviewer := seedReviewExecution(t, s, "reviewer", "reviewer-agent", "model-b", true)
	bound, err := s.BindRunReview(ctx, "realm", producer.TaskID, producer.RunID, reviewer.TaskID, reviewer.RunID, "manager")
	if err != nil {
		t.Fatal(err)
	}
	prepared := prepareReviewExecution(t, s, reviewer, "model-b")
	if prepared.Review == nil || prepared.Review.ManifestDigest != bound.ManifestDigest || len(prepared.Review.Manifest.Entries) != 3 {
		t.Fatalf("review context missing exact output: %+v", prepared)
	}
	if prepared.Review.ProducerIntent != "deliver producer" || prepared.Review.ProducerContract == nil || len(prepared.Review.ProducerContract.AcceptanceCriteria) != 1 || prepared.Review.ProducerContract.AcceptanceCriteria[0] != "every text entry is supported" {
		t.Fatalf("producer contract was not frozen before execution: %+v", prepared.Review)
	}
	// Current mutable presets must not change historical execution identity.
	if _, err := s.pool.Exec(ctx, `UPDATE governance_agent_presets SET model_ref='model-b',revision=2 WHERE id='producer-agent'`); err != nil {
		t.Fatal(err)
	}
	reviewer.Output = reviewVerdict(bound.ManifestDigest, "approve")
	recordReviewExecution(t, s, reviewer)
	completed, err := s.TransitionBusinessTask(ctx, "realm", producer.TaskID, "complete", "manager", passingGate())
	if err != nil || completed.BusinessState != "DONE" {
		t.Fatalf("verified completion: %+v %v", completed, err)
	}
	var detail []byte
	if err = s.pool.QueryRow(ctx, `SELECT detail FROM governance_task_audit WHERE task_id=$1 AND event='complete'`, producer.TaskID).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(detail), bound.ManifestDigest) || !strings.Contains(string(detail), `"verified": true`) {
		t.Fatalf("review evidence absent from audit: %s", detail)
	}
}

func TestRunReviewRejectsStaleRejectedAndUnboundOutput(t *testing.T) {
	for _, failure := range []string{"wrong-digest", "reject", "expired", "review-superseded"} {
		t.Run(failure, func(t *testing.T) {
			s := taskTestStore(t)
			ctx := context.Background()
			producer := seedReviewExecution(t, s, "producer", "producer-agent", "model-a", true)
			prepareReviewExecution(t, s, producer, "model-a")
			recordReviewExecution(t, s, producer)
			reviewer := seedReviewExecution(t, s, "reviewer", "reviewer-agent", "model-b", true)
			bound, err := s.BindRunReview(ctx, "realm", producer.TaskID, producer.RunID, reviewer.TaskID, reviewer.RunID, "manager")
			if err != nil {
				t.Fatal(err)
			}
			prepareReviewExecution(t, s, reviewer, "model-b")
			digest, verdict := bound.ManifestDigest, "approve"
			if failure == "wrong-digest" {
				digest = strings.Repeat("0", 64)
			}
			if failure == "reject" {
				verdict = "reject"
			}
			reviewer.Output = reviewVerdict(digest, verdict)
			recordReviewExecution(t, s, reviewer)
			if failure == "expired" {
				if _, err = s.pool.Exec(ctx, `UPDATE governance_run_reviews SET expires_at=now()-interval '1 second'`); err != nil {
					t.Fatal(err)
				}
			}
			if failure == "review-superseded" {
				if _, err = s.pool.Exec(ctx, `INSERT INTO governance_task_runs(id,realm,task_id,attempt,worker_id,state) VALUES('reviewer-run-2','realm','reviewer',2,'agent:reviewer-agent','FAILED')`); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = s.TransitionBusinessTask(ctx, "realm", producer.TaskID, "submit_review", "manager", passingGate()); err != nil {
				t.Fatal(err)
			}
			if _, err = s.TransitionBusinessTask(ctx, "realm", producer.TaskID, "complete", "manager", passingGate()); !errors.Is(err, ErrConflict) {
				t.Fatalf("%s evidence completed task: %v", failure, err)
			}
			current, _ := s.GetDelegationTask(ctx, "realm", producer.TaskID)
			if current.BusinessState != "IN_REVIEW" {
				t.Fatalf("failed review check changed business state: %+v", current)
			}
		})
	}
}

func TestRunReviewUnknownImpactAndManifestCannotBeExpanded(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	grantReviewArtifactWriter(t, s)
	unknown := seedReviewExecution(t, s, "external", "external-agent", "model-a", false)
	snapshot := prepareReviewExecution(t, s, unknown, "model-a")
	if snapshot.Snapshot.OutputProfile != "unknown" {
		t.Fatal("connector effects falsely certified")
	}
	recordReviewExecution(t, s, unknown)
	if _, err := s.TransitionBusinessTask(ctx, "realm", unknown.TaskID, "submit_review", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", unknown.TaskID, "complete", "manager", passingGate()); !errors.Is(err, ErrConflict) {
		t.Fatalf("unknown external effects accepted: %v", err)
	}
	closed := seedReviewExecution(t, s, "closed", "closed-agent", "model-a", true)
	prepareReviewExecution(t, s, closed, "model-a")
	if _, err := s.ReserveTaskArtifact(ctx, domain.TaskArtifact{ID: "late-artifact", Realm: "realm", TaskID: closed.TaskID, RunID: closed.RunID, Name: "unreviewed", CreatedBy: "employee"}, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("late artifact expanded sealed output set: %v", err)
	}
	closed.Output = json.RawMessage(`[{"type":"image","text":"unobserved"}]`)
	if _, err := s.RecordTrustedTaskResult(ctx, "realm", closed, "runtime"); !errors.Is(err, ErrConflict) {
		t.Fatalf("unknown output certified: %v", err)
	}
	legacy := seedResultTask(t, s, "legacy", "")
	_ = legacy
	record := resultFor("legacy")
	if _, err := s.RecordTaskResult(ctx, "realm", record, "runtime"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", "legacy", "submit_review", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionBusinessTask(ctx, "realm", "legacy", "complete", "manager", passingGate()); !errors.Is(err, ErrConflict) {
		t.Fatalf("legacy unproven impact accepted: %v", err)
	}
}

func TestRunReviewBindingMustPrecedeRunAndSnapshotIsImmutable(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	producer := seedReviewExecution(t, s, "producer", "producer-agent", "model-a", true)
	prepareReviewExecution(t, s, producer, "model-a")
	recordReviewExecution(t, s, producer)
	reviewer := seedReviewExecution(t, s, "reviewer", "reviewer-agent", "model-b", true)
	prepareReviewExecution(t, s, reviewer, "model-b")
	if _, err := s.BindRunReview(ctx, "realm", producer.TaskID, producer.RunID, reviewer.TaskID, reviewer.RunID, "manager"); !errors.Is(err, ErrConflict) {
		t.Fatalf("post-start binding accepted: %v", err)
	}
	if _, err := s.PrepareRunExecution(ctx, "realm", reviewer.RunID, PrepareRunExecutionRequest{NodeID: reviewer.NodeID, SessionRef: reviewer.SessionRef, PresetRevision: 2, Provider: "provider", Model: "model-b"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("snapshot replaced: %v", err)
	}
	if _, err := s.PrepareRunExecution(ctx, "other-realm", reviewer.RunID, PrepareRunExecutionRequest{NodeID: reviewer.NodeID, SessionRef: reviewer.SessionRef, PresetRevision: 1, Provider: "provider", Model: "model-b"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross realm snapshot visible: %v", err)
	}
	same := seedReviewExecution(t, s, "same", "producer-agent", "model-a", true)
	if _, err := s.BindRunReview(ctx, "realm", producer.TaskID, producer.RunID, same.TaskID, same.RunID, "manager"); !errors.Is(err, ErrConflict) {
		t.Fatalf("self review bound: %v", err)
	}
}

func TestRunReviewConcurrentRetryCannotRaceAcceptance(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	producer := seedReviewExecution(t, s, "producer", "producer-agent", "model-a", true)
	prepareReviewExecution(t, s, producer, "model-a")
	recordReviewExecution(t, s, producer)
	reviewer := seedReviewExecution(t, s, "reviewer", "reviewer-agent", "model-b", true)
	bound, err := s.BindRunReview(ctx, "realm", producer.TaskID, producer.RunID, reviewer.TaskID, reviewer.RunID, "manager")
	if err != nil {
		t.Fatal(err)
	}
	prepareReviewExecution(t, s, reviewer, "model-b")
	reviewer.Output = reviewVerdict(bound.ManifestDigest, "approve")
	recordReviewExecution(t, s, reviewer)
	if _, err = s.TransitionBusinessTask(ctx, "realm", producer.TaskID, "submit_review", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	retry, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = retry.Rollback(ctx) }()
	if _, err = retry.Exec(ctx, `SELECT id FROM governance_delegation_tasks WHERE realm='realm' AND id='reviewer' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if _, err = s.TransitionBusinessTask(bounded, "realm", producer.TaskID, "complete", "manager", passingGate()); !errors.Is(err, ErrConflict) {
		t.Fatalf("busy review must fail closed without waiting/deadlocking: %v", err)
	}
	if _, err = retry.Exec(ctx, `INSERT INTO governance_task_runs(id,realm,task_id,attempt,worker_id,state) VALUES('reviewer-run-2','realm','reviewer',2,'agent:reviewer-agent','FAILED')`); err != nil {
		t.Fatal(err)
	}
	if err = retry.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = s.TransitionBusinessTask(ctx, "realm", producer.TaskID, "complete", "manager", passingGate()); !errors.Is(err, ErrConflict) {
		t.Fatalf("superseded review accepted after retry: %v", err)
	}
}

func TestRunReviewMigrationConvergesWithStartupSchema(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	schema := func() string {
		t.Helper()
		var raw string
		err := s.pool.QueryRow(ctx, `SELECT jsonb_agg(jsonb_build_object(
		 'table',c.relname,
		 'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
		 'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
		 'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid)) ORDER BY c.relname)::text
		 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])`, []string{"governance_run_execution_snapshots", "governance_run_output_manifests", "governance_run_reviews"}).Scan(&raw)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	startup := schema()
	if _, err := s.pool.Exec(ctx, `DROP TABLE governance_review_file_reads,governance_run_file_blobs,governance_run_reviews,governance_run_output_manifests,governance_run_execution_snapshots`); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "migrations", "018_governance_run_reviews.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, string(raw)); err != nil {
		t.Fatal(err)
	}
	if migrated := schema(); startup != migrated {
		t.Fatalf("migration/startup DDL differ:\nstartup=%s\nmigration=%s", startup, migrated)
	}
	if err = s.Init(ctx); err != nil {
		t.Fatalf("startup after migration: %v", err)
	}
	if schema() != startup {
		t.Fatal("startup changed migrated review schema")
	}
}

func TestRunReviewAtomicCreationReplaysAndRollsBack(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	producer := seedReviewExecution(t, s, "producer", "producer-agent", "model-a", true)
	prepareReviewExecution(t, s, producer, "model-a")
	recordReviewExecution(t, s, producer)
	seedReviewExecution(t, s, "warmup", "review-agent", "model-b", true)
	newReview := func(id, agent string) (domain.DelegatedTask, domain.TaskRun) {
		task := domain.DelegatedTask{ID: id, Realm: "realm", Title: "Review", Intent: "Review exact output", ProjectID: "project", RequesterUserID: "manager", AssigneeUserID: "employee", AssigneeWorkerID: "agent:" + agent, State: domain.DelegationQueued, BusinessState: domain.BusinessAssigned, SchedulerTaskID: id + "-run"}
		run := domain.TaskRun{ID: id + "-run", Realm: "realm", TaskID: id, Attempt: 1, WorkerID: task.AssigneeWorkerID, State: domain.DelegationQueued, SchedulerTaskID: id + "-run"}
		return task, run
	}
	// The self-review check runs after task/Run/outbox inserts, so this proves
	// the transaction removes every partially created execution fact.
	task, run := newReview("self-review", "producer-agent")
	if _, _, err := s.CreateRunReview(ctx, producer.TaskID, producer.RunID, task, run); !errors.Is(err, ErrConflict) {
		t.Fatalf("self review created: %v", err)
	}
	var leaked bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_delegation_tasks WHERE id='self-review') OR EXISTS(SELECT 1 FROM governance_task_runs WHERE id='self-review-run') OR EXISTS(SELECT 1 FROM governance_task_scheduling WHERE run_id='self-review-run') OR EXISTS(SELECT 1 FROM governance_run_reviews WHERE review_run_id='self-review-run')`).Scan(&leaked); err != nil || leaked {
		t.Fatalf("partial atomic creation leaked: %t %v", leaked, err)
	}
	receipt := DelegationReceipt{Key: "review:create", Hash: strings.Repeat("a", 64)}
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			task, run := newReview(fmt.Sprintf("review-%d", i), "review-agent")
			created, stored, err := s.CreateRunReview(ctx, producer.TaskID, producer.RunID, task, run, receipt)
			if err != nil {
				t.Error(err)
				return
			}
			ids <- created.ID + "/" + stored.ID
		}(i)
	}
	wg.Wait()
	close(ids)
	seen := map[string]bool{}
	for id := range ids {
		seen[id] = true
	}
	if len(seen) != 1 {
		t.Fatalf("concurrent review creation duplicated tasks: %v", seen)
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_run_reviews b JOIN governance_task_scheduling q ON q.run_id=b.review_run_id WHERE b.producer_run_id=$1`, producer.RunID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("review binding and dispatch outbox diverged: %d %v", count, err)
	}
}

func approvedReplacementRun(t *testing.T, s *Store, taskID string) domain.TaskResult {
	t.Helper()
	ctx := context.Background()
	// Create a different current, tool-free preset and live node through the
	// same fixture used by ordinary execution tests.
	seedReviewExecution(t, s, "replacement-template", "replacement-agent", "model-a", true)
	next := domain.TaskRun{ID: taskID + "-replacement", WorkerID: "agent:replacement-agent", State: "RUNNING", SchedulerTaskID: taskID + "-replacement", AssignedNodeID: "node-replacement-agent", SessionRef: "session-replacement"}
	if _, err := s.CreateNextAssignedTaskRun(ctx, "realm", taskID, next, TaskRunAssignment{WorkerID: next.WorkerID, UserID: "employee"}); err != nil {
		t.Fatal(err)
	}
	result := domain.TaskResult{TaskID: taskID, RunID: next.ID, State: "COMPLETED", NodeID: next.AssignedNodeID, SessionRef: next.SessionRef, Summary: "replacement text delivery", Output: json.RawMessage(`[{"type":"text","text":"replacement report"}]`)}
	prepareReviewExecution(t, s, result, "model-a")
	recordReviewExecution(t, s, result)
	reviewer := seedReviewExecution(t, s, "replacement-reviewer", "replacement-review-agent", "model-b", true)
	bound, err := s.BindRunReview(ctx, "realm", taskID, result.RunID, reviewer.TaskID, reviewer.RunID, "manager")
	if err != nil {
		t.Fatal(err)
	}
	prepareReviewExecution(t, s, reviewer, "model-b")
	reviewer.Output = reviewVerdict(bound.ManifestDigest, "approve")
	recordReviewExecution(t, s, reviewer)
	if _, err = s.TransitionBusinessTask(ctx, "realm", taskID, "submit_review", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestRunReviewReplacementCannotEraseUnknownHistoricalImpact(t *testing.T) {
	for _, tc := range []struct {
		name                              string
		prepare, closed, noResult         bool
		state                             string
		artifact, removeManifest, started bool
		allow                             bool
	}{
		{name: "unknown completed", prepare: true, state: "COMPLETED"},
		{name: "unknown failed with output", prepare: true, state: "FAILED"},
		{name: "unknown cancelled with output", prepare: true, state: "CANCELLED"},
		{name: "unknown prepared without receipt", prepare: true, noResult: true},
		{name: "legacy completed receipt", state: "COMPLETED"},
		{name: "legacy failed with output", state: "FAILED"},
		{name: "legacy cancelled with output", state: "CANCELLED"},
		{name: "legacy artifact without result", noResult: true, artifact: true},
		{name: "legacy execution started without receipt", noResult: true, started: true},
		{name: "closed failed with output but no manifest", prepare: true, closed: true, state: "FAILED"},
		{name: "closed completed missing manifest", prepare: true, closed: true, state: "COMPLETED", removeManifest: true},
		{name: "closed superseded delivery needs no historical approval", prepare: true, closed: true, state: "COMPLETED", allow: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := taskTestStore(t)
			ctx := context.Background()
			old := seedReviewExecution(t, s, "producer", "producer-agent", "model-a", tc.closed)
			if tc.prepare {
				prepareReviewExecution(t, s, old, "model-a")
			}
			if tc.noResult {
				if tc.started {
					if _, err := s.UpdateTaskRun(ctx, "realm", old.TaskID, old.RunID, "RUNNING", "", "", "", "model started before receipt was lost"); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := s.UpdateTaskRun(ctx, "realm", old.TaskID, old.RunID, "FAILED", "", "", "", "stopped without receipt"); err != nil {
					t.Fatal(err)
				}
				if _, err := s.UpdateDelegationTask(ctx, "realm", old.TaskID, "FAILED", "", "", "stopped without receipt"); err != nil {
					t.Fatal(err)
				}
			} else {
				old.State = tc.state
				recordReviewExecution(t, s, old)
			}
			if tc.artifact {
				// Historical data predates the active-run upload gate. Recreate it
				// directly rather than granting new uploads into terminal evidence.
				if _, err := s.pool.Exec(ctx, `INSERT INTO governance_task_artifacts(id,realm,task_id,run_id,name,content_type,created_by,status)VALUES('historical-file','realm',$1,$2,'unproven historical delivery','text/plain','employee','pending')`, old.TaskID, old.RunID); err != nil {
					t.Fatal(err)
				}
			}
			if tc.removeManifest {
				if _, err := s.pool.Exec(ctx, `DELETE FROM governance_run_output_manifests WHERE run_id=$1`, old.RunID); err != nil {
					t.Fatal(err)
				}
			}
			latest := approvedReplacementRun(t, s, old.TaskID)
			completed, err := s.TransitionBusinessTask(ctx, "realm", old.TaskID, "complete", "manager", passingGate())
			if tc.allow {
				if err != nil || completed.BusinessState != domain.BusinessDone {
					t.Fatalf("closed history should permit approved replacement %s: %+v %v", latest.RunID, completed, err)
				}
				return
			}
			if !errors.Is(err, ErrConflict) || !strings.Contains(err.Error(), "task history") {
				t.Fatalf("approved replacement %s erased unknown history %s: %v", latest.RunID, old.RunID, err)
			}
			current, err := s.GetDelegationTask(ctx, "realm", old.TaskID)
			if err != nil || current.BusinessState != domain.BusinessInReview {
				t.Fatalf("history refusal changed business state: %+v %v", current, err)
			}
		})
	}
}

func TestRunReviewUnexecutedFailureDoesNotBlockAndClosedTaskCannotGainArtifacts(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	task := domain.DelegatedTask{ID: "producer", Realm: "realm", Title: "delivery", Intent: "produce reviewed text", ProjectID: "project", RequesterUserID: "manager", AssigneeUserID: "employee", AssigneeWorkerID: "user:employee", State: domain.DelegationAssigned, BusinessState: domain.BusinessAssigned}
	old := domain.TaskRun{ID: "unexecuted-assignment", WorkerID: "user:employee", State: domain.DelegationAssigned}
	if _, _, err := s.CreateDelegatedTaskWithRun(ctx, task, old); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateTaskRun(ctx, "realm", task.ID, old.ID, "FAILED", "", "", "", "assignment never executed"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateDelegationTask(ctx, "realm", task.ID, "FAILED", "", "", "assignment never executed"); err != nil {
		t.Fatal(err)
	}
	approvedReplacementRun(t, s, task.ID)
	if completed, err := s.TransitionBusinessTask(ctx, "realm", task.ID, "complete", "manager", passingGate()); err != nil || completed.BusinessState != domain.BusinessDone {
		t.Fatalf("unexecuted assignment blocked replacement: %+v %v", completed, err)
	}
	if _, err := s.ReserveTaskArtifact(ctx, domain.TaskArtifact{ID: "post-acceptance-file", Realm: "realm", TaskID: task.ID, RunID: old.ID, Name: "late unreviewed output", CreatedBy: "employee"}, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("accepted task gained output through an old Run: %v", err)
	}
}

func TestRunReviewAnyUploadedArtifactInvalidatesTextOnlyAcceptance(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	grantReviewArtifactWriter(t, s)
	old := seedReviewExecution(t, s, "producer", "producer-agent", "model-a", true)
	prepareReviewExecution(t, s, old, "model-a")
	recordReviewExecution(t, s, old)
	latest := approvedReplacementRun(t, s, old.TaskID)
	if _, err := s.ReserveTaskArtifact(ctx, domain.TaskArtifact{ID: "forbidden-upload", Realm: "realm", TaskID: old.TaskID, RunID: latest.RunID, Name: "unreviewed file", CreatedBy: "employee"}, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("prepared closed Run accepted an upload: %v", err)
	}
	for _, runID := range []string{old.RunID, latest.RunID} {
		// Simulate legacy data or a second writer. Even a valid closed text
		// manifest cannot stand in for reviewing the uploaded file's bytes.
		if _, err := s.pool.Exec(ctx, `INSERT INTO governance_task_artifacts(id,realm,task_id,run_id,name,content_type,created_by,status) VALUES('uncovered-file','realm',$1,$2,'external delivery','text/plain','employee','pending')`, old.TaskID, runID); err != nil {
			t.Fatal(err)
		}
		if _, err := s.TransitionBusinessTask(ctx, "realm", old.TaskID, "complete", "manager", passingGate()); !errors.Is(err, ErrConflict) || !strings.Contains(err.Error(), "task history") {
			t.Fatalf("text-only approval covered extra artifact on %s: %v", runID, err)
		}
		if _, err := s.pool.Exec(ctx, `DELETE FROM governance_task_artifacts WHERE id='uncovered-file'`); err != nil {
			t.Fatal(err)
		}
	}
}

// The upload assertions must reach the sealed-output check as a currently
// authorized contributor; a missing role would only test an earlier refusal.
func grantReviewArtifactWriter(t *testing.T, s *Store) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO governance_roles(realm,id,name,status)VALUES('realm','review-artifact-writer','Review artifact writer','active');
 INSERT INTO governance_role_permissions(realm,role_id,action,effect)VALUES('realm','review-artifact-writer','task:delegate','allow');
 INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by)VALUES('realm','employee','review-artifact-writer','manager')`); err != nil {
		t.Fatal(err)
	}
}
