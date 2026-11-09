package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"regexp"
	"strings"
	"time"
)

const runRepositoryDDL = `
CREATE TABLE IF NOT EXISTS governance_run_repository_snapshots (
 realm TEXT NOT NULL,run_id TEXT PRIMARY KEY REFERENCES governance_task_runs(id),
 digest TEXT NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS governance_repository_publications (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),realm TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id),run_id TEXT NOT NULL REFERENCES governance_task_runs(id),
 manifest_digest TEXT NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),actor TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','publishing','draft')),
 url TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),published_at TIMESTAMPTZ,
 UNIQUE(realm,run_id,manifest_digest)
);
ALTER TABLE governance_repository_publications ADD COLUMN IF NOT EXISTS reconciliation TEXT NOT NULL DEFAULT '' CHECK(reconciliation IN ('','confirmed','unknown'));
ALTER TABLE governance_repository_publications ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT NOT NULL DEFAULT '' CHECK(reconciliation_reason IN ('','confirmed','provider_unavailable','evidence_mismatch'));
ALTER TABLE governance_repository_publications ADD COLUMN IF NOT EXISTS reconciliation_revision BIGINT NOT NULL DEFAULT 0 CHECK(reconciliation_revision >= 0);
ALTER TABLE governance_repository_publications ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;`

