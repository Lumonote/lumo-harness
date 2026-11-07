package store

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"strings"
	"testing"
	"time"
)

func seedFilesExecution(t *testing.T, s *Store, id, agent string) domain.TaskResult {
	t.Helper()
	result := seedReviewExecution(t, s, id, agent, "model-a", true)
	if _, err := s.pool.Exec(context.Background(), `UPDATE governance_agent_presets SET output_profile=$2 WHERE id=$1`, agent, domain.ClosedTextFilesOutputProfile); err != nil {
		t.Fatal(err)
	}
	result.Files = []domain.RunTextFile{{Name: "report.md", MediaType: "text/markdown; charset=utf-8", Text: "# 全量产物\nEvery byte is independently read."}, {Name: "facts.json", MediaType: "application/json", Text: `{"verified":true}`}}
	prepared := prepareReviewExecution(t, s, result, "model-a")
	if prepared.Snapshot.OutputProfile != domain.ClosedTextFilesOutputProfile {
		t.Fatal("file profile not frozen")
	}
	recordReviewExecution(t, s, result)
	return result
}

func TestControlledFileReadsRecheckAuthorityAfterLockWait(t *testing.T) {
	for _, mode := range []string{"heartbeat-expired", "owner-revoked", "preset-revised", "binding-expired"} {
		t.Run(mode, func(t *testing.T) {
			s := taskTestStore(t)
			ctx := context.Background()
			producer := seedFilesExecution(t, s, "producer", "producer-agent")
			reviewer, _ := prepareFileReviewer(t, s, producer)
			blocker, err := s.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(ctx) }()
			if _, err = blocker.Exec(ctx, `SELECT id FROM governance_delegation_tasks WHERE realm='realm' AND id=$1 FOR UPDATE`, reviewer.TaskID); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "heartbeat-expired":
				_, err = blocker.Exec(ctx, `UPDATE governance_worker_heartbeats SET updated_at=clock_timestamp()-interval '1 minute' WHERE worker_id='agent:reviewer-agent'`)
			case "owner-revoked":
				_, err = blocker.Exec(ctx, `UPDATE governance_users SET status='disabled' WHERE realm='realm' AND id='employee'`)
			case "preset-revised":
				_, err = blocker.Exec(ctx, `UPDATE governance_agent_presets SET revision=revision+1 WHERE realm='realm' AND id='reviewer-agent'`)
			case "binding-expired":
				_, err = blocker.Exec(ctx, `UPDATE governance_run_reviews SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE review_run_id=$1`, reviewer.RunID)
			}
			if err != nil {
				t.Fatal(err)
			}
			outcome := make(chan error, 1)
			go func() {
				_, err := s.ReadRunReviewFile(ctx, "realm", reviewer.RunID, reviewer.NodeID, reviewer.SessionRef, "file-0001")
				outcome <- err
			}()
			deadline := time.Now().Add(3 * time.Second)
			blocked := false
			for time.Now().Before(deadline) {
				if err = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker.Conn().PgConn().PID()).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !blocked {
				t.Fatal("reader did not reach the held authorization lock")
			}
			if mode == "binding-expired" {
				var expired bool
				for time.Now().Before(deadline) {
					if err = blocker.QueryRow(ctx, `SELECT expires_at<clock_timestamp() FROM governance_run_reviews WHERE review_run_id=$1`, reviewer.RunID).Scan(&expired); err != nil {
						t.Fatal(err)
					}
					if expired {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
				if !expired {
					t.Fatal("binding did not expire during lock wait")
				}
			}
			if err = blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err = <-outcome:
				if err == nil {
					t.Fatalf("%s changed while blocked but still received a file receipt", mode)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("reader remained blocked")
			}
			var count int
			if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_review_file_reads WHERE review_run_id=$1`, reviewer.RunID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("revoked read persisted receipt: %d %v", count, err)
			}
		})
	}
}
func prepareFileReviewer(t *testing.T, s *Store, producer domain.TaskResult) (domain.TaskResult, *domain.RunReviewContext) {
	t.Helper()
	reviewer := seedReviewExecution(t, s, "reviewer", "reviewer-agent", "model-b", true)
	bound, err := s.BindRunReview(context.Background(), "realm", producer.TaskID, producer.RunID, reviewer.TaskID, reviewer.RunID, "manager")
	if err != nil {
		t.Fatal(err)
	}
	prepareReviewExecution(t, s, reviewer, "model-b")
	reviewer.Output = reviewVerdict(bound.ManifestDigest, "approve")
	return reviewer, bound
}
func readEveryFile(t *testing.T, s *Store, reviewer *domain.TaskResult, bound *domain.RunReviewContext) {
	t.Helper()
	for _, entry := range bound.Manifest.Files {
		file, err := s.ReadRunReviewFile(context.Background(), "realm", reviewer.RunID, reviewer.NodeID, reviewer.SessionRef, entry.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len([]byte(file.Text)) != entry.Bytes || file.SHA256 != entry.SHA256 || file.Receipt == "" {
			t.Fatal("incomplete file read")
		}
		reviewer.ReviewFileReceipts = append(reviewer.ReviewFileReceipts, domain.RunFileReadReceipt{ID: file.ID, Receipt: file.Receipt})
	}
}
func TestControlledFilesRequireIndependentFullReadsAndAcceptExactManifest(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	producer := seedFilesExecution(t, s, "producer", "producer-agent")
	reviewer, bound := prepareFileReviewer(t, s, producer)
	if len(bound.Manifest.Files) != len(producer.Files) {
		t.Fatal("manifest omitted a generated file")
	}
	if _, err := s.RecordTrustedTaskResult(ctx, "realm", reviewer, "runtime"); !errors.Is(err, ErrConflict) {
		t.Fatalf("approved without reads: %v", err)
	}
	readEveryFile(t, s, &reviewer, bound)
	recordReviewExecution(t, s, reviewer)
	// Runtime delivery replay cannot duplicate or mutate its complete blob set.
	recordReviewExecution(t, s, producer)
	human, err := s.GetTaskResult(ctx, "realm", reviewer.TaskID, reviewer.RunID)
	if err != nil || len(human.ReviewFileReceipts) != 0 {
		t.Fatalf("human view leaked receipt: %+v %v", human, err)
	}
	human, err = s.GetTaskResult(ctx, "realm", producer.TaskID, producer.RunID)
	if err != nil || len(human.Files) != 2 || human.Files[0] != producer.Files[0] {
		t.Fatalf("human did not receive verified complete bytes: %+v %v", human, err)
	}
	if _, err = s.TransitionBusinessTask(ctx, "realm", producer.TaskID, "submit_review", "manager", passingGate()); err != nil {
		t.Fatal(err)
	}
	complete, err := s.TransitionBusinessTask(ctx, "realm", producer.TaskID, "complete", "manager", passingGate())
	if err != nil || complete.BusinessState != domain.BusinessDone {
		t.Fatalf("full independent review refused: %+v %v", complete, err)
	}
	if _, err = s.ReadRunReviewFile(ctx, "realm", reviewer.RunID, reviewer.NodeID, reviewer.SessionRef, bound.Manifest.Files[0].ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("completed reviewer reissued receipt: %v", err)
	}
}
func TestControlledFileReadsAreBoundToReviewerRealmNodeSessionAndSnapshot(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	producer := seedFilesExecution(t, s, "producer", "producer-agent")
	reviewer, bound := prepareFileReviewer(t, s, producer)
	for _, request := range []struct{ realm, run, node, session, id string }{{"other", reviewer.RunID, reviewer.NodeID, reviewer.SessionRef, "file-0001"}, {"realm", producer.RunID, producer.NodeID, producer.SessionRef, "file-0001"}, {"realm", reviewer.RunID, "wrong", reviewer.SessionRef, "file-0001"}, {"realm", reviewer.RunID, reviewer.NodeID, "wrong", "file-0001"}, {"realm", reviewer.RunID, reviewer.NodeID, reviewer.SessionRef, "unregistered"}} {
		if _, err := s.ReadRunReviewFile(ctx, request.realm, request.run, request.node, request.session, request.id); err == nil {
			t.Fatalf("unbound read allowed: %+v", request)
		}
	}
	readEveryFile(t, s, &reviewer, bound)
	first, err := s.ReadRunReviewFile(ctx, "realm", reviewer.RunID, reviewer.NodeID, reviewer.SessionRef, "file-0001")
	if err != nil || first.Receipt != reviewer.ReviewFileReceipts[0].Receipt {
		t.Fatalf("read retry not idempotent: %v", err)
	}
	reviewer.ReviewFileReceipts[0].Receipt = strings.Repeat("0", 64)
	if _, err = s.RecordTrustedTaskResult(ctx, "realm", reviewer, "runtime"); !errors.Is(err, ErrConflict) {
		t.Fatalf("model-forged read evidence accepted: %v", err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE governance_worker_heartbeats SET updated_at=now()-interval '1 minute' WHERE worker_id='agent:reviewer-agent'`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReadRunReviewFile(ctx, "realm", reviewer.RunID, reviewer.NodeID, reviewer.SessionRef, "file-0001"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expired runtime read: %v", err)
	}
}
func TestControlledFilesRejectBlobTamperingAndUnregisteredImpact(t *testing.T) {
	for _, mode := range []string{"tamper", "extra", "upload"} {
		t.Run(mode, func(t *testing.T) {
			s := taskTestStore(t)
			ctx := context.Background()
			producer := seedFilesExecution(t, s, "producer", "producer-agent")
			reviewer, bound := prepareFileReviewer(t, s, producer)
			readEveryFile(t, s, &reviewer, bound)
			recordReviewExecution(t, s, reviewer)
			if _, err := s.TransitionBusinessTask(ctx, "realm", producer.TaskID, "submit_review", "manager", passingGate()); err != nil {
				t.Fatal(err)
			}
			var err error
			switch mode {
			case "tamper":
				_, err = s.pool.Exec(ctx, `UPDATE governance_run_file_blobs SET body=convert_to(repeat('x',bytes),'UTF8') WHERE run_id=$1 AND entry_id='file-0001'`, producer.RunID)
			case "extra":
				_, err = s.pool.Exec(ctx, `INSERT INTO governance_run_file_blobs(realm,run_id,entry_id,name,media_type,bytes,sha256,body) SELECT realm,run_id,'unregistered',name,media_type,bytes,sha256,body FROM governance_run_file_blobs WHERE run_id=$1 AND entry_id='file-0001'`, producer.RunID)
			case "upload":
				_, err = s.pool.Exec(ctx, `INSERT INTO governance_task_artifacts(id,realm,task_id,run_id,name,content_type,created_by,status) VALUES('extra-upload','realm',$1,$2,'unreviewed','text/plain','employee','pending')`, producer.TaskID, producer.RunID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.TransitionBusinessTask(ctx, "realm", producer.TaskID, "complete", "manager", passingGate()); !errors.Is(err, ErrConflict) {
				t.Fatalf("%s accepted as covered impact: %v", mode, err)
			}
		})
	}
}
func TestControlledFilesRequireTrustedPreExecutionProfileAndAtomicBlobSet(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	result := seedReviewExecution(t, s, "producer", "producer-agent", "model-a", true)
	result.Files = []domain.RunTextFile{{Name: "file.txt", MediaType: "text/plain; charset=utf-8", Text: "complete"}}
	if _, err := s.RecordTrustedTaskResult(ctx, "realm", result, "runtime"); !errors.Is(err, ErrConflict) {
		t.Fatalf("files without pre-execution profile accepted: %v", err)
	}
	prepareReviewExecution(t, s, result, "model-a")
	if _, err := s.RecordTrustedTaskResult(ctx, "realm", result, "runtime"); !errors.Is(err, ErrConflict) {
		t.Fatalf("text-only snapshot registered files: %v", err)
	}
	if _, err := s.RecordTaskResult(ctx, "realm", result, "employee"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("human registered files: %v", err)
	}
	var blobs int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_run_file_blobs`).Scan(&blobs); err != nil || blobs != 0 {
		t.Fatalf("rejected result leaked blobs: %d %v", blobs, err)
	}
	result.Files = nil
	result.Output = json.RawMessage(`[{"type":"text","text":"safe"}]`)
	recordReviewExecution(t, s, result)
}
