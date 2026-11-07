package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

const runReviewDDL = `
CREATE TABLE IF NOT EXISTS governance_run_execution_snapshots (
 run_id TEXT PRIMARY KEY REFERENCES governance_task_runs(id), realm TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id), snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS governance_run_output_manifests (
 run_id TEXT PRIMARY KEY REFERENCES governance_task_runs(id), realm TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id), digest TEXT NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 manifest JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS governance_run_reviews (
 review_run_id TEXT PRIMARY KEY REFERENCES governance_task_runs(id), realm TEXT NOT NULL,
 producer_task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id), producer_run_id TEXT NOT NULL REFERENCES governance_task_runs(id),
 manifest_digest TEXT NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
 created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 CHECK(review_run_id<>producer_run_id)
);
CREATE INDEX IF NOT EXISTS governance_run_reviews_producer ON governance_run_reviews(realm,producer_run_id);
`

type PrepareRunExecutionRequest struct {
	NodeID         string `json:"node_id"`
	SessionRef     string `json:"session_ref"`
	PresetRevision int    `json:"preset_revision"`
	Provider       string `json:"provider"`
	Model          string `json:"model"`
}

func executionSnapshotTx(ctx context.Context, tx pgx.Tx, realm, runID string) (domain.RunExecutionSnapshot, error) {
	var snapshot domain.RunExecutionSnapshot
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT snapshot,created_at FROM governance_run_execution_snapshots WHERE realm=$1 AND run_id=$2`, realm, runID).Scan(&raw, &snapshot.CreatedAt)
	if err != nil {
		return snapshot, err
	}
	created := snapshot.CreatedAt
	err = json.Unmarshal(raw, &snapshot)
	snapshot.CreatedAt = created
	return snapshot, err
}

// PrepareRunExecution freezes facts before model input. No caller-selected
// profile or proven flag exists; only a current, tool-free Agent preset can
// enter the closed-output profile. Replay never refreshes historical facts.
func (s *Store) PrepareRunExecution(ctx context.Context, realm, runID string, req PrepareRunExecutionRequest) (domain.PreparedRunExecution, error) {
	var out domain.PreparedRunExecution
	if req.NodeID == "" || req.SessionRef == "" || req.PresetRevision < 1 || req.Provider == "" || req.Model == "" {
		return out, ErrBadRequest
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var taskID string
	if err = tx.QueryRow(ctx, `SELECT task_id FROM governance_task_runs WHERE realm=$1 AND id=$2`, realm, runID).Scan(&taskID); errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNotFound
	} else if err != nil {
		return out, err
	}
	var task domain.DelegatedTask
	if err = scanDelegatedTask(tx.QueryRow(ctx, delegationSelect+` WHERE t.realm=$1 AND t.id=$2 FOR UPDATE OF t`, realm, taskID), &task); err != nil {
		return out, err
	}
	var run domain.TaskRun
	if err = scanTaskRun(tx.QueryRow(ctx, taskRunSelect+` WHERE realm=$1 AND task_id=$2 ORDER BY attempt DESC LIMIT 1 FOR UPDATE`, realm, taskID), &run); err != nil {
		return out, err
	}
	if run.ID != runID || run.SchedulerTaskID != runID || run.AssignedNodeID != req.NodeID || run.SessionRef != req.SessionRef || !strings.HasPrefix(run.WorkerID, "agent:") || run.State != domain.DelegationRunning || !domain.DelegationStateActive(task.State) {
		return out, fmt.Errorf("%w: execution is not the current running Agent binding", ErrConflict)
	}
	stored, err := executionSnapshotTx(ctx, tx, realm, runID)
	if err == nil {
		if stored.NodeID != req.NodeID || stored.SessionRef != req.SessionRef || stored.PresetRevision != req.PresetRevision || stored.Provider != req.Provider || stored.Model != req.Model {
			return out, fmt.Errorf("%w: immutable execution identity differs", ErrConflict)
		}
		out.Snapshot = stored
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	} else {
		var p domain.AgentPreset
		if err = scanAgentPreset(tx.QueryRow(ctx, agentPresetSelect+` WHERE realm=$1 AND id=$2 FOR SHARE`, realm, strings.TrimPrefix(run.WorkerID, "agent:")), &p); err != nil {
			return out, err
		}
		if p.Status != "active" || p.Revision != req.PresetRevision || p.Provider != req.Provider || p.ModelRef != req.Model || (p.ProjectID != "" && p.ProjectID != task.ProjectID) {
			return out, fmt.Errorf("%w: preset differs from the executing runtime", ErrConflict)
		}
		var live bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_worker_heartbeats h JOIN governance_users u ON u.realm=h.realm AND u.id=$5 WHERE h.realm=$1 AND h.worker_id=$2 AND h.node_id=$3 AND h.preset_revision=$4 AND h.status='active' AND h.updated_at>now()-interval '30 seconds' AND u.status='active')`, realm, run.WorkerID, req.NodeID, req.PresetRevision, p.OwnerUserID).Scan(&live); err != nil {
			return out, err
		}
		if !live {
			return out, fmt.Errorf("%w: current execution runtime is unavailable", ErrConflict)
		}
		var already bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_task_results WHERE realm=$1 AND run_id=$2) OR EXISTS(SELECT 1 FROM governance_task_artifacts WHERE realm=$1 AND run_id=$2)`, realm, runID).Scan(&already); err != nil {
			return out, err
		}
		if already {
			return out, fmt.Errorf("%w: cannot attest execution after outputs already exist", ErrConflict)
		}
		out.Snapshot = domain.RunExecutionSnapshot{Realm: realm, TaskID: taskID, RunID: runID, WorkerID: run.WorkerID, NodeID: req.NodeID, SessionRef: req.SessionRef, PresetID: p.ID, PresetRevision: p.Revision, Provider: p.Provider, Model: p.ModelRef, OutputProfile: p.OutputProfile, Intent: task.Intent, IntentContract: task.IntentContract}
		if len(p.ConnectorIDs) > 0 || len(p.KnowledgeSpaceIDs) > 0 || p.SystemPromptRef != "" {
			out.Snapshot.OutputProfile = "unknown"
		}
		raw, _ := json.Marshal(out.Snapshot)
		if err = tx.QueryRow(ctx, `INSERT INTO governance_run_execution_snapshots(run_id,realm,task_id,snapshot) VALUES($1,$2,$3,$4) RETURNING created_at`, runID, realm, taskID, raw).Scan(&out.Snapshot.CreatedAt); err != nil {
			return out, err
		}
	}
	out.Review, err = reviewContextTx(ctx, tx, realm, runID)
	if err != nil {
		return out, err
	}
	if out.Review != nil {
		producer, err := executionSnapshotTx(ctx, tx, realm, out.Review.ProducerRunID)
		if err != nil {
			return out, err
		}
		if err = independentRunReviewer(producer, out.Snapshot, len(out.Review.Manifest.Entries)+len(out.Review.Manifest.Files)); err != nil {
			return out, err
		}
	}
	return out, tx.Commit(ctx)
}

func independentRunReviewer(producer, review domain.RunExecutionSnapshot, artifacts int) error {
	if !domain.ProvenOutputProfile(producer.OutputProfile) || review.OutputProfile != domain.ClosedTextOutputProfile {
		return fmt.Errorf("%w: review requires a closed tool-free execution profile", ErrConflict)
	}
	v := domain.ReviewerEligibility(domain.ReviewerFacts{Dispatcher: producer.WorkerID, Reviewer: review.WorkerID, DispatcherPreset: producer.PresetID, ReviewerPreset: review.PresetID, DispatcherModel: producer.Provider + ":" + producer.Model, ReviewerModel: review.Provider + ":" + review.Model, DispatcherNode: producer.NodeID, ReviewerNode: review.NodeID, AffectedArtifacts: artifacts})
	if !v.Eligible {
		return fmt.Errorf("%w: independent review required: %s", ErrConflict, v.Reason)
	}
	return nil
}

func reviewContextTx(ctx context.Context, tx pgx.Tx, realm, reviewRunID string) (*domain.RunReviewContext, error) {
	var out domain.RunReviewContext
	var raw []byte
	var current bool
	err := tx.QueryRow(ctx, `SELECT b.producer_task_id,b.producer_run_id,b.manifest_digest,m.manifest,b.expires_at,
	 b.expires_at>clock_timestamp() AND m.digest=b.manifest_digest AND p.attempt=(SELECT max(attempt) FROM governance_task_runs WHERE realm=$1 AND task_id=b.producer_task_id)
	 FROM governance_run_reviews b JOIN governance_run_output_manifests m ON m.realm=b.realm AND m.run_id=b.producer_run_id JOIN governance_task_runs p ON p.realm=b.realm AND p.id=b.producer_run_id WHERE b.realm=$1 AND b.review_run_id=$2`, realm, reviewRunID).Scan(&out.ProducerTaskID, &out.ProducerRunID, &out.ManifestDigest, &raw, &out.ExpiresAt, &current)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !current {
		return nil, fmt.Errorf("%w: review binding expired or producer superseded", ErrConflict)
	}
	if err = json.Unmarshal(raw, &out.Manifest); err != nil {
		return nil, err
	}
	if err = verifyManifestDigest(out.Manifest, out.ManifestDigest); err != nil {
		return nil, err
	}
	producer, err := executionSnapshotTx(ctx, tx, realm, out.ProducerRunID)
	if err != nil {
		return nil, err
	}
	out.ProducerIntent, out.ProducerContract = producer.Intent, producer.IntentContract
	return &out, nil
}

// BindRunReview must precede the reviewer's execution preparation. Its Run is
// independently scheduled as a different task; neither output nor approval is
// accepted from this request.
func (s *Store) BindRunReview(ctx context.Context, realm, producerTaskID, producerRunID, reviewTaskID, reviewRunID, actor string) (*domain.RunReviewContext, error) {
	if producerTaskID == reviewTaskID || producerRunID == reviewRunID || reviewTaskID == "" || reviewRunID == "" {
		return nil, ErrBadRequest
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := bindRunReviewTx(ctx, tx, realm, producerTaskID, producerRunID, reviewTaskID, reviewRunID, actor)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func bindRunReviewTx(ctx context.Context, tx pgx.Tx, realm, producerTaskID, producerRunID, reviewTaskID, reviewRunID, actor string) (*domain.RunReviewContext, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM governance_delegation_tasks WHERE realm=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE`, realm, []string{producerTaskID, reviewTaskID})
	if err != nil {
		return nil, err
	}
	n := 0
	for rows.Next() {
		n++
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if n != 2 {
		return nil, ErrNotFound
	}
	var producer, review domain.TaskRun
	if err = scanTaskRun(tx.QueryRow(ctx, taskRunSelect+` WHERE realm=$1 AND task_id=$2 ORDER BY attempt DESC LIMIT 1`, realm, producerTaskID), &producer); err != nil {
		return nil, err
	}
	if err = scanTaskRun(tx.QueryRow(ctx, taskRunSelect+` WHERE realm=$1 AND task_id=$2 ORDER BY attempt DESC LIMIT 1`, realm, reviewTaskID), &review); err != nil {
		return nil, err
	}
	if producer.ID != producerRunID || producer.State != "COMPLETED" || review.ID != reviewRunID || !domain.DelegationStateActive(review.State) || producer.WorkerID == review.WorkerID {
		return nil, fmt.Errorf("%w: review needs a current independent unstarted Run", ErrConflict)
	}
	var existing string
	err = tx.QueryRow(ctx, `SELECT producer_run_id FROM governance_run_reviews WHERE realm=$1 AND review_run_id=$2`, realm, reviewRunID).Scan(&existing)
	if err == nil {
		if existing != producerRunID {
			return nil, ErrConflict
		}
		out, err := reviewContextTx(ctx, tx, realm, reviewRunID)
		if err != nil {
			return nil, err
		}
		return out, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	var started bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_run_execution_snapshots WHERE realm=$1 AND run_id=$2) OR EXISTS(SELECT 1 FROM governance_task_results WHERE realm=$1 AND run_id=$2)`, realm, reviewRunID).Scan(&started); err != nil {
		return nil, err
	}
	if started {
		return nil, fmt.Errorf("%w: review binding must precede execution", ErrConflict)
	}
	var digest string
	if err = tx.QueryRow(ctx, `SELECT digest FROM governance_run_output_manifests WHERE realm=$1 AND task_id=$2 AND run_id=$3`, realm, producerTaskID, producerRunID).Scan(&digest); errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: producer has no closed output manifest", ErrConflict)
	} else if err != nil {
		return nil, err
	}
	var sameProject bool
	if err = tx.QueryRow(ctx, `SELECT p.project_id=r.project_id FROM governance_delegation_tasks p,governance_delegation_tasks r WHERE p.realm=$1 AND p.id=$2 AND r.realm=$1 AND r.id=$3`, realm, producerTaskID, reviewTaskID).Scan(&sameProject); err != nil {
		return nil, err
	}
	if !sameProject {
		return nil, ErrForbidden
	}
	if _, err = tx.Exec(ctx, `INSERT INTO governance_run_reviews(review_run_id,realm,producer_task_id,producer_run_id,manifest_digest,created_by) VALUES($1,$2,$3,$4,$5,$6)`, reviewRunID, realm, producerTaskID, producerRunID, digest, actor); err != nil {
		return nil, err
	}
	out, err := reviewContextTx(ctx, tx, realm, reviewRunID)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// CreateRunReview commits the new task, Run, review binding and scheduling
// outbox together. The scheduler cannot observe an unbound reviewer Run.
func (s *Store) CreateRunReview(ctx context.Context, producerTaskID, producerRunID string, task domain.DelegatedTask, run domain.TaskRun, receipts ...DelegationReceipt) (domain.DelegatedTask, domain.TaskRun, error) {
	if task.ID == producerTaskID || run.ID == producerRunID || task.AssigneeWorkerID != run.WorkerID || !strings.HasPrefix(run.WorkerID, "agent:") {
		return task, run, ErrBadRequest
	}
	created, err := s.createDelegatedTaskWithHook(ctx, task, &run, func(ctx context.Context, tx pgx.Tx, task domain.DelegatedTask, run domain.TaskRun) error {
		bound, err := bindRunReviewTx(ctx, tx, task.Realm, producerTaskID, producerRunID, task.ID, run.ID, task.RequesterUserID)
		if err != nil {
			return err
		}
		producer, err := executionSnapshotTx(ctx, tx, task.Realm, producerRunID)
		if err != nil {
			return err
		}
		var preset domain.AgentPreset
		if err = scanAgentPreset(tx.QueryRow(ctx, agentPresetSelect+` WHERE realm=$1 AND id=$2 FOR SHARE`, task.Realm, strings.TrimPrefix(run.WorkerID, "agent:")), &preset); errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var ownerStatus string
		if err = tx.QueryRow(ctx, `SELECT status FROM governance_users WHERE realm=$1 AND id=$2 FOR SHARE`, task.Realm, preset.OwnerUserID).Scan(&ownerStatus); err != nil {
			return err
		}
		if preset.Status != "active" || ownerStatus != "active" || task.AssigneeUserID != preset.OwnerUserID || (preset.ProjectID != "" && preset.ProjectID != task.ProjectID) {
			return ErrForbidden
		}
		profile := preset.OutputProfile
		if len(preset.ConnectorIDs) > 0 || len(preset.KnowledgeSpaceIDs) > 0 || preset.SystemPromptRef != "" {
			profile = "unknown"
		}
		planned := domain.RunExecutionSnapshot{WorkerID: run.WorkerID, PresetID: preset.ID, Provider: preset.Provider, Model: preset.ModelRef, OutputProfile: profile}
		if err = independentRunReviewer(producer, planned, len(bound.Manifest.Entries)+len(bound.Manifest.Files)); err != nil {
			return err
		}
		return nil
	}, receipts...)
	if err != nil {
		return task, run, err
	}
	storedRun, err := s.GetTaskRun(ctx, task.Realm, run.ID)
	return created, storedRun, err
}

func sealRunOutputTx(ctx context.Context, tx pgx.Tx, realm string, result domain.TaskResult, trusted bool) error {
	snapshot, err := executionSnapshotTx(ctx, tx, realm, result.RunID)
	if errors.Is(err, pgx.ErrNoRows) {
		if len(result.Files) > 0 || len(result.ReviewFileReceipts) > 0 {
			return fmt.Errorf("%w: file evidence requires a pre-execution profile", ErrConflict)
		}
		return nil
	}
	if err != nil {
		return err
	}
	if !trusted {
		return fmt.Errorf("%w: prepared output requires its authenticated runtime receipt", ErrForbidden)
	}
	if result.State != "COMPLETED" {
		return nil
	}
	if !domain.ProvenOutputProfile(snapshot.OutputProfile) {
		if len(result.Files) > 0 || len(result.ReviewFileReceipts) > 0 {
			return fmt.Errorf("%w: unknown execution cannot register controlled file evidence", ErrConflict)
		}
		return nil
	}
	if err = verifyReviewFileReceiptsTx(ctx, tx, realm, result); err != nil {
		return err
	}
	var manifest domain.RunOutputManifest
	var digest string
	if snapshot.OutputProfile == domain.ClosedTextFilesOutputProfile {
		manifest, digest, err = domain.BuildRunTextFilesManifest(result)
	} else {
		if len(result.Files) > 0 {
			return fmt.Errorf("%w: text-only execution cannot register files", ErrConflict)
		}
		manifest, digest, err = domain.BuildRunOutputManifest(result)
	}
	if err != nil {
		return fmt.Errorf("%w: %v", ErrConflict, err)
	}
	if err = persistRunFileBlobsTx(ctx, tx, realm, result, manifest); err != nil {
		return err
	}
	raw, _ := json.Marshal(manifest)
	_, err = tx.Exec(ctx, `INSERT INTO governance_run_output_manifests(run_id,realm,task_id,digest,manifest) VALUES($1,$2,$3,$4,$5)`, result.RunID, realm, result.TaskID, digest, raw)
	return err
}

// requireProvenTaskHistoryTx runs under the same task lock as acceptance.
// A later text-only Run cannot erase possible effects of an earlier execution.
// Closed historical deliverables may be superseded without their own approval:
// their snapshots and manifests still prove that they granted no external tools.
func requireProvenTaskHistoryTx(ctx context.Context, tx pgx.Tx, realm, taskID string) error {
	var unprovenRunID string
	err := tx.QueryRow(ctx, `SELECT r.id FROM governance_task_runs r
	 LEFT JOIN governance_run_execution_snapshots s ON s.realm=r.realm AND s.run_id=r.id AND s.task_id=r.task_id
	 LEFT JOIN governance_run_output_manifests m ON m.realm=r.realm AND m.run_id=r.id AND m.task_id=r.task_id
	 WHERE r.realm=$1 AND r.task_id=$2 AND (
	   (s.run_id IS NOT NULL AND NOT COALESCE(s.snapshot->>'output_profile'=ANY($3::text[]),false))
	   OR EXISTS(SELECT 1 FROM governance_task_artifacts a WHERE a.realm=r.realm AND a.run_id=r.id)
	   OR ((r.started_at IS NOT NULL OR r.state='COMPLETED'
	       OR EXISTS(SELECT 1 FROM governance_task_results e WHERE e.realm=r.realm AND e.run_id=r.id))
	     AND NOT COALESCE(s.snapshot->>'output_profile'=ANY($3::text[]) AND s.snapshot->>'realm'=r.realm
	       AND s.snapshot->>'task_id'=r.task_id AND s.snapshot->>'run_id'=r.id
	       AND m.manifest->>'scope'=s.snapshot->>'output_profile' AND m.manifest->>'task_id'=r.task_id AND m.manifest->>'run_id'=r.id,false))
	   OR (EXISTS(SELECT 1 FROM governance_run_file_blobs f WHERE f.realm=r.realm AND f.run_id=r.id) AND NOT COALESCE(s.snapshot->>'output_profile'=$4,false))
	 ) ORDER BY r.attempt LIMIT 1`, realm, taskID, []string{domain.ClosedTextOutputProfile, domain.ClosedTextFilesOutputProfile}, domain.ClosedTextFilesOutputProfile).Scan(&unprovenRunID)
	if errors.Is(err, pgx.ErrNoRows) {
		return verifyHistoricalRunBlobsTx(ctx, tx, realm, taskID)
	}
	if err != nil {
		return err
	}
	return fmt.Errorf("%w: task history contains unproven execution impact from run %s; a later closed Run cannot replace that evidence", ErrConflict, unprovenRunID)
}

// requireRunReviewTx executes under the producer task's complete lock. Unknown
// historical impact, legacy results, missing approval and stale/replayed
// evidence all fail closed. Every current closed output set needs a review.
func requireRunReviewTx(ctx context.Context, tx pgx.Tx, realm, taskID string) (map[string]any, error) {
	if err := requireProvenTaskHistoryTx(ctx, tx, realm, taskID); err != nil {
		return nil, err
	}
	var producerRunID string
	if err := tx.QueryRow(ctx, `SELECT id FROM governance_task_runs WHERE realm=$1 AND task_id=$2 ORDER BY attempt DESC LIMIT 1`, realm, taskID).Scan(&producerRunID); err != nil {
		return nil, err
	}
	producer, err := executionSnapshotTx(ctx, tx, realm, producerRunID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: execution impact is unprovable; no pre-execution snapshot", ErrConflict)
	} else if err != nil {
		return nil, err
	}
	var digest string
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT digest,manifest FROM governance_run_output_manifests WHERE realm=$1 AND task_id=$2 AND run_id=$3`, realm, taskID, producerRunID).Scan(&digest, &raw); errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: closed output manifest required", ErrConflict)
	} else if err != nil {
		return nil, err
	}
	var manifest domain.RunOutputManifest
	if err = json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	if manifest.Scope != producer.OutputProfile || verifyManifestDigest(manifest, digest) != nil {
		return nil, fmt.Errorf("%w: output manifest does not match execution", ErrConflict)
	}
	if err = verifyRunBlobSetTx(ctx, tx, realm, producerRunID, manifest); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT b.review_run_id,r.task_id,e.payload FROM governance_run_reviews b JOIN governance_task_runs r ON r.realm=b.realm AND r.id=b.review_run_id JOIN governance_task_results e ON e.realm=r.realm AND e.run_id=r.id
	 WHERE b.realm=$1 AND b.producer_run_id=$2 AND b.manifest_digest=$3 AND b.expires_at>clock_timestamp() AND r.state='COMPLETED' AND e.payload->>'state'='COMPLETED'
	 AND r.attempt=(SELECT max(attempt) FROM governance_task_runs WHERE realm=$1 AND task_id=r.task_id) ORDER BY b.created_at,b.review_run_id`, realm, producerRunID, digest)
	if err != nil {
		return nil, err
	}
	type candidate struct {
		id, taskID string
		raw        []byte
	}
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err = rows.Scan(&c.id, &c.taskID, &c.raw); err != nil {
			rows.Close()
			return nil, err
		}
		candidates = append(candidates, c)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	for _, c := range candidates {
		// Run retries lock the task before advancing the current attempt. Keep
		// that fact stable until acceptance commits. SKIP LOCKED avoids a lock
		// cycle with review binding (which locks both tasks in sorted order).
		var locked string
		err = tx.QueryRow(ctx, `SELECT id FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR SHARE SKIP LOCKED`, realm, c.taskID).Scan(&locked)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		// A retry may have committed between candidate discovery and the lock.
		var current bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_run_reviews b JOIN governance_task_runs r ON r.realm=b.realm AND r.id=b.review_run_id
		 WHERE b.realm=$1 AND b.review_run_id=$2 AND b.producer_run_id=$3 AND b.manifest_digest=$4 AND b.expires_at>clock_timestamp()
		 AND r.state='COMPLETED' AND r.attempt=(SELECT max(attempt) FROM governance_task_runs WHERE realm=$1 AND task_id=$5))`, realm, c.id, producerRunID, digest, c.taskID).Scan(&current); err != nil {
			return nil, err
		}
		if !current {
			continue
		}
		review, err := executionSnapshotTx(ctx, tx, realm, c.id)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if independentRunReviewer(producer, review, len(manifest.Entries)+len(manifest.Files)) != nil {
			continue
		}
		var result domain.TaskResult
		if err = json.Unmarshal(c.raw, &result); err != nil {
			return nil, err
		}
		approved, err := domain.ReviewApproval(result.Output, digest)
		if err != nil || !approved {
			continue
		}
		if err = verifyReviewFileReceiptsTx(ctx, tx, realm, result); err != nil {
			continue
		}
		return map[string]any{"review_run_id": c.id, "producer_run_id": producerRunID, "manifest_digest": digest, "scope": manifest.Scope, "artifacts": len(manifest.Entries) + len(manifest.Files), "files": len(manifest.Files), "verified": true}, nil
	}
	return nil, fmt.Errorf("%w: a current completed independent review approving the exact closed output manifest is required", ErrConflict)
}

func (s *Store) RecordTrustedTaskResult(ctx context.Context, realm string, result domain.TaskResult, actor string) (domain.TaskResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = recordTaskResultTx(ctx, tx, realm, &result, actor, true); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
