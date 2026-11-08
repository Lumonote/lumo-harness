package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/storageledger"
	"unicode/utf8"
)

const runFilesDDL = `
CREATE TABLE IF NOT EXISTS governance_run_file_blobs (
 realm TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES governance_task_runs(id),entry_id TEXT NOT NULL,
 name TEXT NOT NULL,media_type TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 32768),
 sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),body BYTEA NOT NULL CHECK(octet_length(body)=bytes),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(run_id,entry_id)
);
CREATE INDEX IF NOT EXISTS governance_run_file_blobs_realm ON governance_run_file_blobs(realm,run_id);
CREATE TABLE IF NOT EXISTS governance_review_file_reads (
 realm TEXT NOT NULL,review_run_id TEXT NOT NULL REFERENCES governance_run_reviews(review_run_id),
 producer_run_id TEXT NOT NULL,entry_id TEXT NOT NULL,manifest_digest TEXT NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
 receipt TEXT NOT NULL CHECK(receipt ~ '^[0-9a-f]{64}$'),node_id TEXT NOT NULL,session_ref TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(review_run_id,entry_id),
 FOREIGN KEY(producer_run_id,entry_id) REFERENCES governance_run_file_blobs(run_id,entry_id)
);`

func verifyManifestDigest(manifest domain.RunOutputManifest, digest string) error {
	raw, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(raw)
	if hex.EncodeToString(hash[:]) != digest {
		return fmt.Errorf("%w: output manifest integrity mismatch", ErrConflict)
	}
	return nil
}

// Human reads return the verified immutable blob bytes but issue no review
// execution receipt. The API has already checked this task's viewer access.
func (s *Store) controlledResultFiles(ctx context.Context, realm, taskID, runID string) ([]domain.RunTextFile, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw []byte
	var digest string
	if err = tx.QueryRow(ctx, `SELECT manifest,digest FROM governance_run_output_manifests WHERE realm=$1 AND task_id=$2 AND run_id=$3`, realm, taskID, runID).Scan(&raw, &digest); err != nil {
		return nil, err
	}
	var manifest domain.RunOutputManifest
	if err = json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	if (manifest.Scope != domain.ClosedTextFilesOutputProfile && manifest.Scope != domain.ClosedRepositoryOutputProfile) || verifyManifestDigest(manifest, digest) != nil {
		return nil, ErrConflict
	}
	if err = verifyRunBlobSetTx(ctx, tx, realm, runID, manifest); err != nil {
		return nil, err
	}
	var files []domain.RunTextFile
	for _, entry := range manifest.Files {
		file, err := verifiedRunBlobTx(ctx, tx, realm, runID, entry)
		if err != nil {
			return nil, err
		}
		files = append(files, domain.RunTextFile{Name: file.Name, MediaType: file.MediaType, Text: file.Text})
	}
	return files, tx.Commit(ctx)
}

func persistRunFileBlobsTx(ctx context.Context, tx pgx.Tx, realm string, result domain.TaskResult, manifest domain.RunOutputManifest) error {
	if len(result.Files) != len(manifest.Files) {
		return ErrConflict
	}
	var project string
	if len(manifest.Files) > 0 {
		if err := tx.QueryRow(ctx, `SELECT project_id FROM governance_delegation_tasks WHERE realm=$1 AND id=$2`, realm, result.TaskID).Scan(&project); err != nil {
			return err
		}
	}
	for i, entry := range manifest.Files {
		file := result.Files[i]
		if err := storageledger.Register(ctx, tx, storageledger.Charge{Realm: realm, ProjectID: project, Kind: "run-file", ReferenceID: result.RunID + "/" + entry.ID, Bytes: int64(entry.Bytes), ObjectKey: "pg-run-file/" + result.RunID + "/" + entry.ID}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO governance_run_file_blobs(realm,run_id,entry_id,name,media_type,bytes,sha256,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, realm, result.RunID, entry.ID, entry.Name, entry.MediaType, entry.Bytes, entry.SHA256, []byte(file.Text)); err != nil {
			return err
		}
	}
	return nil
}

func verifiedRunBlobTx(ctx context.Context, tx pgx.Tx, realm, runID string, expected domain.RunFileEntry) (domain.RunReviewFile, error) {
	var out domain.RunReviewFile
	var body []byte
	err := tx.QueryRow(ctx, `SELECT entry_id,name,media_type,bytes,sha256,body FROM governance_run_file_blobs WHERE realm=$1 AND run_id=$2 AND entry_id=$3`, realm, runID, expected.ID).Scan(&out.ID, &out.Name, &out.MediaType, &out.Bytes, &out.SHA256, &body)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, fmt.Errorf("%w: controlled file blob missing", ErrConflict)
	}
	if err != nil {
		return out, err
	}
	hash := sha256.Sum256(body)
	if out.RunFileEntry != expected || len(body) != expected.Bytes || hex.EncodeToString(hash[:]) != expected.SHA256 || !utf8.Valid(body) {
		return out, fmt.Errorf("%w: controlled file blob integrity mismatch", ErrConflict)
	}
	out.Text = string(body)
	if err = (domain.RunTextFile{Name: out.Name, MediaType: out.MediaType, Text: out.Text}).Validate(); err != nil {
		return out, fmt.Errorf("%w: invalid controlled file blob", ErrConflict)
	}
	return out, nil
}

