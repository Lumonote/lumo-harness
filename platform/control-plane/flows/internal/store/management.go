package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/flows/internal/domain"
)

var ErrEditConflict = errors.New("flow changed; reload before saving")
var ErrManagementForbidden = errors.New("flow change is not permitted")

const managementDDL = `CREATE TABLE IF NOT EXISTS flow_change_drafts (
  flow_id TEXT PRIMARY KEY REFERENCES flows(id),
  id TEXT NOT NULL,
  realm TEXT NOT NULL,
  author TEXT NOT NULL,
  base_version INT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  definition JSONB NOT NULL,
  review_comment TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`

type FlowChangeDraft struct {
	ID            string          `json:"id"`
	Author        string          `json:"author"`
	BaseVersion   int             `json:"baseVersion"`
	Revision      int64           `json:"revision"`
	Status        string          `json:"status"`
	Definition    json.RawMessage `json:"-"`
	ReviewComment string          `json:"reviewComment,omitempty"`
}

type FlowChangeCommand struct {
	ID         string
	Command    string
	Revision   int64
	Definition json.RawMessage
	Approve    bool
	Comment    string
}

func (s *Store) FlowChangeDraft(ctx context.Context, id, realm, userID string, reviewer bool) (*FlowChangeDraft, error) {
	var draft FlowChangeDraft
	err := s.pool.QueryRow(ctx, `SELECT id,author,base_version,revision,status,definition,review_comment FROM flow_change_drafts
		WHERE flow_id=$1 AND realm=$2 AND (author=$3 OR (status='submitted' AND $4))`, id, realm, userID, reviewer).
		Scan(&draft.ID, &draft.Author, &draft.BaseVersion, &draft.Revision, &draft.Status, &draft.Definition, &draft.ReviewComment)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &draft, err
}

