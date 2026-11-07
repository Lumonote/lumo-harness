package store

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
)

var (
	ErrSpaceGrantConflict   = errors.New("space grant revision changed")
	ErrSpaceGrantForbidden  = errors.New("active project owner required")
	ErrSpaceGrantBadRequest = errors.New("invalid space grant")
)

type SpaceGrant struct {
	UserID      string   `json:"user_id"`
	Permissions []string `json:"permissions"`
	Revision    int64    `json:"revision"`
}

// lockManagedSpace reads Projects-owned facts without writing them. The same
// parent lock serializes grants with owner removal, archival and Space detach.
// Collaborator remains the only writer of its grant and grant-audit tables.
func lockManagedSpace(ctx context.Context, tx pgx.Tx, realm, projectID, spaceID, actor string, writable bool) error {
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM projects WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, projectID).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSpaceGrantForbidden
		}
		return err
	}
	if (status != "active" && status != "archived") || (writable && status != "active") {
		return ErrSpaceGrantForbidden
	}
	var actorStatus string
	if err := tx.QueryRow(ctx, `SELECT status FROM governance_users WHERE realm=$1 AND id=$2 FOR SHARE`, realm, actor).Scan(&actorStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSpaceGrantForbidden
		}
		return err
	}
	if actorStatus != "active" {
		return ErrSpaceGrantForbidden
	}
	var allowed bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM project_spaces ps
	 JOIN project_members pm ON pm.project_id=ps.project_id AND pm.user_id=$4 AND pm.role='owner'
	 JOIN governance_users u ON u.realm=ps.realm AND u.id=pm.user_id AND u.status='active'
	 WHERE ps.realm=$1 AND ps.project_id=$2 AND ps.space_id=$3)`, realm, projectID, spaceID, actor).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrSpaceGrantForbidden
	}
	return nil
}

func (s *Store) ListSpaceGrants(ctx context.Context, realm, projectID, spaceID, actor string) ([]SpaceGrant, error) {
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = lockManagedSpace(ctx, tx, realm, projectID, spaceID, actor, false); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT g.subject,
	 CASE WHEN g.project_id=$3 AND g.space_incarnation=ps.incarnation THEN g.permissions ELSE '{}'::text[] END,g.revision
	 FROM collab_space_grants g JOIN project_spaces ps ON ps.realm=g.realm AND ps.space_id=g.space AND ps.project_id=$3
	 WHERE g.realm=$1 AND g.space=$2 ORDER BY g.subject`, realm, spaceID, projectID)
	if err != nil {
		return nil, err
	}
	grants := []SpaceGrant{}
	for rows.Next() {
		var g SpaceGrant
		if err = rows.Scan(&g.UserID, &g.Permissions, &g.Revision); err != nil {
			rows.Close()
			return nil, err
		}
		grants = append(grants, g)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return grants, nil
}

func (s *Store) SetSpaceGrant(ctx context.Context, realm, projectID, spaceID, actor, subject string, permissions []string, expected int64) (SpaceGrant, error) {
	var result SpaceGrant
	if expected < 0 || subject == "" || len(subject) > 256 || permissions == nil || len(permissions) > 4 {
		return result, ErrSpaceGrantBadRequest
	}
	seen := map[string]bool{}
	for _, p := range permissions {
		if seen[p] || (p != "read" && p != "edit" && p != "comment" && p != "publish") {
			return result, ErrSpaceGrantBadRequest
		}
		seen[p] = true
	}
	permissions = append([]string{}, permissions...)
	sort.Strings(permissions)
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	if err = lockManagedSpace(ctx, tx, realm, projectID, spaceID, actor, true); err != nil {
		return result, err
	}
	var incarnation string
	if err = tx.QueryRow(ctx, `SELECT incarnation::text FROM project_spaces WHERE realm=$1 AND project_id=$2 AND space_id=$3`, realm, projectID, spaceID).Scan(&incarnation); err != nil {
		return result, err
	}
	if len(permissions) > 0 {
		var targetStatus string
		if err = tx.QueryRow(ctx, `SELECT status FROM governance_users WHERE realm=$1 AND id=$2 FOR SHARE`, realm, subject).Scan(&targetStatus); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return result, ErrSpaceGrantBadRequest
			}
			return result, err
		}
		if targetStatus != "active" {
			return result, ErrSpaceGrantBadRequest
		}
		var eligible bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_users u JOIN project_members pm ON pm.user_id=u.id AND pm.project_id=$3 WHERE u.realm=$1 AND u.id=$2 AND u.status='active')`, realm, subject, projectID).Scan(&eligible); err != nil {
			return result, err
		}
		if !eligible {
			return result, fmt.Errorf("%w: recipient must be an active project member in this realm", ErrSpaceGrantBadRequest)
		}
	}
	var current int64
	err = tx.QueryRow(ctx, `SELECT revision FROM collab_space_grants WHERE realm=$1 AND space=$2 AND subject=$3 FOR UPDATE`, realm, spaceID, subject).Scan(&current)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	if current != expected {
		return result, ErrSpaceGrantConflict
	}
	result = SpaceGrant{UserID: subject, Permissions: permissions, Revision: current + 1}
	if _, err = tx.Exec(ctx, `INSERT INTO collab_space_grants(realm,space,subject,permissions,revision,project_id,space_incarnation) VALUES($1,$2,$3,$4,$5,$6,$7::uuid)
	 ON CONFLICT(realm,space,subject) DO UPDATE SET permissions=EXCLUDED.permissions,revision=EXCLUDED.revision,project_id=EXCLUDED.project_id,space_incarnation=EXCLUDED.space_incarnation`, realm, spaceID, subject, permissions, result.Revision, projectID, incarnation); err != nil {
		return SpaceGrant{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO collab_space_grant_audit(realm,space,subject,revision,project_id,actor_user_id,permissions,space_incarnation) VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid)`, realm, spaceID, subject, result.Revision, projectID, actor, permissions, incarnation); err != nil {
		return SpaceGrant{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return SpaceGrant{}, err
	}
	return result, nil
}
