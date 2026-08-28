// Package store persists Cluster-only governance state. The tables are owned
// by this service; Registry bytes, project membership, and Scheduler node
// placement remain owned by their existing services.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

const DDL = `
CREATE TABLE IF NOT EXISTS governance_users (
  realm             TEXT NOT NULL,
  id                TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  primary_dept_id   TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','disabled')),
  source            TEXT NOT NULL DEFAULT 'local',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, id)
);

CREATE TABLE IF NOT EXISTS governance_departments (
  realm             TEXT NOT NULL,
  id                TEXT NOT NULL,
  parent_dept_id    TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL,
  manager_user_id   TEXT NOT NULL DEFAULT '',
  path              TEXT NOT NULL,
  level             INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  PRIMARY KEY (realm, id),
  UNIQUE (realm, parent_dept_id, name)
);
CREATE INDEX IF NOT EXISTS governance_departments_path_idx ON governance_departments (realm, path);

CREATE TABLE IF NOT EXISTS governance_roles (
  realm             TEXT NOT NULL,
  id                TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  PRIMARY KEY (realm, id),
  UNIQUE (realm, name)
);
CREATE TABLE IF NOT EXISTS governance_user_roles (
  realm             TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  role_id           TEXT NOT NULL,
  expires_at        TIMESTAMPTZ,
  granted_by        TEXT NOT NULL,
  PRIMARY KEY (realm, user_id, role_id)
);

CREATE TABLE IF NOT EXISTS governance_skills (
  realm             TEXT NOT NULL,
  id                TEXT NOT NULL,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('prompt','workflow','tool','connector')),
  visibility        TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','project','department','global')),
  current_version   TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, id),
  UNIQUE (realm, name)
);

CREATE TABLE IF NOT EXISTS governance_skill_grants (
  id                TEXT PRIMARY KEY,
  realm             TEXT NOT NULL,
  skill_id          TEXT NOT NULL,
  version_constraint TEXT NOT NULL DEFAULT '',
  subject_type      TEXT NOT NULL CHECK (subject_type IN ('user','role','department','project','agent')),
  subject_id        TEXT NOT NULL,
  include_children  BOOLEAN NOT NULL DEFAULT false,
  expires_at        TIMESTAMPTZ,
  granted_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS governance_skill_grants_lookup_idx
  ON governance_skill_grants (realm, skill_id, subject_type, subject_id);

CREATE TABLE IF NOT EXISTS governance_skill_revocations (
  id                TEXT PRIMARY KEY,
  realm             TEXT NOT NULL,
  skill_id          TEXT NOT NULL,
  subject_type      TEXT NOT NULL CHECK (subject_type IN ('user','role','department','project','agent')),
  subject_id        TEXT NOT NULL,
  reason            TEXT NOT NULL DEFAULT '',
  expires_at        TIMESTAMPTZ,
  revoked_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS governance_skill_revocations_lookup_idx
  ON governance_skill_revocations (realm, skill_id, subject_type, subject_id);

CREATE TABLE IF NOT EXISTS governance_desktop_nodes (
  realm             TEXT NOT NULL,
  id                TEXT NOT NULL,
  cluster_id        TEXT NOT NULL,
  owner_user_id     TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  os                TEXT NOT NULL,
  arch              TEXT NOT NULL,
  client_version    TEXT NOT NULL,
  capacity          INTEGER NOT NULL CHECK (capacity >= 1),
  capabilities      JSONB NOT NULL DEFAULT '[]'::jsonb,
  residency         TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL CHECK (status IN ('PENDING_ACTIVATION','ONLINE','DRAINING','OFFLINE','REVOKED')),
  scheduling_eligible BOOLEAN NOT NULL DEFAULT false,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, id)
);
CREATE INDEX IF NOT EXISTS governance_desktop_nodes_realm_owner_idx
  ON governance_desktop_nodes (realm, owner_user_id, last_seen_at DESC);
`

var (
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("already exists")
	ErrForbidden  = errors.New("forbidden")
	ErrBadRequest = errors.New("bad request")
)

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Init(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, DDL); err != nil {
		return fmt.Errorf("initialize governance schema: %w", err)
	}
	return nil
}