func verifyRunBlobSetTx(ctx context.Context, tx pgx.Tx, realm, runID string, manifest domain.RunOutputManifest) error {
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM governance_run_file_blobs WHERE realm=$1 AND run_id=$2`, realm, runID).Scan(&count); err != nil {
		return err
	}
	filesProfile := manifest.Scope == domain.ClosedTextFilesOutputProfile || manifest.Scope == domain.ClosedRepositoryOutputProfile
	if count != len(manifest.Files) || (filesProfile && count == 0) || (!filesProfile && count != 0) {
		return fmt.Errorf("%w: controlled output file set is incomplete or unregistered", ErrConflict)
	}
	seen := map[string]bool{}
	for _, entry := range manifest.Files {
		if seen[entry.ID] {
			return ErrConflict
		}
		seen[entry.ID] = true
		if _, err := verifiedRunBlobTx(ctx, tx, realm, runID, entry); err != nil {
			return err
		}
	}
	return verifyRepositorySetTx(ctx, tx, realm, runID, manifest)
}

const currentReviewReaderSQL = `SELECT r.task_id FROM governance_task_runs r
 JOIN governance_delegation_tasks t ON t.id=r.task_id AND t.realm=r.realm
 JOIN governance_run_execution_snapshots s ON s.run_id=r.id AND s.realm=r.realm
 JOIN governance_agent_presets p ON p.realm=r.realm AND 'agent:'||p.id=r.worker_id
 JOIN governance_users u ON u.realm=p.realm AND u.id=p.owner_user_id
 WHERE r.realm=$1 AND r.id=$2 AND r.assigned_node_id=$3 AND r.session_ref=$4 AND r.state='RUNNING'
 AND r.attempt=(SELECT max(attempt) FROM governance_task_runs WHERE realm=$1 AND task_id=r.task_id)
 AND s.snapshot->>'output_profile'=$5 AND s.snapshot->>'node_id'=$3 AND s.snapshot->>'session_ref'=$4
 AND s.snapshot->>'worker_id'=r.worker_id AND s.snapshot->>'preset_revision'=p.revision::text
 AND p.status='active' AND u.status='active' AND t.business_state NOT IN ('DONE','REJECTED','ARCHIVED')
 AND EXISTS(SELECT 1 FROM governance_worker_heartbeats h WHERE h.realm=r.realm AND h.worker_id=r.worker_id AND h.node_id=$3 AND h.preset_revision=p.revision AND h.status='active' AND h.updated_at>clock_timestamp()-interval '30 seconds')
 AND NOT EXISTS(SELECT 1 FROM governance_task_results e WHERE e.realm=r.realm AND e.run_id=r.id)`

// ReadRunReviewFile only serves a prepared, independently bound reviewer. The
// runtime re-hashes this entire response before exposing it to the model; its
// immutable result must include the issued receipt for every manifest file.
func (s *Store) ReadRunReviewFile(ctx context.Context, realm, reviewRunID, nodeID, sessionRef, entryID string) (domain.RunReviewFile, error) {
	var out domain.RunReviewFile
	if nodeID == "" || sessionRef == "" || len(entryID) > 32 {
		return out, ErrBadRequest
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var taskID string
	err = tx.QueryRow(ctx, currentReviewReaderSQL+` FOR SHARE OF t,r,p,u`, realm, reviewRunID, nodeID, sessionRef, domain.ClosedTextOutputProfile).Scan(&taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrForbidden
	}
	if err != nil {
		return out, err
	}
	review, err := reviewContextTx(ctx, tx, realm, reviewRunID)
	if err != nil {
		return out, err
	}
	if review == nil || (review.Manifest.Scope != domain.ClosedTextFilesOutputProfile && review.Manifest.Scope != domain.ClosedRepositoryOutputProfile) {
		return out, ErrForbidden
	}
	reviewer, err := executionSnapshotTx(ctx, tx, realm, reviewRunID)
	if err != nil {
		return out, err
	}
	producer, err := executionSnapshotTx(ctx, tx, realm, review.ProducerRunID)
	if err != nil {
		return out, err
	}
	if err = independentRunReviewer(producer, reviewer, len(review.Manifest.Entries)+len(review.Manifest.Files)); err != nil {
		return out, err
	}
	var found *domain.RunFileEntry
	for i := range review.Manifest.Files {
		if review.Manifest.Files[i].ID == entryID {
			found = &review.Manifest.Files[i]
			break
		}
	}
	if found == nil {
		return out, ErrNotFound
	}
	out, err = verifiedRunBlobTx(ctx, tx, realm, review.ProducerRunID, *found)
	if err != nil {
		return out, err
	}
	// A statement waiting for row locks can have observed an older READ
	// COMMITTED snapshot. Re-read after every authorization lock is held,
	// immediately before issuing the receipt. Keep owner and preset locked
	// until commit; heartbeat and expiry use the database wall clock.
	if err = tx.QueryRow(ctx, currentReviewReaderSQL, realm, reviewRunID, nodeID, sessionRef, domain.ClosedTextOutputProfile).Scan(&taskID); errors.Is(err, pgx.ErrNoRows) {
		return out, ErrForbidden
	} else if err != nil {
		return out, err
	}
	fresh, err := reviewContextTx(ctx, tx, realm, reviewRunID)
	if err != nil {
		return out, err
	}
	if fresh == nil || fresh.ProducerRunID != review.ProducerRunID || fresh.ManifestDigest != review.ManifestDigest {
		return out, ErrConflict
	}
	token := make([]byte, 32)
	if _, err = rand.Read(token); err != nil {
		return out, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO governance_review_file_reads(realm,review_run_id,producer_run_id,entry_id,manifest_digest,receipt,node_id,session_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(review_run_id,entry_id) DO NOTHING`, realm, reviewRunID, review.ProducerRunID, entryID, review.ManifestDigest, hex.EncodeToString(token), nodeID, sessionRef)
	if err != nil {
		return out, err
	}
	err = tx.QueryRow(ctx, `SELECT receipt FROM governance_review_file_reads WHERE realm=$1 AND review_run_id=$2 AND producer_run_id=$3 AND entry_id=$4 AND manifest_digest=$5 AND node_id=$6 AND session_ref=$7`, realm, reviewRunID, review.ProducerRunID, entryID, review.ManifestDigest, nodeID, sessionRef).Scan(&out.Receipt)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

