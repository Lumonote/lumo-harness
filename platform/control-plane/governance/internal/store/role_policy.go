package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

var ErrRolePolicyUnavailable = errors.New("role policy unavailable")
var ErrRolePolicyChanged = errors.New("role policy changed")

type rolePolicyQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func readRolePolicyCatalog(ctx context.Context, q rolePolicyQuerier, realm string) ([]domain.RolePolicyFact, error) {
	rows, err := q.Query(ctx, `SELECT r.id,COALESCE(r.parent_role_id,''),r.status,r.permission_revision,
 COALESCE(jsonb_agg(jsonb_build_object('action',p.action,'effect',p.effect) ORDER BY p.action) FILTER(WHERE p.action IS NOT NULL),'[]'::jsonb)
 FROM governance_roles r LEFT JOIN governance_role_permissions p ON p.realm=r.realm AND p.role_id=r.id
 WHERE r.realm=$1 GROUP BY r.id,r.parent_role_id,r.status,r.permission_revision ORDER BY r.id`, realm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []domain.RolePolicyFact{}
	for rows.Next() {
		var role domain.RolePolicyFact
		var raw []byte
		if err := rows.Scan(&role.RoleID, &role.ParentRoleID, &role.Status, &role.Revision, &raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &role.Permissions); err != nil {
			return nil, err
		}
		result = append(result, role)
	}
	return result, rows.Err()
}

func (s *Store) ResolveRoles(ctx context.Context, realm string, direct []string) (domain.RoleResolution, error) {
	catalog, err := readRolePolicyCatalog(ctx, s.pool, realm)
	if err != nil {
		return domain.RoleResolution{}, fmt.Errorf("%w: read role facts", ErrRolePolicyUnavailable)
	}
	result, err := domain.ResolveRolePolicy(direct, catalog)
	if err != nil {
		return domain.RoleResolution{}, fmt.Errorf("%w: invalid role facts", ErrRolePolicyUnavailable)
	}
	return result, nil
}

type RolePolicyState struct {
	domain.RolePolicyFact
	Resolution domain.RoleResolution `json:"resolution"`
}

func rolePolicyState(id string, catalog []domain.RolePolicyFact) (RolePolicyState, error) {
	for _, fact := range catalog {
		if fact.RoleID == id {
			resolution, err := domain.ResolveRolePolicy([]string{id}, catalog)
			if err != nil {
				return RolePolicyState{}, fmt.Errorf("%w: invalid role facts", ErrRolePolicyUnavailable)
			}
			return RolePolicyState{fact, resolution}, nil
		}
	}
	return RolePolicyState{}, ErrNotFound
}

func (s *Store) RolePolicy(ctx context.Context, realm, id string) (RolePolicyState, error) {
	catalog, err := readRolePolicyCatalog(ctx, s.pool, realm)
	if err != nil {
		return RolePolicyState{}, err
	}
	return rolePolicyState(id, catalog)
}

// Inherit is represented by the absence of a row. This is the only editable
// permission fact source; OPA receives the resolved facts, never another grant DB.
func (s *Store) SetRolePermissions(ctx context.Context, realm, id, actor string, expectedRevision int64, permissions []domain.RolePermission) (RolePolicyState, error) {
	if expectedRevision < 1 || !managedID.MatchString(id) {
		return RolePolicyState{}, ErrBadRequest
	}
	seen := map[domain.PermissionAction]bool{}
	for _, rule := range permissions {
		if !domain.SupportedPermissionAction(rule.Action) || seen[rule.Action] || (rule.Effect != "allow" && rule.Effect != "deny" && rule.Effect != "inherit") {
			return RolePolicyState{}, ErrBadRequest
		}
		seen[rule.Action] = true
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return RolePolicyState{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := requireCurrentRolePolicyAdmin(ctx, tx, realm, actor); err != nil {
		return RolePolicyState{}, err
	}
	catalog, err := readRolePolicyCatalog(ctx, tx, realm)
	if err != nil {
		return RolePolicyState{}, err
	}
	before, err := rolePolicyState(id, catalog)
	if err != nil {
		return RolePolicyState{}, err
	}
	if before.Revision != expectedRevision {
		return RolePolicyState{}, ErrRolePolicyChanged
	}
	if _, err = tx.Exec(ctx, `DELETE FROM governance_role_permissions WHERE realm=$1 AND role_id=$2`, realm, id); err != nil {
		return RolePolicyState{}, err
	}
	for _, rule := range permissions {
		if rule.Effect == "inherit" {
			continue
		}
		if _, err = tx.Exec(ctx, `INSERT INTO governance_role_permissions(realm,role_id,action,effect) VALUES($1,$2,$3,$4)`, realm, id, rule.Action, rule.Effect); err != nil {
			return RolePolicyState{}, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_roles SET permission_revision=permission_revision+1 WHERE realm=$1 AND id=$2`, realm, id); err != nil {
		return RolePolicyState{}, err
	}
	return finishRolePolicyChange(ctx, tx, realm, id, actor, "role_permissions_updated", before)
}

func (s *Store) SetRoleParent(ctx context.Context, realm, id, parent, actor string, expectedRevision int64) (RolePolicyState, error) {
	if expectedRevision < 1 || !managedID.MatchString(id) || (parent != "" && !managedID.MatchString(parent)) {
		return RolePolicyState{}, ErrBadRequest
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return RolePolicyState{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := requireCurrentRolePolicyAdmin(ctx, tx, realm, actor); err != nil {
		return RolePolicyState{}, err
	}
	catalog, err := readRolePolicyCatalog(ctx, tx, realm)
	if err != nil {
		return RolePolicyState{}, err
	}
	before, err := rolePolicyState(id, catalog)
	if err != nil {
		return RolePolicyState{}, err
	}
	if before.Revision != expectedRevision {
		return RolePolicyState{}, ErrRolePolicyChanged
	}
	foundParent := parent == ""
	for i, fact := range catalog {
		if fact.RoleID == parent && fact.Status == "active" {
			foundParent = true
		}
		if fact.RoleID == id {
			catalog[i].ParentRoleID = parent
		}
	}
	if !foundParent {
		return RolePolicyState{}, fmt.Errorf("%w: parent role must be active in this realm", ErrBadRequest)
	}
	if err = domain.ValidateRoleHierarchy(catalog); err != nil {
		return RolePolicyState{}, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_roles SET parent_role_id=NULLIF($3,''),permission_revision=permission_revision+1 WHERE realm=$1 AND id=$2`, realm, id, parent); err != nil {
		return RolePolicyState{}, err
	}
	return finishRolePolicyChange(ctx, tx, realm, id, actor, "role_parent_updated", before)
}

// Revalidate only direct, current administrator grants after taking the same
// Realm lock as user/role mutations. A trusted request header can become stale
// while reading a body or waiting for a lock; inherited names are never admin.
func requireCurrentRolePolicyAdmin(ctx context.Context, tx pgx.Tx, realm, actor string) error {
	var allowed bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_users u
 JOIN governance_user_roles ur ON ur.realm=u.realm AND ur.user_id=u.id
 JOIN governance_roles r ON r.realm=ur.realm AND r.id=ur.role_id
 WHERE u.realm=$1 AND u.id=$2 AND u.status='active' AND r.status='active'
 AND r.id IN ('platform_admin','realm_admin','admin')
 AND (ur.expires_at IS NULL OR ur.expires_at>clock_timestamp()))`, realm, actor).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrForbidden
	}
	return nil
}

func finishRolePolicyChange(ctx context.Context, tx pgx.Tx, realm, id, actor, event string, before RolePolicyState) (RolePolicyState, error) {
	catalog, err := readRolePolicyCatalog(ctx, tx, realm)
	if err != nil {
		return RolePolicyState{}, err
	}
	after, err := rolePolicyState(id, catalog)
	if err != nil {
		return RolePolicyState{}, err
	}
	if err = recordUserAdminEvent(ctx, tx, realm, actor, event, actor, map[string]any{"role_id": id, "revision": after.Revision, "before": before.RolePolicyFact, "after": after.RolePolicyFact}); err != nil {
		return RolePolicyState{}, err
	}
	return after, tx.Commit(ctx)
}

// The project itself supplies Realm and lifecycle facts. Membership alone is
// insufficient: IDs are not caller assertions and administrator bypass applies
// only to membership inside an existing active project of the same Realm.
func (s *Store) PermissionProjectAccess(ctx context.Context, realm, projectID, userID string, directAdmin bool) (bool, error) {
	var allowed bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects p WHERE p.id=$1 AND p.realm=$2 AND p.status='active'
 AND ($4::boolean OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$3)))`, projectID, realm, userID, directAdmin).Scan(&allowed)
	if isUndefinedTable(err) {
		return false, nil
	}
	return allowed, err
}