// A version change never moves the published flow back to draft. Publication
// and rollback share the parent row lock, so the reviewed base cannot move.
func (s *Store) ApplyFlowChange(ctx context.Context, id, realm, userID string, reviewer bool, command FlowChangeCommand) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status, author, role string
	var version int
	err = tx.QueryRow(ctx, `SELECT f.status,f.author,f.version,m.role FROM flows f
		JOIN projects p ON p.id=f.project_id AND p.realm=f.realm AND p.status='active'
		JOIN project_members m ON m.project_id=p.id AND m.user_id=$3
		WHERE f.id=$1 AND f.realm=$2 FOR UPDATE OF f`, id, realm, userID).Scan(&status, &author, &version, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrManagementForbidden
	}
	if err != nil {
		return err
	}
	if status != domain.StatusPublished && status != domain.StatusTargeted {
		return ErrEditConflict
	}
	if command.Command == "review" {
		if !reviewer || author == userID {
			return ErrManagementForbidden
		}
	} else if author != userID || (role != domain.RoleOwner && role != domain.RoleEditor) {
		return ErrManagementForbidden
	}
	if command.Command == "create" {
		tag, err := tx.Exec(ctx, `INSERT INTO flow_change_drafts (flow_id,id,realm,author,base_version,definition)
			SELECT f.id,$2,f.realm,f.author,f.version,v.definition FROM flows f
			JOIN flow_versions v ON v.flow_id=f.id AND v.version=f.version
			WHERE f.id=$1 ON CONFLICT (flow_id) DO NOTHING`, id, command.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrEditConflict
		}
		return tx.Commit(ctx)
	}
	var draft FlowChangeDraft
	err = tx.QueryRow(ctx, `SELECT id,author,base_version,revision,status,definition,review_comment FROM flow_change_drafts WHERE flow_id=$1`, id).
		Scan(&draft.ID, &draft.Author, &draft.BaseVersion, &draft.Revision, &draft.Status, &draft.Definition, &draft.ReviewComment)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrEditConflict
	}
	if err != nil {
		return err
	}
	if command.ID != draft.ID || command.Revision < 1 || command.Revision != draft.Revision {
		return ErrEditConflict
	}
	switch command.Command {
	case "save":
		if draft.Status != domain.StatusDraft {
			return ErrOnlyDraft
		}
		_, err = tx.Exec(ctx, `UPDATE flow_change_drafts SET definition=$2,revision=revision+1,updated_at=clock_timestamp() WHERE flow_id=$1`, id, command.Definition)
	case "submit":
		if draft.Status != domain.StatusDraft || draft.BaseVersion != version {
			return ErrEditConflict
		}
		_, err = tx.Exec(ctx, `UPDATE flow_change_drafts SET status='submitted',review_comment='',revision=revision+1,updated_at=clock_timestamp() WHERE flow_id=$1`, id)
	case "discard":
		_, err = tx.Exec(ctx, `DELETE FROM flow_change_drafts WHERE flow_id=$1`, id)
	case "review":
		if draft.Status != domain.StatusSubmitted || (command.Approve && draft.BaseVersion != version) {
			return ErrEditConflict
		}
		decision := "reject"
		if command.Approve {
			decision = "approve"
			var nextVersion int
			if err = tx.QueryRow(ctx, `SELECT COALESCE(max(version),0)+1 FROM flow_versions WHERE flow_id=$1`, id).Scan(&nextVersion); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO flow_versions (flow_id,version,definition,reviewer) VALUES ($1,$2,$3,$4)`, id, nextVersion, draft.Definition, userID); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `UPDATE flows SET version=$2,definition=$3,review_comment=NULL,published_at=now(),updated_at=clock_timestamp() WHERE id=$1`, id, nextVersion, draft.Definition); err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `DELETE FROM flow_change_drafts WHERE flow_id=$1`, id)
		} else {
			_, err = tx.Exec(ctx, `UPDATE flow_change_drafts SET status='draft',review_comment=$2,revision=revision+1,updated_at=clock_timestamp() WHERE flow_id=$1`, id, command.Comment)
		}
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO flow_reviews (flow_id,reviewer,decision,comment) VALUES ($1,$2,$3,$4)`, id, userID, decision, command.Comment)
	default:
		return ErrManagementForbidden
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ManagementProjectRole(ctx context.Context, projectID, realm, userID string) (string, bool, error) {
	var role string
	var active bool
	err := s.pool.QueryRow(ctx, `SELECT m.role,p.status='active' FROM project_members m
		JOIN projects p ON p.id=m.project_id WHERE p.id=$1 AND p.realm=$2 AND m.user_id=$3`, projectID, realm, userID).Scan(&role, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, ErrNotFound
	}
	return role, active, err
}

func (s *Store) ManagedChangeStates(ctx context.Context, projectID, realm, userID string, reviewer bool) (map[string]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT d.flow_id,d.status FROM flow_change_drafts d JOIN flows f ON f.id=d.flow_id
		WHERE f.project_id=$1 AND f.realm=$2 AND (d.author=$3 OR (d.status='submitted' AND $4))`, projectID, realm, userID, reviewer)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	states := map[string]string{}
	for rows.Next() {
		var id, status string
		if err := rows.Scan(&id, &status); err != nil {
			return nil, err
		}
		states[id] = status
	}
	return states, rows.Err()
}

func (s *Store) ListManagedFlows(ctx context.Context, projectID, realm, userID string, reviewer bool) ([]*domain.Flow, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+flowCols+` FROM flows
		WHERE project_id=$1 AND realm=$2 AND
		(author=$3 OR status NOT IN ('draft','submitted') OR (status='submitted' AND $4))
		ORDER BY updated_at DESC,id`, projectID, realm, userID, reviewer)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	flows := []*domain.Flow{}
	for rows.Next() {
		flow, err := scanFlow(rows)
		if err != nil {
			return nil, err
		}
		flows = append(flows, flow)
	}
	return flows, rows.Err()
}

func (s *Store) ManagedDefinition(ctx context.Context, id, realm, userID string, reviewer bool) (json.RawMessage, error) {
	var definition json.RawMessage
	err := s.pool.QueryRow(ctx, `SELECT CASE WHEN f.status IN ('draft','submitted') OR f.version=0
		THEN f.definition ELSE v.definition END
		FROM flows f LEFT JOIN flow_versions v ON v.flow_id=f.id AND v.version=f.version
		WHERE f.id=$1 AND f.realm=$2 AND
		(f.author=$3 OR f.status NOT IN ('draft','submitted') OR (f.status='submitted' AND $4))`, id, realm, userID, reviewer).Scan(&definition)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return definition, err
}

func (s *Store) UpdateManagedDraft(ctx context.Context, id, realm, author, name string, expected time.Time, definition json.RawMessage) (*domain.Flow, error) {
	flow, err := scanFlow(s.pool.QueryRow(ctx, `UPDATE flows SET name=$4,definition=$5,updated_at=clock_timestamp()
		WHERE id=$1 AND realm=$2 AND author=$3 AND status='draft' AND updated_at=$6
		AND EXISTS(SELECT 1 FROM projects p JOIN project_members m ON m.project_id=p.id
		WHERE p.id=flows.project_id AND p.realm=$2 AND p.status='active' AND m.user_id=$3 AND m.role IN ('owner','editor'))
		RETURNING `+flowCols, id, realm, author, name, definition, expected))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrEditConflict
	}
	if isUniqueViolation(err) {
		return nil, ErrNameTaken
	}
	return flow, err
}
