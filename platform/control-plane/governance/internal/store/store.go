// Package store persists Cluster-only governance state. The tables are owned
// by this service; Registry bytes, project membership, and Scheduler node
// placement remain owned by their existing services.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
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

CREATE TABLE IF NOT EXISTS governance_user_tags (
  realm       TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  tag         TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'local',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, user_id, tag),
  FOREIGN KEY (realm, user_id) REFERENCES governance_users(realm, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS governance_user_tags_lookup_idx ON governance_user_tags (realm, tag, user_id);

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

-- First-party Web authentication belongs to the same user authority. Raw
-- passwords and browser session tokens are never persisted: bcrypt and
-- SHA-256 projections are the only stored forms.
CREATE TABLE IF NOT EXISTS governance_auth_credentials (
  realm             TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  username          TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT true,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, user_id),
  UNIQUE (realm, username),
  FOREIGN KEY (realm, user_id) REFERENCES governance_users(realm, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS governance_auth_sessions (
  token_hash        TEXT PRIMARY KEY,
  realm             TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  client_ip         TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (realm, user_id) REFERENCES governance_users(realm, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS governance_auth_sessions_expiry_idx ON governance_auth_sessions (expires_at);
CREATE TABLE IF NOT EXISTS governance_auth_captchas (
  id                TEXT PRIMARY KEY,
  answer_hash       TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS governance_auth_captchas_expiry_idx ON governance_auth_captchas (expires_at);
CREATE TABLE IF NOT EXISTS governance_auth_failures (
  realm             TEXT NOT NULL,
  username          TEXT NOT NULL,
  client_ip         TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  locked_until      TIMESTAMPTZ,
  touched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, username, client_ip)
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
ALTER TABLE governance_skills ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

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

CREATE TABLE IF NOT EXISTS governance_delegation_tasks (
  id                TEXT PRIMARY KEY,
  realm             TEXT NOT NULL,
  title             TEXT NOT NULL,
  intent            TEXT NOT NULL,
  project_id        TEXT NOT NULL DEFAULT '',
  requester_user_id TEXT NOT NULL,
  assignee_user_id  TEXT NOT NULL,
  required_tags     JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_skills   JSONB NOT NULL DEFAULT '[]'::jsonb,
  inferred_tags     JSONB NOT NULL DEFAULT '[]'::jsonb,
  inferred_skills   JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_skills   JSONB NOT NULL DEFAULT '[]'::jsonb,
  state             TEXT NOT NULL CHECK (state IN ('ASSIGNED','QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','BLOCKED')),
  match_score       INTEGER NOT NULL DEFAULT 0,
  rationale         JSONB NOT NULL DEFAULT '[]'::jsonb,
  scheduler_task_id TEXT NOT NULL DEFAULT '',
  assigned_node_id  TEXT NOT NULL DEFAULT '',
  last_error        TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS governance_delegation_tasks_realm_updated_idx
  ON governance_delegation_tasks (realm, updated_at DESC);
CREATE INDEX IF NOT EXISTS governance_delegation_tasks_assignee_idx
  ON governance_delegation_tasks (realm, assignee_user_id, state, updated_at DESC);

-- §23：旧任务允许 business_state NULL；NULL 表示 legacy，不伪造历史业务态。
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS business_state TEXT
  CHECK (business_state IS NULL OR business_state IN ('DRAFT','ROUTING','ASSIGNED','EXECUTING','VERIFYING','IN_REVIEW','DONE','REJECTED','ARCHIVED'));
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS confidence_band TEXT
  CHECK (confidence_band IS NULL OR confidence_band IN ('AUTO','SUGGESTED','MANUAL'));
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS assignee_worker_id TEXT;
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS score_breakdown JSONB;
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS score_weights JSONB;
CREATE INDEX IF NOT EXISTS governance_delegation_tasks_worker_idx
  ON governance_delegation_tasks (realm, assignee_worker_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS governance_task_runs (
  id                TEXT PRIMARY KEY,
  realm             TEXT NOT NULL,
  task_id           TEXT NOT NULL REFERENCES governance_delegation_tasks(id) ON DELETE CASCADE,
  attempt           INTEGER NOT NULL CHECK (attempt >= 1),
  worker_id         TEXT NOT NULL,
  session_ref       TEXT NOT NULL DEFAULT '',
  scheduler_task_id TEXT NOT NULL DEFAULT '',
  assigned_node_id  TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL CHECK (state IN ('ASSIGNED','QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','BLOCKED')),
  failure_kind      TEXT,
  last_error        TEXT NOT NULL DEFAULT '',
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt)
);
CREATE INDEX IF NOT EXISTS governance_task_runs_task_idx ON governance_task_runs (realm, task_id, attempt DESC);
CREATE INDEX IF NOT EXISTS governance_task_runs_worker_idx ON governance_task_runs (realm, worker_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS governance_skill_proficiency (
  realm       TEXT NOT NULL,
  worker_id   TEXT NOT NULL,
  skill_id    TEXT NOT NULL,
  level       INTEGER NOT NULL CHECK (level BETWEEN 0 AND 5),
  confidence  NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source      TEXT NOT NULL CHECK (source IN ('outcome','eval','self')),
  evidence_n  INTEGER NOT NULL DEFAULT 0 CHECK (evidence_n >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, worker_id, skill_id, source)
);
CREATE INDEX IF NOT EXISTS governance_skill_proficiency_worker_idx
  ON governance_skill_proficiency (realm, worker_id, skill_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS governance_worker_runtime (
  realm            TEXT NOT NULL,
  worker_id        TEXT NOT NULL,
  max_concurrency  INTEGER NOT NULL CHECK (max_concurrency >= 1),
  trust_level      TEXT NOT NULL DEFAULT 'unknown',
  residency        TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','draining','disabled')),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, worker_id)
);

CREATE TABLE IF NOT EXISTS governance_dispatch_outcomes (
  id          TEXT PRIMARY KEY,
  realm       TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES governance_delegation_tasks(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES governance_task_runs(id) ON DELETE CASCADE,
  worker_id   TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ACCEPTED','REASSIGNED','REWORKED','REJECTED','FIRST_PASS')),
  reason      TEXT CHECK (reason IS NULL OR reason IN ('SKILL_MISMATCH','OVERLOADED','ERROR','OTHER')),
  notes       TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS governance_dispatch_outcomes_task_idx
  ON governance_dispatch_outcomes (realm, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS governance_task_audit (
  id          TEXT PRIMARY KEY,
  realm       TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES governance_delegation_tasks(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  actor       TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS governance_task_audit_task_idx
  ON governance_task_audit (realm, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_reports (
  id          TEXT PRIMARY KEY,
  realm       TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES governance_delegation_tasks(id) ON DELETE CASCADE,
  run_id      TEXT,
  sections    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','archived')),
  created_by  TEXT NOT NULL,
  confirmed_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE task_reports ADD COLUMN IF NOT EXISTS confirmed_by TEXT;
CREATE INDEX IF NOT EXISTS task_reports_pending_idx ON task_reports (realm, updated_at DESC) WHERE status = 'draft';
`

var (
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("already exists")
	ErrForbidden  = errors.New("forbidden")
	ErrBadRequest = errors.New("bad request")
	ErrLegacyTask = errors.New("legacy task has no business state; materialize a run before transition")
)

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Init(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin governance schema initialization: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Multiple control-plane replicas may start together. The transaction lock
	// serializes CREATE/ALTER visibility so one replica never observes a half
	// upgraded §23 schema while another is still applying it.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(823023)`); err != nil {
		return fmt.Errorf("lock governance schema initialization: %w", err)
	}
	if _, err := tx.Exec(ctx, DDL); err != nil {
		return fmt.Errorf("initialize governance schema: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit governance schema initialization: %w", err)
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
	if !validUserStatus(user.Status) {
		return domain.User{}, fmt.Errorf("%w: invalid user status", ErrBadRequest)
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

func (s *Store) ListUsers(ctx context.Context, realm, query string) ([]domain.User, error) {
	needle := "%" + strings.TrimSpace(query) + "%"
	rows, err := s.pool.Query(ctx, `
		SELECT id, realm, display_name, primary_dept_id, status, source, created_at, updated_at
		FROM governance_users
		WHERE realm=$1 AND ($2='' OR id ILIKE $3 OR display_name ILIKE $3)
		ORDER BY display_name, id LIMIT 200`, realm, strings.TrimSpace(query), needle)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []domain.User{}
	for rows.Next() {
		var user domain.User
		if err := rows.Scan(&user.ID, &user.Realm, &user.DisplayName, &user.PrimaryDeptID, &user.Status, &user.Source, &user.CreatedAt, &user.UpdatedAt); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (s *Store) ListUserTags(ctx context.Context, realm, userID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT tag FROM governance_user_tags WHERE realm=$1 AND user_id=$2 ORDER BY tag`, realm, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tags []string
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}

func (s *Store) ReplaceUserTags(ctx context.Context, realm, userID string, tags []string) ([]string, error) {
	if !s.userExists(ctx, realm, userID) {
		return nil, ErrNotFound
	}
	clean := make([]string, 0, len(tags))
	seen := map[string]bool{}
	for _, raw := range tags {
		tag := strings.TrimSpace(raw)
		if tag == "" || len([]rune(tag)) > 64 {
			return nil, fmt.Errorf("%w: tag must be 1-64 characters", ErrBadRequest)
		}
		key := strings.ToLower(tag)
		if seen[key] {
			continue
		}
		seen[key] = true
		clean = append(clean, tag)
	}
	sort.Strings(clean)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM governance_user_tags WHERE realm=$1 AND user_id=$2`, realm, userID); err != nil {
		return nil, err
	}
	for _, tag := range clean {
		if _, err := tx.Exec(ctx, `INSERT INTO governance_user_tags (realm,user_id,tag,source) VALUES ($1,$2,$3,'local')`, realm, userID, tag); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return clean, nil
}

func (s *Store) ListUserProfiles(ctx context.Context, realm, projectID, query string) ([]domain.UserProfile, error) {
	users, err := s.ListUsers(ctx, realm, query)
	if err != nil {
		return nil, err
	}
	profiles := make([]domain.UserProfile, 0, len(users))
	for _, user := range users {
		tags, err := s.ListUserTags(ctx, realm, user.ID)
		if err != nil {
			return nil, err
		}
		skills, err := s.EffectiveSkills(ctx, realm, user.ID, projectID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				continue
			}
			return nil, err
		}
		var active int
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_delegation_tasks WHERE realm=$1 AND assignee_user_id=$2 AND state IN ('ASSIGNED','QUEUED','RUNNING')`, realm, user.ID).Scan(&active); err != nil {
			return nil, err
		}
		confidence, quality, err := s.workerStats(ctx, realm, "user:"+user.ID)
		if err != nil {
			return nil, err
		}
		profiles = append(profiles, domain.UserProfile{
			User: user, WorkerID: "user:" + user.ID, WorkerKind: domain.WorkerHuman,
			Tags: tags, Skills: skills, ActiveTasks: active, Confidence: confidence, Quality: quality,
		})
	}
	return profiles, nil
}

// ListWorkerProfiles merges human users with agent preset references found in
// runtime rows or agent grants. It is a read model, not a fourth worker
// registry; absent agent runtime metadata is an explicit cold-start profile.
func (s *Store) ListWorkerProfiles(ctx context.Context, realm, projectID, query string) ([]domain.UserProfile, error) {
	humans, err := s.ListUserProfiles(ctx, realm, projectID, query)
	if err != nil {
		return nil, err
	}
	out := append([]domain.UserProfile(nil), humans...)
	rows, err := s.pool.Query(ctx, `
		SELECT worker_id FROM governance_worker_runtime WHERE realm=$1 AND worker_id LIKE 'agent:%'
		UNION
		SELECT 'agent:' || subject_id FROM governance_skill_grants WHERE realm=$1 AND subject_type='agent'
		ORDER BY worker_id`, realm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var workerID string
		if err := rows.Scan(&workerID); err != nil {
			return nil, err
		}
		var maxConcurrency int
		var trustLevel, residency, status string
		if err := s.pool.QueryRow(ctx, `SELECT max_concurrency,trust_level,residency,status FROM governance_worker_runtime WHERE realm=$1 AND worker_id=$2`, realm, workerID).Scan(&maxConcurrency, &trustLevel, &residency, &status); errors.Is(err, pgx.ErrNoRows) {
			maxConcurrency, trustLevel, status = 1, "unknown", "active"
		} else if err != nil {
			return nil, err
		}
		workerRef := strings.TrimPrefix(workerID, "agent:")
		if query != "" && !strings.Contains(strings.ToLower(workerRef), strings.ToLower(query)) {
			continue
		}
		skills, err := s.EffectiveSkillsForWorker(ctx, realm, workerID, projectID)
		if err != nil {
			return nil, err
		}
		active, err := s.activeRunsForWorker(ctx, realm, workerID)
		if err != nil {
			return nil, err
		}
		confidence, quality, err := s.workerStats(ctx, realm, workerID)
		if err != nil {
			return nil, err
		}
		load := 0.0
		if maxConcurrency > 0 {
			load = float64(active) / float64(maxConcurrency)
		}
		if load > 1 {
			load = 1
		}
		out = append(out, domain.UserProfile{
			WorkerID: workerID, WorkerKind: domain.WorkerAgent, DisplayName: workerRef, Status: status,
			Skills: skills, ActiveTasks: active, Load: load, MaxConcurrency: maxConcurrency,
			Confidence: confidence, Quality: quality, TrustLevel: trustLevel, Residency: residency,
		})
	}
	return out, rows.Err()
}

func (s *Store) GetWorkerProfile(ctx context.Context, realm, workerID, projectID string) (domain.WorkerProfile, error) {
	profiles, err := s.ListWorkerProfiles(ctx, realm, projectID, "")
	if err != nil {
		return domain.WorkerProfile{}, err
	}
	for _, p := range profiles {
		if p.WorkerID != workerID {
			continue
		}
		return domain.WorkerProfile{
			WorkerID: p.WorkerID, WorkerKind: p.WorkerKind, DisplayName: p.DisplayName, Status: p.Status,
			Skills: p.Skills, ActiveTasks: p.ActiveTasks, Load: p.Load, MaxConcurrency: p.MaxConcurrency,
			Confidence: p.Confidence, Quality: p.Quality, CostNorm: p.CostNorm,
			TrustLevel: p.TrustLevel, Residency: p.Residency, Eligible: p.Status == "active" && p.Load <= 0.8,
		}, nil
	}
	return domain.WorkerProfile{}, ErrNotFound
}

func (s *Store) UpsertWorkerRuntime(ctx context.Context, realm string, runtime domain.WorkerProfile) error {
	if runtime.WorkerID == "" || runtime.WorkerKind != domain.WorkerAgent || runtime.MaxConcurrency < 1 || runtime.Status == "" {
		return fmt.Errorf("%w: invalid worker runtime", ErrBadRequest)
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO governance_worker_runtime (realm,worker_id,max_concurrency,trust_level,residency,status)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (realm,worker_id) DO UPDATE SET max_concurrency=EXCLUDED.max_concurrency,trust_level=EXCLUDED.trust_level,residency=EXCLUDED.residency,status=EXCLUDED.status,updated_at=now()`,
		realm, runtime.WorkerID, runtime.MaxConcurrency, runtime.TrustLevel, runtime.Residency, runtime.Status)
	return err
}

func (s *Store) activeRunsForWorker(ctx context.Context, realm, workerID string) (int, error) {
	var active int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_runs WHERE realm=$1 AND worker_id=$2 AND state IN ('ASSIGNED','QUEUED','RUNNING','BLOCKED')`, realm, workerID).Scan(&active)
	return active, err
}

func (s *Store) workerStats(ctx context.Context, realm, workerID string) (float64, float64, error) {
	var count int
	var quality *float64
	err := s.pool.QueryRow(ctx, `
		SELECT count(*), avg(CASE WHEN outcome IN ('ACCEPTED','FIRST_PASS') THEN 1.0 ELSE 0.0 END)
		FROM governance_dispatch_outcomes WHERE realm=$1 AND worker_id=$2`, realm, workerID).Scan(&count, &quality)
	if err != nil {
		return 0, 0, err
	}
	if quality == nil {
		return 0, 0.5, nil
	}
	confidence := float64(count) / 5
	if confidence > 1 {
		confidence = 1
	}
	return confidence, *quality, nil
}

func (s *Store) CreateDepartment(ctx context.Context, department domain.Department) (domain.Department, error) {
	if department.ID == "" || department.Realm == "" || department.Name == "" {
		return domain.Department{}, fmt.Errorf("%w: department id, realm, and name are required", ErrBadRequest)
	}
	if department.Status == "" {
		department.Status = "active"
	}
	if !validOrgStatus(department.Status) {
		return domain.Department{}, fmt.Errorf("%w: invalid department status", ErrBadRequest)
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
	if !validOrgStatus(role.Status) {
		return domain.Role{}, fmt.Errorf("%w: invalid role status", ErrBadRequest)
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
	if !validSkillVisibility(skill.Visibility) {
		return domain.Skill{}, fmt.Errorf("%w: invalid skill visibility", ErrBadRequest)
	}
	if skill.CurrentVersion == "" {
		skill.CurrentVersion = "1.0.0"
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO governance_skills (realm,id,name,kind,visibility,current_version,created_by,description)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`,
		skill.Realm, skill.ID, skill.Name, skill.Kind, skill.Visibility, skill.CurrentVersion, skill.CreatedBy, skill.Description,
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
		SELECT id, realm, name, kind, visibility, current_version, created_by, description, created_at
		FROM governance_skills WHERE realm=$1 ORDER BY name`, realm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Skill{}
	for rows.Next() {
		var skill domain.Skill
		if err := rows.Scan(&skill.ID, &skill.Realm, &skill.Name, &skill.Kind, &skill.Visibility, &skill.CurrentVersion, &skill.CreatedBy, &skill.Description, &skill.CreatedAt); err != nil {
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

// EffectiveSkills keeps the existing user-facing API while routing through the
// unified worker resolver. Agent callers must use the worker-id form so an
// agent grant can no longer disappear in a default branch.
func (s *Store) EffectiveSkills(ctx context.Context, realm, userID, projectID string) ([]domain.EffectiveSkill, error) {
	return s.EffectiveSkillsForWorker(ctx, realm, "user:"+userID, projectID)
}

// EffectiveSkillsForWorker applies the same grant precedence to Human and
// Agent workers. `user:<id>` and `agent:<preset-ref>` are the only accepted
// stable worker identity forms.
func (s *Store) EffectiveSkillsForWorker(ctx context.Context, realm, workerID, projectID string) ([]domain.EffectiveSkill, error) {
	workerKind, workerRef := splitWorkerID(workerID)
	if workerKind == domain.WorkerHuman && workerRef == "" {
		return nil, fmt.Errorf("%w: invalid human worker id", ErrBadRequest)
	}
	var primaryDeptID string
	var userID string
	if workerKind == domain.WorkerHuman {
		userID = workerRef
		err := s.pool.QueryRow(ctx, `SELECT primary_dept_id FROM governance_users WHERE realm=$1 AND id=$2`, realm, userID).Scan(&primaryDeptID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
	} else if workerKind != domain.WorkerAgent || workerRef == "" {
		return nil, fmt.Errorf("%w: invalid worker id", ErrBadRequest)
	}

	roles := map[string]bool{}
	var err error
	if userID != "" {
		roles, err = s.roleIDs(ctx, realm, userID)
		if err != nil {
			return nil, err
		}
	}
	deptAncestors, err := s.departmentAncestors(ctx, realm, primaryDeptID)
	if err != nil {
		return nil, err
	}
	projectMember := false
	if userID != "" {
		projectMember, err = s.projectMember(ctx, projectID, userID)
		if err != nil {
			return nil, err
		}
	}
	revoked, err := s.matchingRevocationsForWorker(ctx, realm, workerID, userID, projectID, projectMember, primaryDeptID, roles, deptAncestors)
	if err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT g.skill_id, g.version_constraint, g.subject_type, g.subject_id, g.include_children,
		       sk.id, sk.realm, sk.name, sk.kind, sk.visibility, sk.current_version, sk.created_by, sk.description, sk.created_at
		FROM governance_skill_grants g
		JOIN governance_skills sk ON sk.realm=g.realm AND sk.id=g.skill_id
		WHERE g.realm=$1 AND (g.expires_at IS NULL OR g.expires_at > now())`, realm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := []domain.Candidate{}
	for rows.Next() {
		var skillID, version, subjectID string
		var subjectType domain.SubjectType
		var includeChildren bool
		var skill domain.Skill
		if err := rows.Scan(&skillID, &version, &subjectType, &subjectID, &includeChildren,
			&skill.ID, &skill.Realm, &skill.Name, &skill.Kind, &skill.Visibility, &skill.CurrentVersion, &skill.CreatedBy, &skill.Description, &skill.CreatedAt); err != nil {
			return nil, err
		}
		priority, source, ok := matchesGrantForWorker(subjectType, subjectID, includeChildren, workerID, userID, projectID, projectMember, primaryDeptID, roles, deptAncestors)
		if ok {
			candidates = append(candidates, domain.Candidate{Skill: skill, Version: version, Source: source, Priority: priority})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	resolved, err := domain.ResolveEffectiveSkills(candidates, revoked)
	if err != nil {
		return nil, err
	}
	return s.decorateProficiency(ctx, realm, workerID, resolved)
}

func splitWorkerID(workerID string) (string, string) {
	if kind, ref, ok := strings.Cut(strings.TrimSpace(workerID), ":"); ok {
		return kind, ref
	}
	return domain.WorkerHuman, strings.TrimSpace(workerID)
}

func matchesGrant(subjectType domain.SubjectType, subjectID string, includeChildren bool, userID, projectID string, projectMember bool, primaryDeptID string, roles, ancestors map[string]bool) (int, string, bool) {
	return matchesGrantForWorker(subjectType, subjectID, includeChildren, "user:"+userID, userID, projectID, projectMember, primaryDeptID, roles, ancestors)
}

func matchesGrantForWorker(subjectType domain.SubjectType, subjectID string, includeChildren bool, workerID, userID, projectID string, projectMember bool, primaryDeptID string, roles, ancestors map[string]bool) (int, string, bool) {
	switch subjectType {
	case domain.SubjectUser:
		return domain.PriorityUser, "user:" + subjectID, subjectID == userID
	case domain.SubjectAgent:
		return domain.PriorityAgent, "agent:" + subjectID, workerID == "agent:"+subjectID
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

func (s *Store) decorateProficiency(ctx context.Context, realm, workerID string, skills []domain.EffectiveSkill) ([]domain.EffectiveSkill, error) {
	if len(skills) == 0 {
		return skills, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT skill_id, level, confidence FROM governance_skill_proficiency
		WHERE realm=$1 AND worker_id=$2 ORDER BY evidence_n DESC, updated_at DESC`, realm, workerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type proficiency struct {
		level      int
		confidence float64
	}
	bySkill := map[string]proficiency{}
	for rows.Next() {
		var id string
		var p proficiency
		if err := rows.Scan(&id, &p.level, &p.confidence); err != nil {
			return nil, err
		}
		if _, exists := bySkill[id]; !exists {
			bySkill[id] = p
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range skills {
		if p, ok := bySkill[skills[i].SkillID]; ok {
			skills[i].Level, skills[i].Confidence = p.level, p.confidence
		}
	}
	return skills, nil
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
	node.Status = domain.NodePendingActivation
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
		  capabilities=EXCLUDED.capabilities, residency=EXCLUDED.residency, status='PENDING_ACTIVATION',
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
		SET last_seen_at=now(), status=CASE WHEN status IN ('REVOKED','PENDING_ACTIVATION') THEN status ELSE 'ONLINE' END
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

func stringSliceJSON(values []string) ([]byte, error) {
	if values == nil {
		values = []string{}
	}
	return json.Marshal(values)
}

func (s *Store) CreateDelegatedTask(ctx context.Context, task domain.DelegatedTask) (domain.DelegatedTask, error) {
	return s.createDelegatedTask(ctx, task, nil)
}

// CreateDelegatedTaskWithRun commits task snapshots and attempt=1 in one
// transaction. A task without its first Run is not a dispatch; keeping the
// write atomic also makes the old scheduler_task_id migration auditable.
func (s *Store) CreateDelegatedTaskWithRun(ctx context.Context, task domain.DelegatedTask, run domain.TaskRun) (domain.DelegatedTask, domain.TaskRun, error) {
	created, err := s.createDelegatedTask(ctx, task, &run)
	if err != nil {
		return domain.DelegatedTask{}, domain.TaskRun{}, err
	}
	storedRun, err := s.GetTaskRun(ctx, task.Realm, run.ID)
	if err != nil {
		return domain.DelegatedTask{}, domain.TaskRun{}, err
	}
	return created, storedRun, nil
}

func (s *Store) createDelegatedTask(ctx context.Context, task domain.DelegatedTask, run *domain.TaskRun) (domain.DelegatedTask, error) {
	if task.ID == "" || task.Realm == "" || task.Title == "" || task.Intent == "" || task.RequesterUserID == "" || !domain.ValidDelegationState(task.State) {
		return domain.DelegatedTask{}, fmt.Errorf("%w: invalid delegation task", ErrBadRequest)
	}
	if task.BusinessState != "" {
		if _, err := domain.TransitionBusinessTask(task.BusinessState, "route"); err != nil && task.BusinessState != domain.BusinessDraft {
			return domain.DelegatedTask{}, fmt.Errorf("%w: invalid business state", ErrBadRequest)
		}
	}
	if !s.userExists(ctx, task.Realm, task.RequesterUserID) || (task.AssigneeUserID != "" && !s.userExists(ctx, task.Realm, task.AssigneeUserID)) {
		return domain.DelegatedTask{}, ErrNotFound
	}
	requiredTags, err := stringSliceJSON(task.RequiredTags)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	requiredSkills, err := stringSliceJSON(task.RequiredSkills)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	inferredTags, err := stringSliceJSON(task.InferredTags)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	inferredSkills, err := stringSliceJSON(task.InferredSkills)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	selectedSkills, err := stringSliceJSON(task.SelectedSkills)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	rationale, err := stringSliceJSON(task.Rationale)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	var scoreBreakdown, scoreWeights any
	if task.ScoreBreakdown != (domain.DispatchScoreBreakdown{}) {
		scoreBreakdown, err = json.Marshal(task.ScoreBreakdown)
		if err != nil {
			return domain.DelegatedTask{}, err
		}
	}
	if task.ScoreWeights != (domain.DispatchWeights{}) {
		scoreWeights, err = json.Marshal(task.ScoreWeights)
		if err != nil {
			return domain.DelegatedTask{}, err
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
		INSERT INTO governance_delegation_tasks
		  (id,realm,title,intent,project_id,requester_user_id,assignee_user_id,required_tags,required_skills,inferred_tags,inferred_skills,selected_skills,state,match_score,rationale,scheduler_task_id,assigned_node_id,last_error,business_state,confidence_band,assignee_worker_id,score_breakdown,score_weights)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
		RETURNING created_at, updated_at`,
		task.ID, task.Realm, task.Title, task.Intent, task.ProjectID, task.RequesterUserID, task.AssigneeUserID,
		requiredTags, requiredSkills, inferredTags, inferredSkills, selectedSkills, task.State, task.MatchScore, rationale,
		task.SchedulerTaskID, task.AssignedNodeID, task.LastError, nullableText(task.BusinessState), nullableText(task.ConfidenceBand), nullableText(task.AssigneeWorkerID), scoreBreakdown, scoreWeights).Scan(&task.CreatedAt, &task.UpdatedAt)
	if isUniqueViolation(err) {
		return domain.DelegatedTask{}, ErrConflict
	}
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	if run != nil {
		if run.Realm == "" {
			run.Realm = task.Realm
		}
		if run.TaskID == "" {
			run.TaskID = task.ID
		}
		if run.Attempt == 0 {
			run.Attempt = 1
		}
		if run.State == "" {
			run.State = domain.DelegationAssigned
		}
		if err := insertTaskRun(ctx, tx, *run); err != nil {
			return domain.DelegatedTask{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.DelegatedTask{}, err
	}
	return task, nil
}

func nullableText(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func insertTaskRun(ctx context.Context, tx pgx.Tx, run domain.TaskRun) error {
	if run.ID == "" || run.Realm == "" || run.TaskID == "" || run.Attempt < 1 || run.WorkerID == "" || !domain.ValidDelegationState(run.State) {
		return fmt.Errorf("%w: invalid task run", ErrBadRequest)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO governance_task_runs
		  (id,realm,task_id,attempt,worker_id,session_ref,scheduler_task_id,assigned_node_id,state,failure_kind,last_error,started_at,ended_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		run.ID, run.Realm, run.TaskID, run.Attempt, run.WorkerID, run.SessionRef, run.SchedulerTaskID,
		run.AssignedNodeID, run.State, nullableText(run.FailureKind), run.LastError, run.StartedAt, run.EndedAt)
	if isUniqueViolation(err) {
		return ErrConflict
	}
	return err
}

type rowScanner interface{ Scan(dest ...any) error }

func scanDelegatedTask(row rowScanner, task *domain.DelegatedTask) error {
	var requiredTags, requiredSkills, inferredTags, inferredSkills, selectedSkills, rationale []byte
	var businessState, confidenceBand, assigneeWorkerID *string
	var scoreBreakdown, scoreWeights []byte
	if err := row.Scan(&task.ID, &task.Realm, &task.Title, &task.Intent, &task.ProjectID, &task.RequesterUserID, &task.AssigneeUserID, &task.AssigneeName,
		&requiredTags, &requiredSkills, &inferredTags, &inferredSkills, &selectedSkills, &task.State, &task.MatchScore, &rationale,
		&task.SchedulerTaskID, &task.AssignedNodeID, &task.LastError, &businessState, &confidenceBand, &assigneeWorkerID,
		&scoreBreakdown, &scoreWeights, &task.CreatedAt, &task.UpdatedAt); err != nil {
		return err
	}
	if businessState != nil {
		task.BusinessState = *businessState
	}
	if confidenceBand != nil {
		task.ConfidenceBand = *confidenceBand
	}
	if assigneeWorkerID != nil {
		task.AssigneeWorkerID = *assigneeWorkerID
	}
	if len(scoreBreakdown) > 0 {
		if err := json.Unmarshal(scoreBreakdown, &task.ScoreBreakdown); err != nil {
			return err
		}
	}
	if len(scoreWeights) > 0 {
		if err := json.Unmarshal(scoreWeights, &task.ScoreWeights); err != nil {
			return err
		}
	}
	for _, item := range []struct {
		raw    []byte
		target *[]string
	}{
		{requiredTags, &task.RequiredTags}, {requiredSkills, &task.RequiredSkills}, {inferredTags, &task.InferredTags},
		{inferredSkills, &task.InferredSkills}, {selectedSkills, &task.SelectedSkills}, {rationale, &task.Rationale},
	} {
		if len(item.raw) == 0 || string(item.raw) == "null" {
			*item.target = []string{}
			continue
		}
		if err := json.Unmarshal(item.raw, item.target); err != nil {
			return err
		}
	}
	return nil
}

const delegationSelect = `
	SELECT t.id,t.realm,t.title,t.intent,t.project_id,t.requester_user_id,t.assignee_user_id,
	       COALESCE(u.display_name,NULLIF(t.assignee_worker_id,''),''),t.required_tags,t.required_skills,t.inferred_tags,t.inferred_skills,
	       t.selected_skills,t.state,t.match_score,t.rationale,t.scheduler_task_id,t.assigned_node_id,
	       t.last_error,t.business_state,t.confidence_band,t.assignee_worker_id,t.score_breakdown,t.score_weights,
	       t.created_at,t.updated_at
	FROM governance_delegation_tasks t
	LEFT JOIN governance_users u ON u.realm=t.realm AND u.id=t.assignee_user_id`

func (s *Store) GetDelegationTask(ctx context.Context, realm, taskID string) (domain.DelegatedTask, error) {
	var task domain.DelegatedTask
	err := scanDelegatedTask(s.pool.QueryRow(ctx, delegationSelect+` WHERE t.realm=$1 AND t.id=$2`, realm, taskID), &task)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DelegatedTask{}, ErrNotFound
	}
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	return task, nil
}

func (s *Store) ListDelegationTasks(ctx context.Context, realm, userID string, all bool) ([]domain.DelegatedTask, error) {
	query := delegationSelect + ` WHERE t.realm=$1`
	args := []any{realm}
	if !all {
		query += ` AND (t.requester_user_id=$2 OR t.assignee_user_id=$2)`
		args = append(args, userID)
	}
	query += ` ORDER BY t.updated_at DESC LIMIT 200`
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := []domain.DelegatedTask{}
	for rows.Next() {
		var task domain.DelegatedTask
		if err := scanDelegatedTask(rows, &task); err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func (s *Store) UpdateDelegationTask(ctx context.Context, realm, taskID, state, schedulerTaskID, nodeID, lastError string) (domain.DelegatedTask, error) {
	if !domain.ValidDelegationState(state) {
		return domain.DelegatedTask{}, fmt.Errorf("%w: invalid delegation state", ErrBadRequest)
	}
	var task domain.DelegatedTask
	err := scanDelegatedTask(s.pool.QueryRow(ctx, delegationSelect+` WHERE t.id=$1 AND t.realm=$2`, taskID, realm), &task)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DelegatedTask{}, ErrNotFound
	}
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	// The read above is intentionally performed before the write so a missing
	// task is reported as not_found rather than silently creating a new record.
	err = scanDelegatedTask(s.pool.QueryRow(ctx, `
		UPDATE governance_delegation_tasks
		SET state=$3,
		    scheduler_task_id=CASE WHEN $4='' THEN scheduler_task_id ELSE $4 END,
		    assigned_node_id=CASE WHEN $5='' THEN assigned_node_id ELSE $5 END,
		    last_error=$6, updated_at=now()
		WHERE id=$1 AND realm=$2
		RETURNING id,realm,title,intent,project_id,requester_user_id,assignee_user_id,
		          COALESCE((SELECT display_name FROM governance_users WHERE realm=$2 AND id=assignee_user_id),NULLIF(assignee_worker_id,''),''),
		          required_tags,required_skills,inferred_tags,inferred_skills,selected_skills,state,match_score,rationale,
		          scheduler_task_id,assigned_node_id,last_error,business_state,confidence_band,assignee_worker_id,score_breakdown,score_weights,created_at,updated_at`, taskID, realm, state, schedulerTaskID, nodeID, lastError), &task)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DelegatedTask{}, ErrNotFound
	}
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	return task, nil
}

func scanTaskRun(row rowScanner, run *domain.TaskRun) error {
	var failureKind *string
	if err := row.Scan(&run.ID, &run.Realm, &run.TaskID, &run.Attempt, &run.WorkerID, &run.SessionRef,
		&run.SchedulerTaskID, &run.AssignedNodeID, &run.State, &failureKind, &run.LastError,
		&run.StartedAt, &run.EndedAt, &run.CreatedAt); err != nil {
		return err
	}
	if failureKind != nil {
		run.FailureKind = *failureKind
	}
	return nil
}

const taskRunSelect = `
	SELECT id,realm,task_id,attempt,worker_id,session_ref,scheduler_task_id,assigned_node_id,
	       state,failure_kind,last_error,started_at,ended_at,created_at
	FROM governance_task_runs`

func (s *Store) GetTaskRun(ctx context.Context, realm, runID string) (domain.TaskRun, error) {
	var run domain.TaskRun
	err := scanTaskRun(s.pool.QueryRow(ctx, taskRunSelect+` WHERE realm=$1 AND id=$2`, realm, runID), &run)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskRun{}, ErrNotFound
	}
	return run, err
}

func (s *Store) ListTaskRuns(ctx context.Context, realm, taskID string) ([]domain.TaskRun, error) {
	rows, err := s.pool.Query(ctx, taskRunSelect+` WHERE realm=$1 AND task_id=$2 ORDER BY attempt`, realm, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.TaskRun{}
	for rows.Next() {
		var run domain.TaskRun
		if err := scanTaskRun(rows, &run); err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	return out, rows.Err()
}

// CreateNextTaskRun materializes a legacy scheduler row before allocating the
// next attempt. This preserves the old node/error under attempt=1 and records
// why the migration happened instead of silently overwriting it.
func (s *Store) CreateNextTaskRun(ctx context.Context, realm, taskID string, run domain.TaskRun) (domain.TaskRun, error) {
	if run.ID == "" || run.WorkerID == "" {
		return domain.TaskRun{}, fmt.Errorf("%w: run id and worker id are required", ErrBadRequest)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.TaskRun{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var assignee, schedulerID, nodeID, lastError, state string
	if err := tx.QueryRow(ctx, `
		SELECT assignee_user_id,scheduler_task_id,assigned_node_id,last_error,state
		FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, taskID).
		Scan(&assignee, &schedulerID, &nodeID, &lastError, &state); errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskRun{}, ErrNotFound
	} else if err != nil {
		return domain.TaskRun{}, err
	}
	var attempt int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(attempt),0) FROM governance_task_runs WHERE realm=$1 AND task_id=$2`, realm, taskID).Scan(&attempt); err != nil {
		return domain.TaskRun{}, err
	}
	if attempt == 0 && schedulerID != "" {
		legacyWorker := "user:" + assignee
		legacyID := taskID + ":attempt:1"
		legacy := domain.TaskRun{ID: legacyID, Realm: realm, TaskID: taskID, Attempt: 1, WorkerID: legacyWorker, SchedulerTaskID: schedulerID, AssignedNodeID: nodeID, State: state, LastError: lastError}
		if err := insertTaskRun(ctx, tx, legacy); err != nil {
			return domain.TaskRun{}, err
		}
		detail, _ := json.Marshal(map[string]any{"legacy_scheduler_task_id": schedulerID, "attempt": 1})
		if err := insertTaskAudit(ctx, tx, taskID, "legacy_run_materialized", "system", detail); err != nil {
			return domain.TaskRun{}, err
		}
		attempt = 1
	}
	if run.Realm == "" {
		run.Realm = realm
	}
	if run.TaskID == "" {
		run.TaskID = taskID
	}
	if run.Attempt == 0 {
		run.Attempt = attempt + 1
	}
	if run.Attempt != attempt+1 {
		return domain.TaskRun{}, fmt.Errorf("%w: next run attempt must be %d", ErrBadRequest, attempt+1)
	}
	if run.State == "" {
		run.State = domain.DelegationAssigned
	}
	if err := insertTaskRun(ctx, tx, run); err != nil {
		return domain.TaskRun{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.TaskRun{}, err
	}
	return run, nil
}

func (s *Store) UpdateTaskRun(ctx context.Context, realm, taskID, runID, state, schedulerTaskID, nodeID, failureKind, lastError string) (domain.TaskRun, error) {
	if !domain.ValidDelegationState(state) {
		return domain.TaskRun{}, fmt.Errorf("%w: invalid run state", ErrBadRequest)
	}
	var run domain.TaskRun
	err := scanTaskRun(s.pool.QueryRow(ctx, taskRunSelect+` WHERE realm=$1 AND task_id=$2 AND id=$3`, realm, taskID, runID), &run)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskRun{}, ErrNotFound
	}
	if err != nil {
		return domain.TaskRun{}, err
	}
	err = scanTaskRun(s.pool.QueryRow(ctx, `
		UPDATE governance_task_runs SET state=$4,
		  scheduler_task_id=CASE WHEN $5='' THEN scheduler_task_id ELSE $5 END,
		  assigned_node_id=CASE WHEN $6='' THEN assigned_node_id ELSE $6 END,
		  failure_kind=CASE WHEN $7='' THEN failure_kind ELSE $7 END,
		  last_error=$8,
		  started_at=CASE WHEN $4='RUNNING' AND started_at IS NULL THEN now() ELSE started_at END,
		  ended_at=CASE WHEN $4 IN ('COMPLETED','FAILED','CANCELLED','BLOCKED') THEN COALESCE(ended_at,now()) ELSE ended_at END
		WHERE realm=$1 AND task_id=$2 AND id=$3
		RETURNING id,realm,task_id,attempt,worker_id,session_ref,scheduler_task_id,assigned_node_id,state,failure_kind,last_error,started_at,ended_at,created_at`,
		realm, taskID, runID, state, schedulerTaskID, nodeID, nullableText(failureKind), lastError), &run)
	return run, err
}

func insertTaskAudit(ctx context.Context, tx pgx.Tx, taskID, event, actor string, detail []byte) error {
	if len(detail) == 0 {
		detail = []byte(`{}`)
	}
	_, err := tx.Exec(ctx, `INSERT INTO governance_task_audit (id,realm,task_id,event,actor,detail) SELECT gen_random_uuid()::text,realm,id,$2,$3,$4 FROM governance_delegation_tasks WHERE id=$1`, taskID, event, actor, detail)
	return err
}

func (s *Store) TransitionBusinessTask(ctx context.Context, realm, taskID, event, actor string) (domain.DelegatedTask, error) {
	var current string
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(business_state,'' ) FROM governance_delegation_tasks WHERE realm=$1 AND id=$2`, realm, taskID).Scan(&current); errors.Is(err, pgx.ErrNoRows) {
		return domain.DelegatedTask{}, ErrNotFound
	} else if err != nil {
		return domain.DelegatedTask{}, err
	}
	if current == "" {
		return domain.DelegatedTask{}, ErrLegacyTask
	}
	next, err := domain.TransitionBusinessTask(current, event)
	if err != nil {
		return domain.DelegatedTask{}, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE governance_delegation_tasks SET business_state=$3,updated_at=now() WHERE realm=$1 AND id=$2`, realm, taskID, next); err != nil {
		return domain.DelegatedTask{}, err
	}
	detail, _ := json.Marshal(map[string]any{"from": current, "to": next, "event": event})
	if err := insertTaskAudit(ctx, tx, taskID, event, actor, detail); err != nil {
		return domain.DelegatedTask{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.DelegatedTask{}, err
	}
	return s.GetDelegationTask(ctx, realm, taskID)
}

func (s *Store) RecordDispatchOutcome(ctx context.Context, outcome domain.DispatchOutcome) error {
	if outcome.ID == "" || outcome.Realm == "" || outcome.TaskID == "" || outcome.RunID == "" || outcome.WorkerID == "" || !domain.ValidDispatchOutcome(outcome.Outcome) || (outcome.Reason != "" && !domain.ValidReassignReason(outcome.Reason)) || (outcome.Outcome == domain.OutcomeReassigned && outcome.Reason == "") {
		return fmt.Errorf("%w: invalid dispatch outcome", ErrBadRequest)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `INSERT INTO governance_dispatch_outcomes (id,realm,task_id,run_id,worker_id,outcome,reason,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, outcome.ID, outcome.Realm, outcome.TaskID, outcome.RunID, outcome.WorkerID, outcome.Outcome, nullableText(outcome.Reason), outcome.Notes, outcome.CreatedBy)
	if isUniqueViolation(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	// Feedback changes proficiency, never authorization. A failed/reworked
	// outcome remains evidence and lowers confidence without deleting the grant.
	delta := 1
	if outcome.Outcome == domain.OutcomeRejected || outcome.Outcome == domain.OutcomeReworked {
		delta = -1
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO governance_skill_proficiency (realm,worker_id,skill_id,level,confidence,source,evidence_n)
		SELECT $1,$2,sk.id,CASE WHEN $5 > 0 THEN 1 ELSE 0 END,CASE WHEN $5 > 0 THEN 0.2 ELSE 0.1 END,'outcome',1
		FROM governance_delegation_tasks t
		CROSS JOIN LATERAL jsonb_array_elements_text(t.selected_skills) selected(name)
		JOIN governance_skills sk ON sk.realm=$1 AND lower(sk.name)=lower(selected.name)
		WHERE t.realm=$1 AND t.id=$3
		ON CONFLICT (realm,worker_id,skill_id,source) DO UPDATE SET
			level=LEAST(5,GREATEST(0,governance_skill_proficiency.level + $5)),
			confidence=LEAST(1,GREATEST(0,governance_skill_proficiency.confidence + CASE WHEN $5 > 0 THEN 0.1 ELSE -0.1 END)),
			evidence_n=governance_skill_proficiency.evidence_n+1,updated_at=now()`, outcome.Realm, outcome.WorkerID, outcome.TaskID, outcome.RunID, delta)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
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

// matchingRevocations applies every revocation whose subject is present in the
// effective worker context. Revocations intentionally fail closed: a role or
// department administrator can remove a skill for the whole matching scope,
// and an agent revocation matches the exact agent:<preset-ref> worker identity.
func (s *Store) matchingRevocations(ctx context.Context, realm, userID, projectID string, projectMember bool, primaryDeptID string, roles, ancestors map[string]bool) (map[string]bool, error) {
	return s.matchingRevocationsForWorker(ctx, realm, "user:"+userID, userID, projectID, projectMember, primaryDeptID, roles, ancestors)
}

func (s *Store) matchingRevocationsForWorker(ctx context.Context, realm, workerID, userID, projectID string, projectMember bool, primaryDeptID string, roles, ancestors map[string]bool) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT skill_id, subject_type, subject_id FROM governance_skill_revocations
		WHERE realm=$1 AND (expires_at IS NULL OR expires_at > now())`, realm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id, subjectID string
		var subjectType domain.SubjectType
		if err := rows.Scan(&id, &subjectType, &subjectID); err != nil {
			return nil, err
		}
		if matchesRevocationForWorker(subjectType, subjectID, workerID, userID, projectID, projectMember, primaryDeptID, roles, ancestors) {
			out[id] = true
		}
	}
	return out, rows.Err()
}

func matchesRevocation(subjectType domain.SubjectType, subjectID, userID, projectID string, projectMember bool, primaryDeptID string, roles, ancestors map[string]bool) bool {
	return matchesRevocationForWorker(subjectType, subjectID, "user:"+userID, userID, projectID, projectMember, primaryDeptID, roles, ancestors)
}

func matchesRevocationForWorker(subjectType domain.SubjectType, subjectID, workerID, userID, projectID string, projectMember bool, primaryDeptID string, roles, ancestors map[string]bool) bool {
	switch subjectType {
	case domain.SubjectUser:
		return subjectID == userID
	case domain.SubjectProject:
		return projectMember && subjectID == projectID
	case domain.SubjectRole:
		return roles[subjectID]
	case domain.SubjectDepartment:
		return subjectID == primaryDeptID || ancestors[subjectID]
	case domain.SubjectAgent:
		return workerID == "agent:"+subjectID
	default:
		return false
	}
}

func validUserStatus(status string) bool {
	return status == "active" || status == "suspended" || status == "disabled"
}

func validOrgStatus(status string) bool {
	return status == "active" || status == "disabled"
}

func validSkillVisibility(visibility string) bool {
	return visibility == "private" || visibility == "project" || visibility == "department" || visibility == "global"
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
