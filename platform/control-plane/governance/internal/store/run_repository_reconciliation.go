package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

// All status, preparation and completion operations consult current account and
// task grants under the organization lock. A reconciliation read grant is never
// a replacement for a second authorization check after external I/O.
func repositoryPublicationAccessTx(ctx context.Context, tx pgx.Tx, realm, taskID, actor string, admin bool) error {
	var state string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(business_state,'') FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, taskID).Scan(&state); err != nil {
		return err
	}
	if state == domain.BusinessRejected || state == domain.BusinessArchived {
		return ErrConflict
	}
	return authorizeArtifactWrite(ctx, tx, realm, taskID, actor, admin)
}

func repositoryPublicationRowTx(ctx context.Context, tx pgx.Tx, realm, taskID, runID, actor string) (RepositoryPublication, error) {
	var out RepositoryPublication
	var issuer string
	err := tx.QueryRow(ctx, `SELECT id::text,manifest_digest,status,url,actor,reconciliation,reconciliation_reason,reconciliation_revision,checked_at FROM governance_repository_publications WHERE realm=$1 AND task_id=$2 AND run_id=$3 FOR UPDATE`, realm, taskID, runID).Scan(&out.ID, &out.ManifestDigest, &out.Status, &out.URL, &issuer, &out.Reconciliation, &out.ReconciliationReason, &out.ReconciliationRevision, &out.CheckedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return RepositoryPublication{Status: "unpublished"}, nil
	}
	if err != nil {
		return out, err
	}
	if issuer != actor {
		return RepositoryPublication{}, ErrForbidden
	}
	return out, nil
}

func repositoryReconciliationPermitTx(ctx context.Context, tx pgx.Tx, realm, taskID, runID, actor string) (RepositoryPublication, error) {
	out, err := repositoryPublicationRowTx(ctx, tx, realm, taskID, runID, actor)
	if err != nil {
		return out, err
	}
	if out.Status != "publishing" && out.Status != "draft" {
		return out, ErrConflict
	}
	gate, err := requireRunReviewTx(ctx, tx, realm, taskID)
	if err != nil {
		return out, err
	}
	if gate["producer_run_id"] != runID || gate["scope"] != domain.ClosedRepositoryOutputProfile || gate["manifest_digest"] != out.ManifestDigest {
		return out, ErrConflict
	}
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT manifest FROM governance_run_output_manifests WHERE realm=$1 AND run_id=$2 AND digest=$3`, realm, runID, out.ManifestDigest).Scan(&raw); err != nil {
		return out, err
	}
	var manifest domain.RunOutputManifest
	if err = json.Unmarshal(raw, &manifest); err != nil {
		return out, err
	}
	if manifest.Repository == nil {
		return out, ErrConflict
	}
	out.Repository = manifest.Repository.Repository
	out.BaseCommit = manifest.Repository.BaseCommit
	out.BaseBranch = manifest.Repository.BaseBranch
	for _, entry := range manifest.Files {
		file, e := verifiedRunBlobTx(ctx, tx, realm, runID, entry)
		if e != nil {
			return out, e
		}
		var change domain.RepositoryChange
		if e = json.Unmarshal([]byte(file.Text), &change); e != nil {
			return out, e
		}
		out.Changes = append(out.Changes, change)
	}
	return out, nil
}

// Status does not grant any external operation or disclose the full reviewed
// bytes; PrepareRepositoryReconciliation revalidates the independent review.
func (s *Store) RepositoryPublicationStatus(ctx context.Context, realm, taskID, runID, actor string, admin bool) (RepositoryPublication, error) {
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return RepositoryPublication{}, err
	}
	defer tx.Rollback(ctx)
	if err = repositoryPublicationAccessTx(ctx, tx, realm, taskID, actor, admin); err != nil {
		return RepositoryPublication{}, err
	}
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_task_runs WHERE realm=$1 AND task_id=$2 AND id=$3)`, realm, taskID, runID).Scan(&exists); err != nil {
		return RepositoryPublication{}, err
	}
	if !exists {
		return RepositoryPublication{}, ErrNotFound
	}
	out, err := repositoryPublicationRowTx(ctx, tx, realm, taskID, runID, actor)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) PrepareRepositoryReconciliation(ctx context.Context, realm, taskID, runID, actor string, admin bool) (RepositoryPublication, error) {
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return RepositoryPublication{}, err
	}
	defer tx.Rollback(ctx)
	if err = repositoryPublicationAccessTx(ctx, tx, realm, taskID, actor, admin); err != nil {
		return RepositoryPublication{}, err
	}
	out, err := repositoryReconciliationPermitTx(ctx, tx, realm, taskID, runID, actor)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

// An unknown read is durable evidence of uncertainty. It cannot release the
// publication fence or erase a previously reported URL. The revision prevents
// slow/concurrent reads from overwriting a newer observation.
func (s *Store) RecordRepositoryReconciliation(ctx context.Context, realm, taskID, runID, id, digest, actor string, admin bool, revision int64, outcome, reason, url string) (RepositoryPublication, error) {
	if !repositoryPublicationID.MatchString(id) || !taskArtifactHash.MatchString(digest) || revision < 0 || len(url) > 2048 || (outcome != "confirmed" && outcome != "unknown") || (outcome == "confirmed" && reason != "confirmed") || (outcome == "unknown" && (reason != "provider_unavailable" && reason != "evidence_mismatch")) || (outcome == "unknown" && url != "") {
		return RepositoryPublication{}, ErrBadRequest
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return RepositoryPublication{}, err
	}
	defer tx.Rollback(ctx)
	if err = repositoryPublicationAccessTx(ctx, tx, realm, taskID, actor, admin); err != nil {
		return RepositoryPublication{}, err
	}
	out, err := repositoryReconciliationPermitTx(ctx, tx, realm, taskID, runID, actor)
	if err != nil {
		return out, err
	}
	if out.ID != id || out.ManifestDigest != digest || out.ReconciliationRevision != revision {
		return out, ErrConflict
	}
	if outcome == "confirmed" {
		prefix := "https://github.com/" + out.Repository + "/pull/"
		if !strings.HasPrefix(url, prefix) || !repositoryPullNumber.MatchString(strings.TrimPrefix(url, prefix)) {
			return out, ErrBadRequest
		}
		if out.URL != "" && out.URL != url {
			return out, ErrConflict
		}
	}
	err = tx.QueryRow(ctx, `UPDATE governance_repository_publications SET reconciliation=$5,reconciliation_reason=$6,reconciliation_revision=reconciliation_revision+1,checked_at=clock_timestamp(),status=CASE WHEN $5='confirmed' THEN 'draft' ELSE status END,url=CASE WHEN $5='confirmed' THEN $7 ELSE url END,published_at=CASE WHEN $5='confirmed' THEN COALESCE(published_at,now()) ELSE published_at END WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND id=$4::uuid RETURNING status,url,reconciliation,reconciliation_reason,reconciliation_revision,checked_at`, realm, taskID, runID, id, outcome, reason, url).Scan(&out.Status, &out.URL, &out.Reconciliation, &out.ReconciliationReason, &out.ReconciliationRevision, &out.CheckedAt)
	if err != nil {
		return out, err
	}
	detail, _ := json.Marshal(map[string]any{"publication_id": id, "manifest_digest": digest, "outcome": outcome, "reason": reason, "revision": out.ReconciliationRevision, "url": out.URL})
	if err = insertTaskAudit(ctx, tx, taskID, "repository_publication_reconciled", actor, detail); err != nil {
		return out, err
	}
	out.Changes = nil
	return out, tx.Commit(ctx)
}