func verifyReviewFileReceiptsTx(ctx context.Context, tx pgx.Tx, realm string, result domain.TaskResult) error {
	review, err := reviewContextTx(ctx, tx, realm, result.RunID)
	if err != nil {
		return err
	}
	if review == nil {
		if len(result.ReviewFileReceipts) > 0 {
			return fmt.Errorf("%w: file receipts require a bound reviewer", ErrConflict)
		}
		return nil
	}
	if len(review.Manifest.Files) != len(result.ReviewFileReceipts) {
		return fmt.Errorf("%w: reviewer must read every complete manifest file", ErrConflict)
	}
	seen := map[string]bool{}
	for _, read := range result.ReviewFileReceipts {
		if seen[read.ID] {
			return ErrConflict
		}
		seen[read.ID] = true
		var found bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_review_file_reads WHERE realm=$1 AND review_run_id=$2 AND producer_run_id=$3 AND entry_id=$4 AND manifest_digest=$5 AND receipt=$6 AND node_id=$7 AND session_ref=$8)`, realm, result.RunID, review.ProducerRunID, read.ID, review.ManifestDigest, read.Receipt, result.NodeID, result.SessionRef).Scan(&found); err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("%w: reviewer file read receipt is not bound to this execution", ErrConflict)
		}
	}
	for _, entry := range review.Manifest.Files {
		if !seen[entry.ID] {
			return ErrConflict
		}
	}
	return verifyRunBlobSetTx(ctx, tx, realm, review.ProducerRunID, review.Manifest)
}

func verifyHistoricalRunBlobsTx(ctx context.Context, tx pgx.Tx, realm, taskID string) error {
	rows, err := tx.Query(ctx, `SELECT m.run_id,m.manifest,m.digest FROM governance_run_output_manifests m WHERE m.realm=$1 AND m.task_id=$2`, realm, taskID)
	if err != nil {
		return err
	}
	type item struct {
		id     string
		raw    []byte
		digest string
	}
	var all []item
	for rows.Next() {
		var v item
		if err = rows.Scan(&v.id, &v.raw, &v.digest); err != nil {
			rows.Close()
			return err
		}
		all = append(all, v)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for _, v := range all {
		var m domain.RunOutputManifest
		if err = json.Unmarshal(v.raw, &m); err != nil {
			return err
		}
		if err = verifyManifestDigest(m, v.digest); err != nil {
			return err
		}
		if err = verifyRunBlobSetTx(ctx, tx, realm, v.id, m); err != nil {
			return err
		}
	}
	return nil
}