func (s *Store) UpsertUser(ctx context.Context, user domain.User) (domain.User, error) {
	if user.ID == "" || user.Realm == "" || user.DisplayName == "" {
		return domain.User{}, fmt.Errorf("%w: user id, realm, and display name are required", ErrBadRequest)
	}
	if user.Status == "" {
		user.Status = "active"
	}
	if user.Source == "" {
		user.Source = "local"
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO governance_users (realm, id, display_name, primary_dept_id, status, source)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (realm,id) DO UPDATE SET
		  display_name = EXCLUDED.display_name, primary_dept_id = EXCLUDED.primary_dept_id,
		  status = EXCLUDED.status, source = EXCLUDED.source, updated_at = now()
		RETURNING created_at, updated_at`,
		user.Realm, user.ID, user.DisplayName, user.PrimaryDeptID, user.Status, user.Source,
	).Scan(&user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return domain.User{}, fmt.Errorf("upsert user: %w", err)
	}
	return user, nil
}

func (s *Store) CreateDepartment(ctx context.Context, department domain.Department) (domain.Department, error) {
	if department.ID == "" || department.Realm == "" || department.Name == "" {
		return domain.Department{}, fmt.Errorf("%w: department id, realm, and name are required", ErrBadRequest)
	}
	if department.Status == "" {
		department.Status = "active"
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Department{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	parentPath := "/"
	department.Level = 0
	if department.ParentDeptID != "" {
		var parentLevel int
		err = tx.QueryRow(ctx, `SELECT path, level FROM governance_departments WHERE realm=$1 AND id=$2`, department.Realm, department.ParentDeptID).Scan(&parentPath, &parentLevel)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Department{}, ErrNotFound
		}
		if err != nil {
			return domain.Department{}, fmt.Errorf("load parent department: %w", err)
		}
		department.Level = parentLevel + 1
	}
	department.Path = parentPath + department.ID + "/"
	_, err = tx.Exec(ctx, `
		INSERT INTO governance_departments (realm,id,parent_dept_id,name,manager_user_id,path,level,status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		department.Realm, department.ID, department.ParentDeptID, department.Name, department.ManagerUserID,
		department.Path, department.Level, department.Status)
	if isUniqueViolation(err) {
		return domain.Department{}, ErrConflict
	}
	if err != nil {
		return domain.Department{}, fmt.Errorf("create department: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Department{}, err
	}
	return department, nil
}

func (s *Store) ListDepartments(ctx context.Context, realm string) ([]domain.Department, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, realm, parent_dept_id, name, manager_user_id, path, level, status
		FROM governance_departments WHERE realm=$1 ORDER BY path`, realm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Department{}
	for rows.Next() {
		var d domain.Department
		if err := rows.Scan(&d.ID, &d.Realm, &d.ParentDeptID, &d.Name, &d.ManagerUserID, &d.Path, &d.Level, &d.Status); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) CreateRole(ctx context.Context, role domain.Role) (domain.Role, error) {
	if role.ID == "" || role.Realm == "" || role.Name == "" {
		return domain.Role{}, fmt.Errorf("%w: role id, realm, and name are required", ErrBadRequest)
	}
	if role.Status == "" {
		role.Status = "active"
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO governance_roles (realm,id,name,description,status) VALUES ($1,$2,$3,$4,$5)`,
		role.Realm, role.ID, role.Name, role.Description, role.Status)
	if isUniqueViolation(err) {
		return domain.Role{}, ErrConflict
	}
	if err != nil {
		return domain.Role{}, err
	}
	return role, nil
}

func (s *Store) ListRoles(ctx context.Context, realm string) ([]domain.Role, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, realm, name, description, status FROM governance_roles WHERE realm=$1 ORDER BY name`, realm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Role{}
	for rows.Next() {
		var role domain.Role
		if err := rows.Scan(&role.ID, &role.Realm, &role.Name, &role.Description, &role.Status); err != nil {
			return nil, err
		}
		out = append(out, role)
	}
	return out, rows.Err()
}

func (s *Store) AssignRole(ctx context.Context, realm, userID, roleID, grantedBy string, expiresAt *time.Time) error {
	if !s.userExists(ctx, realm, userID) || !s.roleExists(ctx, realm, roleID) {
		return ErrNotFound
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO governance_user_roles (realm,user_id,role_id,expires_at,granted_by)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (realm,user_id,role_id) DO UPDATE SET expires_at=EXCLUDED.expires_at, granted_by=EXCLUDED.granted_by`,
		realm, userID, roleID, expiresAt, grantedBy)
	return err
}