func repositorySnapshotTx(ctx context.Context, tx pgx.Tx, realm, runID string) (domain.RepositorySnapshot, error) {
	var out domain.RepositorySnapshot
	var raw []byte
	var digest string
	if err := tx.QueryRow(ctx, `SELECT snapshot,digest FROM governance_run_repository_snapshots WHERE realm=$1 AND run_id=$2`, realm, runID).Scan(&raw, &digest); err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, err
	}
	actual, err := domain.RepositorySnapshotDigest(out)
	if err != nil || actual != digest {
		return out, fmt.Errorf("%w: repository snapshot integrity mismatch", ErrConflict)
	}
	return out, nil
}
func freezeRepositoryTx(ctx context.Context, tx pgx.Tx, realm, runID, profile string, input *domain.RepositorySnapshot) error {
	if profile != domain.ClosedRepositoryOutputProfile {
		if input != nil {
			return fmt.Errorf("%w: snapshot requires the repository profile", ErrConflict)
		}
		return nil
	}
	if input == nil {
		return fmt.Errorf("%w: deployment-approved repository snapshot required", ErrConflict)
	}
	digest, err := domain.RepositorySnapshotDigest(*input)
	if err != nil {
		return fmt.Errorf("%w: invalid bounded repository snapshot", ErrBadRequest)
	}
	var prior string
	err = tx.QueryRow(ctx, `SELECT digest FROM governance_run_repository_snapshots WHERE realm=$1 AND run_id=$2`, realm, runID).Scan(&prior)
	if err == nil {
		if prior != digest {
			return fmt.Errorf("%w: immutable repository base changed", ErrConflict)
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	raw, _ := json.Marshal(input)
	_, err = tx.Exec(ctx, `INSERT INTO governance_run_repository_snapshots(realm,run_id,digest,snapshot)VALUES($1,$2,$3,$4)`, realm, runID, digest, raw)
	return err
}

func verifyRepositorySetTx(ctx context.Context, tx pgx.Tx, realm, runID string, manifest domain.RunOutputManifest) error {
	if manifest.Scope != domain.ClosedRepositoryOutputProfile {
		if manifest.Repository != nil {
			return ErrConflict
		}
		return nil
	}
	snapshot, err := repositorySnapshotTx(ctx, tx, realm, runID)
	if err != nil {
		return err
	}
	after := append([]domain.RepositoryFile(nil), snapshot.Files...)
	seen := map[string]bool{}
	for _, entry := range manifest.Files {
		blob, err := verifiedRunBlobTx(ctx, tx, realm, runID, entry)
		if err != nil {
			return err
		}
		var change domain.RepositoryChange
		if err = json.Unmarshal([]byte(blob.Text), &change); err != nil {
			return err
		}
		if seen[change.Path] {
			return ErrConflict
		}
		seen[change.Path] = true
		found := false
		for i, file := range after {
			if file.Path == change.Path {
				if file.Text != change.Before {
					return ErrConflict
				}
				after[i].Text = change.After
				found = true
				break
			}
		}
		if !found {
			return ErrConflict
		}
	}
	blocks := []map[string]string{}
	for _, entry := range manifest.Entries {
		blocks = append(blocks, map[string]string{"type": "text", "text": entry.Text})
	}
	output, _ := json.Marshal(blocks)
	expected, files, err := domain.BuildRepositoryManifest(domain.TaskResult{TaskID: manifest.TaskID, RunID: runID, Summary: manifest.Summary, Output: output, RepositoryFiles: after}, snapshot)
	if err != nil {
		return err
	}
	a, _ := json.Marshal(expected)
	b, _ := json.Marshal(manifest)
	if string(a) != string(b) {
		return fmt.Errorf("%w: repository patch enumeration differs from frozen bytes", ErrConflict)
	}
	for i, file := range files {
		blob, err := verifiedRunBlobTx(ctx, tx, realm, runID, manifest.Files[i])
		if err != nil || blob.Text != file.Text {
			return ErrConflict
		}
	}
	return nil
}

type RepositoryPublication struct {
	ID                     string                    `json:"id"`
	ManifestDigest         string                    `json:"manifest_digest"`
	Repository             string                    `json:"repository"`
	BaseCommit             string                    `json:"base_commit"`
	BaseBranch             string                    `json:"base_branch"`
	Changes                []domain.RepositoryChange `json:"changes"`
	Status                 string                    `json:"status"`
	URL                    string                    `json:"url,omitempty"`
	Reconciliation         string                    `json:"reconciliation,omitempty"`
	ReconciliationReason   string                    `json:"reconciliation_reason,omitempty"`
	ReconciliationRevision int64                     `json:"reconciliation_revision"`
	CheckedAt              *time.Time                `json:"checked_at,omitempty"`
}

// The host receives exact immutable bytes only after all independent reads,
// heterogeneous verdict, current task generation and caller grants are proven.
func (s *Store) AuthorizeRepositoryPublication(ctx context.Context, realm, taskID, runID, actor string, admin bool) (RepositoryPublication, error) {
	var out RepositoryPublication
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	var state string
	if err = tx.QueryRow(ctx, `SELECT COALESCE(business_state,'') FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, taskID).Scan(&state); err != nil {
		return out, err
	}
	if state == domain.BusinessRejected || state == domain.BusinessArchived {
		return out, ErrConflict
	}
	if err = authorizeArtifactWrite(ctx, tx, realm, taskID, actor, admin); err != nil {
		return out, err
	}
	gate, err := requireRunReviewTx(ctx, tx, realm, taskID)
	if err != nil {
		return out, err
	}
	if gate["producer_run_id"] != runID || gate["scope"] != domain.ClosedRepositoryOutputProfile {
		return out, ErrConflict
	}
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT digest,manifest FROM governance_run_output_manifests WHERE realm=$1 AND run_id=$2`, realm, runID).Scan(&out.ManifestDigest, &raw); err != nil {
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
		file, err := verifiedRunBlobTx(ctx, tx, realm, runID, entry)
		if err != nil {
			return out, err
		}
		var change domain.RepositoryChange
		if err = json.Unmarshal([]byte(file.Text), &change); err != nil {
			return out, err
		}
		out.Changes = append(out.Changes, change)
	}
	err = tx.QueryRow(ctx, `INSERT INTO governance_repository_publications(realm,task_id,run_id,manifest_digest,actor)VALUES($1,$2,$3,$4,$5)ON CONFLICT(realm,run_id,manifest_digest)DO NOTHING RETURNING id::text,status,url`, realm, taskID, runID, out.ManifestDigest, actor).Scan(&out.ID, &out.Status, &out.URL)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, fmt.Errorf("%w: publication already started; inspect its recorded outcome", ErrConflict)
	}
	if err != nil {
		return out, err
	}
	detail, _ := json.Marshal(map[string]any{"publication_id": out.ID, "manifest_digest": out.ManifestDigest, "repository": out.Repository, "base_commit": out.BaseCommit})
	if err = insertTaskAudit(ctx, tx, taskID, "repository_publication_authorized", actor, detail); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *Store) CompleteRepositoryPublication(ctx context.Context, realm, taskID, runID, id, digest, url, actor string, admin bool) error {
	if len(url) > 2048 || !taskArtifactHash.MatchString(digest) || !repositoryPublicationID.MatchString(id) {
		return ErrBadRequest
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var task string
	if err = tx.QueryRow(ctx, `SELECT COALESCE(business_state,'') FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, taskID).Scan(&task); err != nil {
		return err
	}
	if err = authorizeArtifactWrite(ctx, tx, realm, taskID, actor, admin); err != nil {
		return err
	}
	if task == domain.BusinessRejected || task == domain.BusinessArchived {
		return ErrConflict
	}
	if _, err = repositoryReconciliationPermitTx(ctx, tx, realm, taskID, runID, actor); err != nil {
		return err
	}
	var issuer string
	if err = tx.QueryRow(ctx, `SELECT actor FROM governance_repository_publications WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND id=$4::uuid AND manifest_digest=$5 FOR UPDATE`, realm, taskID, runID, id, digest).Scan(&issuer); err != nil {
		return err
	}
	if issuer != actor {
		return ErrForbidden
	}
	snapshot, err := repositorySnapshotTx(ctx, tx, realm, runID)
	if err != nil {
		return err
	}
	prefix := "https://github.com/" + snapshot.Repository + "/pull/"
	if !strings.HasPrefix(url, prefix) || !repositoryPullNumber.MatchString(strings.TrimPrefix(url, prefix)) {
		return ErrBadRequest
	}
	tag, err := tx.Exec(ctx, `UPDATE governance_repository_publications SET status='draft',url=$6,published_at=COALESCE(published_at,now()),reconciliation_revision=reconciliation_revision+1 WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND id=$4::uuid AND manifest_digest=$5 AND (status='publishing' OR (status='draft' AND url=$6))`, realm, taskID, runID, id, digest, url)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrConflict
	}
	detail, _ := json.Marshal(map[string]any{"publication_id": id, "manifest_digest": digest, "url": url})
	if err = insertTaskAudit(ctx, tx, taskID, "repository_draft_reported", actor, detail); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// A permit must be atomically consumed before the first external operation.
// publishing never expires back to pending: an interrupted/ambiguous provider
// response requires explicit reconciliation, never an automatic second writer.
func (s *Store) ClaimRepositoryPublication(ctx context.Context, realm, taskID, runID, id, digest, actor string, admin bool) (RepositoryPublication, error) {
	var out RepositoryPublication
	if !repositoryPublicationID.MatchString(id) || !taskArtifactHash.MatchString(digest) {
		return out, ErrBadRequest
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	var task string
	if err = tx.QueryRow(ctx, `SELECT COALESCE(business_state,'') FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, taskID).Scan(&task); err != nil {
		return out, err
	}
	if task == domain.BusinessRejected || task == domain.BusinessArchived {
		return out, ErrConflict
	}
	if err = authorizeArtifactWrite(ctx, tx, realm, taskID, actor, admin); err != nil {
		return out, err
	}
	gate, err := requireRunReviewTx(ctx, tx, realm, taskID)
	if err != nil {
		return out, err
	}
	if gate["producer_run_id"] != runID || gate["scope"] != domain.ClosedRepositoryOutputProfile || gate["manifest_digest"] != digest {
		return out, ErrConflict
	}
	if err = tx.QueryRow(ctx, `UPDATE governance_repository_publications SET status='publishing' WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND id=$4::uuid AND manifest_digest=$5 AND actor=$6 AND status='pending' RETURNING id::text,status`, realm, taskID, runID, id, digest, actor).Scan(&out.ID, &out.Status); errors.Is(err, pgx.ErrNoRows) {
		return out, fmt.Errorf("%w: publication permit already consumed or unavailable; reconcile its recorded outcome", ErrConflict)
	} else if err != nil {
		return out, err
	}
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT digest,manifest FROM governance_run_output_manifests WHERE realm=$1 AND run_id=$2`, realm, runID).Scan(&out.ManifestDigest, &raw); err != nil {
		return out, err
	}
	var manifest domain.RunOutputManifest
	if err = json.Unmarshal(raw, &manifest); err != nil {
		return out, err
	}
	if manifest.Repository == nil || out.ManifestDigest != digest {
		return out, ErrConflict
	}
	out.Repository = manifest.Repository.Repository
	out.BaseCommit = manifest.Repository.BaseCommit
	out.BaseBranch = manifest.Repository.BaseBranch
	for _, entry := range manifest.Files {
		file, err := verifiedRunBlobTx(ctx, tx, realm, runID, entry)
		if err != nil {
			return out, err
		}
		var change domain.RepositoryChange
		if err = json.Unmarshal([]byte(file.Text), &change); err != nil {
			return out, err
		}
		out.Changes = append(out.Changes, change)
	}
	detail, _ := json.Marshal(map[string]any{"publication_id": id, "manifest_digest": digest})
	if err = insertTaskAudit(ctx, tx, taskID, "repository_publication_claimed", actor, detail); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

var repositoryPublicationID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var repositoryPullNumber = regexp.MustCompile(`^[1-9][0-9]*$`)

func repositoryManifestDigest(manifest domain.RunOutputManifest) string {
	raw, _ := json.Marshal(manifest)
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}
