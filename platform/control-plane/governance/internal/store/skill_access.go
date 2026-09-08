package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

type SkillAccess struct {
	Grants      []domain.SkillGrant      `json:"grants"`
	Revocations []domain.SkillRevocation `json:"revocations"`
}

func (s *Store) SkillAccess(ctx context.Context, realm, skillID string) (SkillAccess, error) {
	result := SkillAccess{Grants: []domain.SkillGrant{}, Revocations: []domain.SkillRevocation{}}
	if _, err := s.GetSkill(ctx, realm, skillID); err != nil {
		return result, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id,realm,skill_id,version_constraint,subject_type,subject_id,include_children,expires_at,granted_by
		FROM governance_skill_grants WHERE realm=$1 AND skill_id=$2 ORDER BY subject_type,subject_id,id`, realm, skillID)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var grant domain.SkillGrant
		if err = rows.Scan(&grant.ID, &grant.Realm, &grant.SkillID, &grant.VersionConstraint, &grant.SubjectType, &grant.SubjectID, &grant.IncludeChildren, &grant.ExpiresAt, &grant.GrantedBy); err != nil {
			rows.Close()
			return result, err
		}
		result.Grants = append(result.Grants, grant)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = s.pool.Query(ctx, `SELECT id,realm,skill_id,subject_type,subject_id,reason,expires_at,revoked_by
		FROM governance_skill_revocations WHERE realm=$1 AND skill_id=$2 ORDER BY subject_type,subject_id,id`, realm, skillID)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var revocation domain.SkillRevocation
		if err := rows.Scan(&revocation.ID, &revocation.Realm, &revocation.SkillID, &revocation.SubjectType, &revocation.SubjectID, &revocation.Reason, &revocation.ExpiresAt, &revocation.RevokedBy); err != nil {
			return result, err
		}
		result.Revocations = append(result.Revocations, revocation)
	}
	return result, rows.Err()
}

func checkSkillSubject(ctx context.Context, tx pgx.Tx, realm string, subjectType domain.SubjectType, subjectID string, expiresAt *time.Time) error {
	if !managedID.MatchString(subjectID) || !subjectType.Valid() || (expiresAt != nil && !expiresAt.After(time.Now())) {
		return fmt.Errorf("%w: invalid skill subject or expiration", ErrBadRequest)
	}
	var query string
	switch subjectType {
	case domain.SubjectUser:
		query = `SELECT EXISTS(SELECT 1 FROM governance_users WHERE realm=$1 AND id=$2 AND status='active')`
	case domain.SubjectRole:
		query = `SELECT EXISTS(SELECT 1 FROM governance_roles WHERE realm=$1 AND id=$2 AND status='active')`
	case domain.SubjectDepartment:
		query = `SELECT EXISTS(SELECT 1 FROM governance_departments WHERE realm=$1 AND id=$2 AND status='active')`
	case domain.SubjectAgent:
		query = `SELECT EXISTS(SELECT 1 FROM governance_agent_presets WHERE realm=$1 AND id=$2 AND status='active')`
	case domain.SubjectProject:
		query = `SELECT EXISTS(SELECT 1 FROM projects WHERE realm=$1 AND id=$2 AND status='active')`
	}
	var exists bool
	if err := tx.QueryRow(ctx, query, realm, subjectID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%w: skill subject must be active in this realm", ErrBadRequest)
	}
	return nil
}

func (s *Store) DeleteSkillAccess(ctx context.Context, realm, skillID, resource, id, actor string) error {
	var statement string
	switch resource {
	case "grants":
		statement = `DELETE FROM governance_skill_grants WHERE realm=$1 AND skill_id=$2 AND id=$3`
	case "revocations":
		statement = `DELETE FROM governance_skill_revocations WHERE realm=$1 AND skill_id=$2 AND id=$3`
	default:
		return ErrBadRequest
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, statement, realm, skillID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err = recordUserAdminEvent(ctx, tx, realm, actor, "skill_access_updated", actor, map[string]any{"skill_id": skillID, "resource": resource, "removed_id": id}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