func (s *Store) CreateSkill(ctx context.Context, skill domain.Skill) (domain.Skill, error) {
	if skill.ID == "" || skill.Realm == "" || skill.Name == "" || !skill.Kind.Valid() || skill.CreatedBy == "" {
		return domain.Skill{}, fmt.Errorf("%w: invalid skill", ErrBadRequest)
	}
	if skill.Visibility == "" {
		skill.Visibility = "private"
	}
	if skill.CurrentVersion == "" {
		skill.CurrentVersion = "1.0.0"
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO governance_skills (realm,id,name,kind,visibility,current_version,created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING created_at`,
		skill.Realm, skill.ID, skill.Name, skill.Kind, skill.Visibility, skill.CurrentVersion, skill.CreatedBy,
	).Scan(&skill.CreatedAt)
	if isUniqueViolation(err) {
		return domain.Skill{}, ErrConflict
	}
	if err != nil {
		return domain.Skill{}, err
	}
	return skill, nil
}

func (s *Store) ListSkills(ctx context.Context, realm string) ([]domain.Skill, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, realm, name, kind, visibility, current_version, created_by, created_at
		FROM governance_skills WHERE realm=$1 ORDER BY name`, realm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Skill{}
	for rows.Next() {
		var skill domain.Skill
		if err := rows.Scan(&skill.ID, &skill.Realm, &skill.Name, &skill.Kind, &skill.Visibility, &skill.CurrentVersion, &skill.CreatedBy, &skill.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, skill)
	}
	return out, rows.Err()
}

func (s *Store) GrantSkill(ctx context.Context, grant domain.SkillGrant) error {
	if grant.ID == "" || grant.Realm == "" || grant.SkillID == "" || !grant.SubjectType.Valid() || grant.SubjectID == "" || grant.GrantedBy == "" {
		return fmt.Errorf("%w: invalid skill grant", ErrBadRequest)
	}
	if !s.skillExists(ctx, grant.Realm, grant.SkillID) {
		return ErrNotFound
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO governance_skill_grants (id,realm,skill_id,version_constraint,subject_type,subject_id,include_children,expires_at,granted_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		grant.ID, grant.Realm, grant.SkillID, grant.VersionConstraint, grant.SubjectType, grant.SubjectID,
		grant.IncludeChildren, grant.ExpiresAt, grant.GrantedBy)
	if isUniqueViolation(err) {
		return ErrConflict
	}
	return err
}

func (s *Store) RevokeSkill(ctx context.Context, revocation domain.SkillRevocation) error {
	if revocation.ID == "" || revocation.Realm == "" || revocation.SkillID == "" || !revocation.SubjectType.Valid() || revocation.SubjectID == "" || revocation.RevokedBy == "" {
		return fmt.Errorf("%w: invalid skill revocation", ErrBadRequest)
	}
	if !s.skillExists(ctx, revocation.Realm, revocation.SkillID) {
		return ErrNotFound
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO governance_skill_revocations (id,realm,skill_id,subject_type,subject_id,reason,expires_at,revoked_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		revocation.ID, revocation.Realm, revocation.SkillID, revocation.SubjectType, revocation.SubjectID,
		revocation.Reason, revocation.ExpiresAt, revocation.RevokedBy)
	if isUniqueViolation(err) {
		return ErrConflict
	}
	return err
}

// EffectiveSkills computes the documented precedence from the persisted
// organization snapshot. Project grants only match a real project member; if
// projects is not initialized yet, they are safely ignored rather than trusted
// solely because a caller supplied a project id.
func (s *Store) EffectiveSkills(ctx context.Context, realm, userID, projectID string) ([]domain.EffectiveSkill, error) {
	var primaryDeptID string
	err := s.pool.QueryRow(ctx, `SELECT primary_dept_id FROM governance_users WHERE realm=$1 AND id=$2`, realm, userID).Scan(&primaryDeptID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	roles, err := s.roleIDs(ctx, realm, userID)
	if err != nil {
		return nil, err
	}
	deptAncestors, err := s.departmentAncestors(ctx, realm, primaryDeptID)
	if err != nil {
		return nil, err
	}
	projectMember, err := s.projectMember(ctx, projectID, userID)
	if err != nil {
		return nil, err
	}
	revoked, err := s.userRevocations(ctx, realm, userID)
	if err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT g.skill_id, g.version_constraint, g.subject_type, g.subject_id, g.include_children,
		       sk.id, sk.realm, sk.name, sk.kind, sk.visibility, sk.current_version, sk.created_by, sk.created_at
		FROM governance_skill_grants g
		JOIN governance_skills sk ON sk.realm=g.realm AND sk.id=g.skill_id
		WHERE g.realm=$1 AND (g.expires_at IS NULL OR g.expires_at > now())`, realm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := []domain.Candidate{}
	for rows.Next() {
		var (
			skillID, version, subjectID string
			subjectType                 domain.SubjectType
			includeChildren             bool
			skill                       domain.Skill
		)
		if err := rows.Scan(&skillID, &version, &subjectType, &subjectID, &includeChildren,
			&skill.ID, &skill.Realm, &skill.Name, &skill.Kind, &skill.Visibility, &skill.CurrentVersion, &skill.CreatedBy, &skill.CreatedAt); err != nil {
			return nil, err
		}
		priority, source, ok := matchesGrant(subjectType, subjectID, includeChildren, userID, projectID, projectMember, primaryDeptID, roles, deptAncestors)
		if !ok {
			continue
		}
		candidates = append(candidates, domain.Candidate{Skill: skill, Version: version, Source: source, Priority: priority})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return domain.ResolveEffectiveSkills(candidates, revoked)
}

func matchesGrant(subjectType domain.SubjectType, subjectID string, includeChildren bool, userID, projectID string, projectMember bool, primaryDeptID string, roles, ancestors map[string]bool) (int, string, bool) {
	switch subjectType {
	case domain.SubjectUser:
		return domain.PriorityUser, "user:" + subjectID, subjectID == userID
	case domain.SubjectProject:
		return domain.PriorityProject, "project:" + subjectID, projectMember && subjectID == projectID
	case domain.SubjectRole:
		return domain.PriorityRole, "role:" + subjectID, roles[subjectID]
	case domain.SubjectDepartment:
		if subjectID == primaryDeptID {
			return domain.PriorityDepartment, "department:" + subjectID, true
		}
		return domain.PriorityInheritedDepartment, "department:" + subjectID, includeChildren && ancestors[subjectID]
	default:
		return 0, "", false
	}
}

func (s *Store) RegisterDesktopNode(ctx context.Context, node domain.DesktopNode) (domain.DesktopNode, error) {
	if node.ID == "" || node.Realm == "" || node.ClusterID == "" || node.OwnerUserID == "" || node.DisplayName == "" || node.OS == "" || node.Arch == "" || node.Capacity < 1 {
		return domain.DesktopNode{}, fmt.Errorf("%w: invalid desktop node", ErrBadRequest)
	}
	if !s.userExists(ctx, node.Realm, node.OwnerUserID) {
		return domain.DesktopNode{}, ErrNotFound
	}
	if node.ClientVersion == "" {
		node.ClientVersion = "unknown"
	}
	node.Status = domain.NodeOnline
	// Registration deliberately does not mark a desktop device schedulable. The
	// subsequent mTLS command channel and Provisioner digest report are the two
	// missing proofs before Scheduler may use it.
	node.SchedulingEligible = false
	capabilities, err := json.Marshal(node.Capabilities)
	if err != nil {
		return domain.DesktopNode{}, err
	}
	err = s.pool.QueryRow(ctx, `
		INSERT INTO governance_desktop_nodes (realm,id,cluster_id,owner_user_id,display_name,os,arch,client_version,capacity,capabilities,residency,status,scheduling_eligible)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (realm,id) DO UPDATE SET
		  cluster_id=EXCLUDED.cluster_id, owner_user_id=EXCLUDED.owner_user_id, display_name=EXCLUDED.display_name,
		  os=EXCLUDED.os, arch=EXCLUDED.arch, client_version=EXCLUDED.client_version, capacity=EXCLUDED.capacity,
		  capabilities=EXCLUDED.capabilities, residency=EXCLUDED.residency, status='ONLINE',
		  scheduling_eligible=false, last_seen_at=now()
		RETURNING last_seen_at`,
		node.Realm, node.ID, node.ClusterID, node.OwnerUserID, node.DisplayName, node.OS, node.Arch, node.ClientVersion,
		node.Capacity, capabilities, node.Residency, node.Status, node.SchedulingEligible,
	).Scan(&node.LastSeenAt)
	if err != nil {
		return domain.DesktopNode{}, err
	}
	return node, nil
}

func (s *Store) HeartbeatDesktopNode(ctx context.Context, realm, nodeID, ownerUserID string) (domain.DesktopNode, error) {
	var node domain.DesktopNode
	var capabilities []byte
	err := s.pool.QueryRow(ctx, `
		UPDATE governance_desktop_nodes
		SET last_seen_at=now(), status=CASE WHEN status='REVOKED' THEN status ELSE 'ONLINE' END
		WHERE realm=$1 AND id=$2 AND owner_user_id=$3
		RETURNING id,realm,cluster_id,owner_user_id,display_name,os,arch,client_version,capacity,capabilities,residency,status,scheduling_eligible,last_seen_at`,
		realm, nodeID, ownerUserID).Scan(
		&node.ID, &node.Realm, &node.ClusterID, &node.OwnerUserID, &node.DisplayName, &node.OS, &node.Arch,
		&node.ClientVersion, &node.Capacity, &capabilities, &node.Residency, &node.Status, &node.SchedulingEligible, &node.LastSeenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DesktopNode{}, ErrNotFound
	}
	if err != nil {
		return domain.DesktopNode{}, err
	}
	if err := json.Unmarshal(capabilities, &node.Capabilities); err != nil {
		return domain.DesktopNode{}, err
	}
	return node, nil
}

func (s *Store) ListDesktopNodes(ctx context.Context, realm, ownerUserID string, all bool) ([]domain.DesktopNode, error) {
	query := `
		SELECT id,realm,cluster_id,owner_user_id,display_name,os,arch,client_version,capacity,capabilities,residency,
		       CASE WHEN status='ONLINE' AND last_seen_at < now() - interval '30 seconds' THEN 'OFFLINE' ELSE status END,
		       scheduling_eligible,last_seen_at
		FROM governance_desktop_nodes WHERE realm=$1`
	args := []any{realm}
	if !all {
		query += ` AND owner_user_id=$2`
		args = append(args, ownerUserID)
	}
	query += ` ORDER BY last_seen_at DESC`
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.DesktopNode{}
	for rows.Next() {
		var node domain.DesktopNode
		var capabilities []byte
		if err := rows.Scan(&node.ID, &node.Realm, &node.ClusterID, &node.OwnerUserID, &node.DisplayName, &node.OS, &node.Arch,
			&node.ClientVersion, &node.Capacity, &capabilities, &node.Residency, &node.Status, &node.SchedulingEligible, &node.LastSeenAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(capabilities, &node.Capabilities); err != nil {
			return nil, err
		}
		out = append(out, node)
	}
	return out, rows.Err()
}

func (s *Store) userExists(ctx context.Context, realm, id string) bool {
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM governance_users WHERE realm=$1 AND id=$2)`, realm, id).Scan(&exists); err != nil {
		return false
	}
	return exists
}

func (s *Store) roleExists(ctx context.Context, realm, id string) bool {
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM governance_roles WHERE realm=$1 AND id=$2)`, realm, id).Scan(&exists); err != nil {
		return false
	}
	return exists
}

func (s *Store) skillExists(ctx context.Context, realm, id string) bool {
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM governance_skills WHERE realm=$1 AND id=$2)`, realm, id).Scan(&exists); err != nil {
		return false
	}
	return exists
}

func (s *Store) roleIDs(ctx context.Context, realm, userID string) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT role_id FROM governance_user_roles
		WHERE realm=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at > now())`, realm, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var roleID string
		if err := rows.Scan(&roleID); err != nil {
			return nil, err
		}
		out[roleID] = true
	}
	return out, rows.Err()
}

func (s *Store) departmentAncestors(ctx context.Context, realm, primaryDeptID string) (map[string]bool, error) {
	if primaryDeptID == "" {
		return map[string]bool{}, nil
	}
	var path string
	err := s.pool.QueryRow(ctx, `SELECT path FROM governance_departments WHERE realm=$1 AND id=$2`, realm, primaryDeptID).Scan(&path)
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]bool{}, nil
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id FROM governance_departments WHERE realm=$1 AND $2 LIKE path || '%'`, realm, path)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func (s *Store) projectMember(ctx context.Context, projectID, userID string) (bool, error) {
	if projectID == "" {
		return false, nil
	}
	var member bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2)`, projectID, userID).Scan(&member)
	if isUndefinedTable(err) {
		return false, nil
	}
	return member, err
}

func (s *Store) userRevocations(ctx context.Context, realm, userID string) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT skill_id FROM governance_skill_revocations
		WHERE realm=$1 AND subject_type='user' AND subject_id=$2 AND (expires_at IS NULL OR expires_at > now())`, realm, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

// NormalizeRoles parses the gateway header once; exported for the HTTP layer
// and tests so role separators never become another authorization dialect.
func NormalizeRoles(header string) map[string]bool {
	out := map[string]bool{}
	for _, role := range strings.Split(header, ",") {
		if role = strings.TrimSpace(role); role != "" {
			out[role] = true
		}
	}
	return out
}
