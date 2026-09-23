// Package store persists Cluster-only governance state. The tables are owned
// by this service; Registry bytes, project membership, and Scheduler node
// placement remain owned by their existing services.
package store

import (
	"context"
	"crypto/sha256"
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
CREATE TABLE IF NOT EXISTS governance_auth_oidc_identities (
  realm             TEXT NOT NULL,
  issuer            TEXT NOT NULL,
  subject           TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  username          TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at     TIMESTAMPTZ,
  PRIMARY KEY (realm, issuer, subject),
  UNIQUE (realm, user_id),
  FOREIGN KEY (realm, user_id) REFERENCES governance_users(realm, id) ON DELETE CASCADE
);
ALTER TABLE governance_auth_oidc_identities ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS governance_auth_oidc_flows (
  state_hash        TEXT PRIMARY KEY,
  browser_hash      TEXT NOT NULL,
  config_hash       TEXT NOT NULL,
  nonce             TEXT NOT NULL,
  verifier          TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS governance_auth_oidc_flows_expiry_idx ON governance_auth_oidc_flows (expires_at);
CREATE TABLE IF NOT EXISTS governance_auth_sessions (
	  session_id        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  token_hash        TEXT PRIMARY KEY,
  realm             TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  client_ip         TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (realm, user_id) REFERENCES governance_users(realm, id) ON DELETE CASCADE
);
-- 默认值要与上面建表语句里的**逐字一致**，且必须单独再 SET DEFAULT 一遍：
-- 「ADD COLUMN IF NOT EXISTS」在列已存在时整句是空操作（含 DEFAULT），老库于是拿到一个
-- 「NOT NULL 且无默认」的 session_id，而两处 INSERT（auth.go 的密码登录、oidc.go 的
-- 回调）都不列这一列 → 23502，表现为登录页「用户认证服务暂时不可用」。
-- 一条建表语句与一条收敛语句是两份手抄的判据，它们不等价时**只有老库会坏**。
ALTER TABLE governance_auth_sessions ADD COLUMN IF NOT EXISTS session_id TEXT DEFAULT gen_random_uuid()::text;
ALTER TABLE governance_auth_sessions ALTER COLUMN session_id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE governance_auth_sessions ADD COLUMN IF NOT EXISTS oidc_issuer TEXT NOT NULL DEFAULT '';
UPDATE governance_auth_sessions SET session_id=gen_random_uuid()::text WHERE session_id IS NULL OR session_id='';
ALTER TABLE governance_auth_sessions ALTER COLUMN session_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS governance_auth_sessions_id_idx ON governance_auth_sessions (session_id);
CREATE INDEX IF NOT EXISTS governance_auth_sessions_expiry_idx ON governance_auth_sessions (expires_at);
CREATE TABLE IF NOT EXISTS governance_auth_security_events (
  id          BIGSERIAL PRIMARY KEY,
  realm       TEXT NOT NULL,
  user_id     TEXT NOT NULL DEFAULT '',
  event       TEXT NOT NULL CHECK (event IN ('login_succeeded','login_failed','login_locked','logout','session_revoked','sessions_revoked','password_changed','mfa_enabled','mfa_disabled','passkey_registered','passkey_removed','passkey_login','passkey_clone_detected')),
  client_ip   TEXT NOT NULL DEFAULT '',
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE governance_auth_security_events DROP CONSTRAINT IF EXISTS governance_auth_security_events_event_check;
ALTER TABLE governance_auth_security_events ADD CONSTRAINT governance_auth_security_events_event_check
  CHECK (event IN ('login_succeeded','login_failed','login_locked','logout','session_revoked','sessions_revoked','password_changed','mfa_enabled','mfa_disabled','passkey_registered','passkey_removed','passkey_login','passkey_clone_detected','user_created','user_updated','credentials_reset','role_assigned','role_revoked','role_updated','department_updated','node_updated','skill_access_updated','oidc_login','oidc_linked','oidc_unlinked'));
CREATE INDEX IF NOT EXISTS governance_auth_security_events_user_idx
  ON governance_auth_security_events (realm, user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS governance_auth_totp (
  realm              TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  secret_nonce       BYTEA NOT NULL,
  secret_ciphertext  BYTEA NOT NULL,
  enabled            BOOLEAN NOT NULL DEFAULT false,
  pending_expires_at TIMESTAMPTZ,
  enrolled_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, user_id),
  FOREIGN KEY (realm, user_id) REFERENCES governance_users(realm, id) ON DELETE CASCADE
);
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

-- Passkey material is public-key data only.  Challenges are stored as hashes
-- and consumed once, so neither a browser challenge nor an assertion can be
-- replayed after a successful or failed finish request.
CREATE TABLE IF NOT EXISTS governance_auth_webauthn_credentials (
  credential_id       BYTEA PRIMARY KEY,
  realm               TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  public_key_cose     BYTEA NOT NULL,
  sign_count          BIGINT NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  label               TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at        TIMESTAMPTZ,
  FOREIGN KEY (realm, user_id) REFERENCES governance_users(realm, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS governance_auth_webauthn_credentials_user_idx
  ON governance_auth_webauthn_credentials (realm, user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS governance_auth_webauthn_challenges (
  challenge_hash      TEXT PRIMARY KEY,
  purpose             TEXT NOT NULL CHECK (purpose IN ('register','authenticate')),
  realm               TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (realm, user_id) REFERENCES governance_users(realm, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS governance_auth_webauthn_challenges_expiry_idx
  ON governance_auth_webauthn_challenges (expires_at);

CREATE TABLE IF NOT EXISTS governance_skills (
  realm             TEXT NOT NULL,
  id                TEXT NOT NULL,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('prompt','workflow','tool','connector')),
  visibility        TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','project','department','global')),
  current_version   TEXT NOT NULL,
  published_version TEXT NOT NULL DEFAULT '',
  published_digest  TEXT NOT NULL DEFAULT '',
  published_by      TEXT NOT NULL DEFAULT '',
  published_at      TIMESTAMPTZ,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, id),
  UNIQUE (realm, name)
);
ALTER TABLE governance_skills ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE governance_skills ADD COLUMN IF NOT EXISTS published_version TEXT NOT NULL DEFAULT '';
ALTER TABLE governance_skills ADD COLUMN IF NOT EXISTS published_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE governance_skills ADD COLUMN IF NOT EXISTS published_by TEXT NOT NULL DEFAULT '';
ALTER TABLE governance_skills ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- Skill source is immutable per version. current_version tracks the latest
-- governed draft, while published_version is the explicit runtime-release
-- pointer. Neither pointer ever overwrites historical source.
CREATE TABLE IF NOT EXISTS governance_skill_versions (
  realm             TEXT NOT NULL,
  skill_id          TEXT NOT NULL,
  version           TEXT NOT NULL,
  content           TEXT NOT NULL,
  digest            TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, skill_id, version),
  FOREIGN KEY (realm, skill_id) REFERENCES governance_skills(realm, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS governance_skill_versions_lookup
  ON governance_skill_versions(realm, skill_id, created_at DESC);

-- Existing deployments predate the explicit publish pointer. Their current
-- immutable revision remains the release rather than silently disappearing
-- from consumers on upgrade. New skills start unpublished.
UPDATE governance_skills sk
SET published_version=sk.current_version,
    published_digest=sv.digest,
    published_by=sk.created_by,
    published_at=sk.created_at
FROM governance_skill_versions sv
WHERE sk.published_version=''
  AND sv.realm=sk.realm AND sv.skill_id=sk.id AND sv.version=sk.current_version;

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
  state             TEXT NOT NULL CHECK (state IN ('ASSIGNED','QUEUED','RUNNING','CANCELLING','COMPLETED','FAILED','CANCELLED','BLOCKED')),
  match_score       INTEGER NOT NULL DEFAULT 0,
  rationale         JSONB NOT NULL DEFAULT '[]'::jsonb,
  scheduler_task_id TEXT NOT NULL DEFAULT '',
  assigned_node_id  TEXT NOT NULL DEFAULT '',
	  schedule          JSONB NOT NULL DEFAULT '{}'::jsonb,
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
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS schedule JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS intent_contract JSONB;
CREATE INDEX IF NOT EXISTS governance_delegation_parent_idx
  ON governance_delegation_tasks (realm, (intent_contract->>'parent_task_id'));
ALTER TABLE governance_delegation_tasks DROP CONSTRAINT IF EXISTS governance_delegation_tasks_state_check;
ALTER TABLE governance_delegation_tasks ADD CONSTRAINT governance_delegation_tasks_state_check
  CHECK (state IN ('ASSIGNED','QUEUED','RUNNING','CANCELLING','COMPLETED','FAILED','CANCELLED','BLOCKED'));
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
  state             TEXT NOT NULL CHECK (state IN ('ASSIGNED','QUEUED','RUNNING','CANCELLING','COMPLETED','FAILED','CANCELLED','BLOCKED')),
  failure_kind      TEXT,
  last_error        TEXT NOT NULL DEFAULT '',
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt)
);
CREATE INDEX IF NOT EXISTS governance_task_runs_task_idx ON governance_task_runs (realm, task_id, attempt DESC);
CREATE INDEX IF NOT EXISTS governance_task_runs_worker_idx ON governance_task_runs (realm, worker_id, state, created_at DESC);
ALTER TABLE governance_task_runs DROP CONSTRAINT IF EXISTS governance_task_runs_state_check;
ALTER TABLE governance_task_runs ADD CONSTRAINT governance_task_runs_state_check
  CHECK (state IN ('ASSIGNED','QUEUED','RUNNING','CANCELLING','COMPLETED','FAILED','CANCELLED','BLOCKED'));

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

CREATE TABLE IF NOT EXISTS governance_worker_heartbeats (
  realm TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  preset_revision INTEGER NOT NULL,
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency BETWEEN 1 AND 1024),
  status TEXT NOT NULL CHECK (status IN ('active','draining','disabled')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm,worker_id,node_id)
);

-- Agent presets are managed assets, not a second registry of live workers.
-- Runtime heartbeats and active runs remain in governance_worker_runtime and
-- governance_task_runs respectively. A preset takes precedence for desired
-- delegation limits when it exists; runtime rows remain a legacy fallback.
CREATE TABLE IF NOT EXISTS governance_agent_presets (
  realm                  TEXT NOT NULL,
  id                     TEXT NOT NULL,
  project_id             TEXT NOT NULL DEFAULT '',
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  owner_user_id          TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  version                TEXT NOT NULL DEFAULT '1.0.0',
  revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  provider               TEXT NOT NULL,
  model_ref              TEXT NOT NULL,
  system_prompt_ref      TEXT NOT NULL DEFAULT '',
  connector_ids          JSONB NOT NULL DEFAULT '[]'::jsonb,
  knowledge_space_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_concurrency        INTEGER NOT NULL CHECK (max_concurrency >= 1),
  trust_level            TEXT NOT NULL DEFAULT 'unknown',
  residency              TEXT NOT NULL DEFAULT '',
  max_budget_cents       BIGINT NOT NULL DEFAULT 0 CHECK (max_budget_cents >= 0),
  timeout_seconds        INTEGER NOT NULL DEFAULT 3600 CHECK (timeout_seconds BETWEEN 1 AND 86400),
  max_delegation_depth   INTEGER NOT NULL DEFAULT 0 CHECK (max_delegation_depth BETWEEN 0 AND 16),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, id),
  UNIQUE (realm, name),
  FOREIGN KEY (realm, owner_user_id) REFERENCES governance_users(realm, id)
);
CREATE INDEX IF NOT EXISTS governance_agent_presets_project_idx
  ON governance_agent_presets (realm, project_id, status, name);

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

-- task_reports 的建表**不在这里**。本服务声明过它（还带
-- REFERENCES governance_delegation_tasks ON DELETE CASCADE），但从不读写——
-- 读写方只有 platform/control-plane/projects。两个服务同库、同时在线，都用
-- CREATE TABLE IF NOT EXISTS，于是谁先启动谁定语义：governance 先启动则 projects
-- 的 INSERT 对任何本服务不认识的 task_id 直接 FK 违约 500，projects 先启动则这里
-- 声明的级联永不生效。两边都不对，删掉这一份（DDL 归唯一读写方）。
-- 同款先例见 platform/deploy/migrations/004_service_heartbeats.sql 的注释。
`

var (
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("already exists")
	ErrForbidden  = errors.New("forbidden")
	ErrBadRequest = errors.New("bad request")
	ErrLegacyTask = errors.New("legacy task has no business state; materialize a run before transition")
)

type Store struct {
	pool       *pgxpool.Pool
	oidcIssuer string
	oidcRealm  string
}

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
	if _, err := tx.Exec(ctx, taskResultsDDL); err != nil {
		return fmt.Errorf("initialize task results: %w", err)
	}
	if _, err := tx.Exec(ctx, taskSchedulingDDL); err != nil {
		return fmt.Errorf("initialize task scheduling: %w", err)
	}
	if _, err := tx.Exec(ctx, deviceDDL); err != nil {
		return fmt.Errorf("initialize device schema: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit governance schema initialization: %w", err)
	}
	return nil
}

func (s *Store) UpsertUser(ctx context.Context, user domain.User, actor string) (domain.User, error) {
	if err := validateManagedUser(&user); err != nil {
		return domain.User{}, err
	}
	if user.Source == "" {
		user.Source = "local"
	}
	tx, err := s.beginOrganizationChange(ctx, user.Realm)
	if err != nil {
		return domain.User{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := checkUserDepartment(ctx, tx, user); err != nil {
		return domain.User{}, err
	}
	before, err := s.activeAdminCount(ctx, tx, user.Realm)
	if err != nil {
		return domain.User{}, err
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO governance_users (realm, id, display_name, primary_dept_id, status, source)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (realm,id) DO UPDATE SET
		  display_name = EXCLUDED.display_name, primary_dept_id = EXCLUDED.primary_dept_id,
		  status = EXCLUDED.status, updated_at = now()
		RETURNING source, created_at, updated_at`,
		user.Realm, user.ID, user.DisplayName, user.PrimaryDeptID, user.Status, user.Source,
	).Scan(&user.Source, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return domain.User{}, fmt.Errorf("upsert user: %w", err)
	}
	if err = s.preserveActiveAdmin(ctx, tx, user.Realm, before); err != nil {
		return domain.User{}, err
	}
	if user.Status != "active" {
		if _, err = tx.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE realm=$1 AND user_id=$2`, user.Realm, user.ID); err != nil {
			return domain.User{}, err
		}
	}
	if err = recordUserAdminEvent(ctx, tx, user.Realm, user.ID, "user_updated", actor, map[string]any{"status": user.Status, "primary_dept_id": user.PrimaryDeptID}); err != nil {
		return domain.User{}, err
	}
	return user, tx.Commit(ctx)
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
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_delegation_tasks WHERE realm=$1 AND assignee_user_id=$2 AND state IN ('ASSIGNED','QUEUED','RUNNING','CANCELLING')`, realm, user.ID).Scan(&active); err != nil {
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

func scanAgentPreset(row rowScanner, preset *domain.AgentPreset) error {
	var connectorIDs, knowledgeSpaceIDs []byte
	if err := row.Scan(
		&preset.ID, &preset.Realm, &preset.ProjectID, &preset.Name, &preset.Description, &preset.OwnerUserID,
		&preset.Status, &preset.Version, &preset.Revision, &preset.Provider, &preset.ModelRef, &preset.SystemPromptRef,
		&connectorIDs, &knowledgeSpaceIDs, &preset.MaxConcurrency, &preset.TrustLevel, &preset.Residency,
		&preset.MaxBudgetCents, &preset.TimeoutSeconds, &preset.MaxDelegationDepth, &preset.CreatedAt, &preset.UpdatedAt,
	); err != nil {
		return err
	}
	if err := json.Unmarshal(connectorIDs, &preset.ConnectorIDs); err != nil {
		return fmt.Errorf("decode agent preset connector ids: %w", err)
	}
	if err := json.Unmarshal(knowledgeSpaceIDs, &preset.KnowledgeSpaceIDs); err != nil {
		return fmt.Errorf("decode agent preset knowledge space ids: %w", err)
	}
	return nil
}

const agentPresetSelect = `
	SELECT id,realm,project_id,name,description,owner_user_id,status,version,revision,
	       provider,model_ref,system_prompt_ref,connector_ids,knowledge_space_ids,
	       max_concurrency,trust_level,residency,max_budget_cents,timeout_seconds,
	       max_delegation_depth,created_at,updated_at
	FROM governance_agent_presets`

func (s *Store) CreateAgentPreset(ctx context.Context, preset domain.AgentPreset) (domain.AgentPreset, error) {
	preset.Normalize()
	if !preset.Valid() {
		return domain.AgentPreset{}, fmt.Errorf("%w: invalid agent preset", ErrBadRequest)
	}
	if !s.userExists(ctx, preset.Realm, preset.OwnerUserID) {
		return domain.AgentPreset{}, ErrNotFound
	}
	connectorIDs, err := json.Marshal(preset.ConnectorIDs)
	if err != nil {
		return domain.AgentPreset{}, fmt.Errorf("encode agent preset connector ids: %w", err)
	}
	knowledgeSpaceIDs, err := json.Marshal(preset.KnowledgeSpaceIDs)
	if err != nil {
		return domain.AgentPreset{}, fmt.Errorf("encode agent preset knowledge space ids: %w", err)
	}
	err = s.pool.QueryRow(ctx, `
		INSERT INTO governance_agent_presets (
			realm,id,project_id,name,description,owner_user_id,status,version,provider,model_ref,
			system_prompt_ref,connector_ids,knowledge_space_ids,max_concurrency,trust_level,residency,
			max_budget_cents,timeout_seconds,max_delegation_depth)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
		RETURNING revision,created_at,updated_at`,
		preset.Realm, preset.ID, preset.ProjectID, preset.Name, preset.Description, preset.OwnerUserID,
		preset.Status, preset.Version, preset.Provider, preset.ModelRef, preset.SystemPromptRef,
		connectorIDs, knowledgeSpaceIDs, preset.MaxConcurrency, preset.TrustLevel, preset.Residency,
		preset.MaxBudgetCents, preset.TimeoutSeconds, preset.MaxDelegationDepth,
	).Scan(&preset.Revision, &preset.CreatedAt, &preset.UpdatedAt)
	if isUniqueViolation(err) {
		return domain.AgentPreset{}, ErrConflict
	}
	if err != nil {
		return domain.AgentPreset{}, err
	}
	return preset, nil
}

func (s *Store) ListAgentPresets(ctx context.Context, realm string) ([]domain.AgentPreset, error) {
	rows, err := s.pool.Query(ctx, agentPresetSelect+` WHERE realm=$1 ORDER BY name, id`, realm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.AgentPreset{}
	for rows.Next() {
		var preset domain.AgentPreset
		if err := scanAgentPreset(rows, &preset); err != nil {
			return nil, err
		}
		out = append(out, preset)
	}
	return out, rows.Err()
}

func (s *Store) GetAgentPreset(ctx context.Context, realm, presetID string) (domain.AgentPreset, error) {
	var preset domain.AgentPreset
	err := scanAgentPreset(s.pool.QueryRow(ctx, agentPresetSelect+` WHERE realm=$1 AND id=$2`, realm, presetID), &preset)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.AgentPreset{}, ErrNotFound
	}
	return preset, err
}

// UpdateAgentPreset is optimistic: a stale browser cannot overwrite another
// operator's asset edit. Caller authorization is performed by the server.
func (s *Store) UpdateAgentPreset(ctx context.Context, preset domain.AgentPreset, expectedRevision int) (domain.AgentPreset, error) {
	preset.Normalize()
	if !preset.Valid() || expectedRevision < 1 {
		return domain.AgentPreset{}, fmt.Errorf("%w: invalid agent preset update", ErrBadRequest)
	}
	connectorIDs, err := json.Marshal(preset.ConnectorIDs)
	if err != nil {
		return domain.AgentPreset{}, fmt.Errorf("encode agent preset connector ids: %w", err)
	}
	knowledgeSpaceIDs, err := json.Marshal(preset.KnowledgeSpaceIDs)
	if err != nil {
		return domain.AgentPreset{}, fmt.Errorf("encode agent preset knowledge space ids: %w", err)
	}
	err = s.pool.QueryRow(ctx, `
		UPDATE governance_agent_presets SET
			project_id=$3,name=$4,description=$5,owner_user_id=$6,status=$7,version=$8,
			provider=$9,model_ref=$10,system_prompt_ref=$11,connector_ids=$12,knowledge_space_ids=$13,
			max_concurrency=$14,trust_level=$15,residency=$16,max_budget_cents=$17,
			timeout_seconds=$18,max_delegation_depth=$19,revision=revision+1,updated_at=now()
		WHERE realm=$1 AND id=$2 AND revision=$20
		RETURNING revision,created_at,updated_at`,
		preset.Realm, preset.ID, preset.ProjectID, preset.Name, preset.Description, preset.OwnerUserID,
		preset.Status, preset.Version, preset.Provider, preset.ModelRef, preset.SystemPromptRef,
		connectorIDs, knowledgeSpaceIDs, preset.MaxConcurrency, preset.TrustLevel, preset.Residency,
		preset.MaxBudgetCents, preset.TimeoutSeconds, preset.MaxDelegationDepth, expectedRevision,
	).Scan(&preset.Revision, &preset.CreatedAt, &preset.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.AgentPreset{}, ErrConflict
	}
	if isUniqueViolation(err) {
		return domain.AgentPreset{}, ErrConflict
	}
	if err != nil {
		return domain.AgentPreset{}, err
	}
	return preset, nil
}

// ListWorkerProfiles merges human users with managed Agent preset references,
// runtime rows, and agent grants. It is a read model, not a fourth worker
// registry: a preset is desired configuration; runtime rows are retained only
// for liveness/legacy fallback and task runs remain the load authority.
func (s *Store) ListWorkerProfiles(ctx context.Context, realm, projectID, query string) ([]domain.UserProfile, error) {
	humans, err := s.ListUserProfiles(ctx, realm, projectID, query)
	if err != nil {
		return nil, err
	}
	out := append([]domain.UserProfile(nil), humans...)
	presets, err := s.ListAgentPresets(ctx, realm)
	if err != nil {
		return nil, err
	}
	presetByID := make(map[string]domain.AgentPreset, len(presets))
	for _, preset := range presets {
		presetByID[preset.ID] = preset
	}
	rows, err := s.pool.Query(ctx, `
		SELECT worker_id FROM governance_worker_runtime WHERE realm=$1 AND worker_id LIKE 'agent:%'
		UNION
		SELECT 'agent:' || subject_id FROM governance_skill_grants WHERE realm=$1 AND subject_type='agent'
		UNION
		SELECT 'agent:' || id FROM governance_agent_presets WHERE realm=$1
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
		var runtimeMaxConcurrency int
		var runtimeTrustLevel, runtimeResidency, runtimeStatus string
		var runtimeUpdatedAt time.Time
		runtimeReported := true
		if err := s.pool.QueryRow(ctx, `SELECT max_concurrency,trust_level,residency,
			  CASE WHEN status='active' AND updated_at < now()-interval '30 seconds' THEN 'offline' ELSE status END,updated_at
			  FROM governance_worker_runtime WHERE realm=$1 AND worker_id=$2`, realm, workerID).Scan(&runtimeMaxConcurrency, &runtimeTrustLevel, &runtimeResidency, &runtimeStatus, &runtimeUpdatedAt); errors.Is(err, pgx.ErrNoRows) {
			runtimeMaxConcurrency, runtimeTrustLevel, runtimeStatus, runtimeReported = 1, "unknown", "not_reported", false
		} else if err != nil {
			return nil, err
		}
		workerRef := strings.TrimPrefix(workerID, "agent:")
		preset, managed := presetByID[workerRef]
		if managed {
			var total, active int
			var latest *time.Time
			if err := s.pool.QueryRow(ctx, `SELECT count(*),
				  count(*) FILTER (WHERE status='active' AND updated_at >= now()-interval '30 seconds' AND preset_revision=$3),
				  max(updated_at) FROM governance_worker_heartbeats WHERE realm=$1 AND worker_id=$2`, realm, workerID, preset.Revision).Scan(&total, &active, &latest); err != nil {
				return nil, err
			}
			if total > 0 {
				runtimeReported, runtimeStatus = true, "offline"
				if active > 0 {
					runtimeStatus = "active"
				}
				if latest != nil {
					runtimeUpdatedAt = *latest
				}
			}
		}
		displayName, maxConcurrency, trustLevel, residency, status := workerRef, runtimeMaxConcurrency, runtimeTrustLevel, runtimeResidency, runtimeStatus
		projectScopeID, presetVersion := "", ""
		if managed {
			displayName, maxConcurrency = preset.Name, preset.MaxConcurrency
			trustLevel, residency = preset.TrustLevel, preset.Residency
			projectScopeID, presetVersion, status = preset.ProjectID, preset.Version, preset.Status
			// A managed preset may disable execution even when a node still reports
			// active. Conversely a draining/disabled runtime immediately removes
			// capacity without modifying the asset configuration.
			if runtimeStatus == "draining" || runtimeStatus == "disabled" {
				status = runtimeStatus
			}
		}
		if query != "" && !strings.Contains(strings.ToLower(workerRef), strings.ToLower(query)) && !strings.Contains(strings.ToLower(displayName), strings.ToLower(query)) {
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
		var runtimeUpdatedAtPtr *time.Time
		if runtimeReported {
			runtimeUpdatedAtPtr = &runtimeUpdatedAt
		}
		out = append(out, domain.UserProfile{
			User:     domain.User{DisplayName: displayName, Status: status},
			WorkerID: workerID, WorkerKind: domain.WorkerAgent, ProjectScopeID: projectScopeID, PresetVersion: presetVersion,
			RuntimeStatus: runtimeStatus, RuntimeUpdatedAt: runtimeUpdatedAtPtr,
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
			ProjectScopeID: p.ProjectScopeID, PresetVersion: p.PresetVersion, RuntimeStatus: p.RuntimeStatus, RuntimeUpdatedAt: p.RuntimeUpdatedAt,
			Skills: p.Skills, ActiveTasks: p.ActiveTasks, Load: p.Load, MaxConcurrency: p.MaxConcurrency,
			Confidence: p.Confidence, Quality: p.Quality, CostNorm: p.CostNorm,
			TrustLevel: p.TrustLevel, Residency: p.Residency, Eligible: p.Status == "active" && p.Load <= 0.8 && (p.WorkerKind != domain.WorkerAgent || p.RuntimeStatus == "active"),
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
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_runs WHERE realm=$1 AND worker_id=$2 AND state IN ('ASSIGNED','QUEUED','RUNNING','CANCELLING','BLOCKED')`, realm, workerID).Scan(&active)
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
	department.Name = strings.TrimSpace(department.Name)
	if !managedID.MatchString(department.ID) || department.Realm == "" || department.Name == "" || len([]rune(department.Name)) > 160 {
		return domain.Department{}, fmt.Errorf("%w: department id, realm, and name are required", ErrBadRequest)
	}
	if department.Status == "" {
		department.Status = "active"
	}
	if !validOrgStatus(department.Status) {
		return domain.Department{}, fmt.Errorf("%w: invalid department status", ErrBadRequest)
	}
	tx, err := s.beginOrganizationChange(ctx, department.Realm)
	if err != nil {
		return domain.Department{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	parentPath := "/"
	department.Level = 0
	if department.ParentDeptID != "" {
		var parentLevel int
		err = tx.QueryRow(ctx, `SELECT path, level FROM governance_departments WHERE realm=$1 AND id=$2 AND status='active'`, department.Realm, department.ParentDeptID).Scan(&parentPath, &parentLevel)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Department{}, ErrNotFound
		}
		if err != nil {
			return domain.Department{}, fmt.Errorf("load parent department: %w", err)
		}
		department.Level = parentLevel + 1
	}
	department.Path = parentPath + department.ID + "/"
	if department.ManagerUserID != "" {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_users WHERE realm=$1 AND id=$2 AND status='active')`, department.Realm, department.ManagerUserID).Scan(&exists); err != nil {
			return domain.Department{}, err
		}
		if !exists {
			return domain.Department{}, fmt.Errorf("%w: manager must be active in this realm", ErrBadRequest)
		}
	}
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
	role.Name = strings.TrimSpace(role.Name)
	if !managedID.MatchString(role.ID) || len([]rune(role.Name)) > 160 || len([]rune(role.Description)) > 500 {
		return domain.Role{}, fmt.Errorf("%w: invalid role", ErrBadRequest)
	}
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
	if expiresAt != nil && !expiresAt.After(time.Now()) {
		return fmt.Errorf("%w: role expiry must be in the future", ErrBadRequest)
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_users u, governance_roles r
		WHERE u.realm=$1 AND u.id=$2 AND r.realm=$1 AND r.id=$3 AND r.status='active')`, realm, userID, roleID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	// An expiring administrator grant must not replace the realm's only durable grant.
	before, err := s.activeAdminCount(ctx, tx, realm)
	if err != nil {
		return err
	}
	if expiresAt != nil && (roleID == "realm_admin" || roleID == "platform_admin" || roleID == "admin") && before.durable == 0 {
		return ErrLastAdmin
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO governance_user_roles (realm,user_id,role_id,expires_at,granted_by)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (realm,user_id,role_id) DO UPDATE SET expires_at=EXCLUDED.expires_at, granted_by=EXCLUDED.granted_by`,
		realm, userID, roleID, expiresAt, grantedBy)
	if err != nil {
		return err
	}
	if err = recordUserAdminEvent(ctx, tx, realm, userID, "role_assigned", grantedBy, map[string]any{"role_id": roleID, "expires_at": expiresAt}); err != nil {
		return err
	}
	if err = s.preserveActiveAdmin(ctx, tx, realm, before); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) CreateSkill(ctx context.Context, skill domain.Skill, initial domain.SkillVersion) (domain.Skill, error) {
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
	initial.Realm, initial.SkillID, initial.Version, initial.CreatedBy = skill.Realm, skill.ID, skill.CurrentVersion, skill.CreatedBy
	if !initial.Valid() {
		return domain.Skill{}, fmt.Errorf("%w: initial skill version requires non-empty content up to 128 KiB", ErrBadRequest)
	}
	initial.Digest = fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(initial.Content)))
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Skill{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
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
	if err := tx.QueryRow(ctx, `
		INSERT INTO governance_skill_versions (realm,skill_id,version,content,digest,created_by)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
		initial.Realm, initial.SkillID, initial.Version, initial.Content, initial.Digest, initial.CreatedBy,
	).Scan(&initial.CreatedAt); err != nil {
		return domain.Skill{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Skill{}, err
	}
	return skill, nil
}

func (s *Store) ListSkills(ctx context.Context, realm string) ([]domain.Skill, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, realm, name, kind, visibility, current_version, published_version, published_digest, published_by, published_at, created_by, description, created_at
		FROM governance_skills WHERE realm=$1 ORDER BY name`, realm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Skill{}
	for rows.Next() {
		var skill domain.Skill
		if err := rows.Scan(&skill.ID, &skill.Realm, &skill.Name, &skill.Kind, &skill.Visibility, &skill.CurrentVersion, &skill.PublishedVersion, &skill.PublishedDigest, &skill.PublishedBy, &skill.PublishedAt, &skill.CreatedBy, &skill.Description, &skill.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, skill)
	}
	return out, rows.Err()
}

func (s *Store) GetSkill(ctx context.Context, realm, skillID string) (domain.Skill, error) {
	var skill domain.Skill
	err := s.pool.QueryRow(ctx, `
		SELECT id, realm, name, kind, visibility, current_version, published_version, published_digest, published_by, published_at, created_by, description, created_at
		FROM governance_skills WHERE realm=$1 AND id=$2`, realm, skillID,
	).Scan(&skill.ID, &skill.Realm, &skill.Name, &skill.Kind, &skill.Visibility, &skill.CurrentVersion, &skill.PublishedVersion, &skill.PublishedDigest, &skill.PublishedBy, &skill.PublishedAt, &skill.CreatedBy, &skill.Description, &skill.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Skill{}, ErrNotFound
	}
	return skill, err
}

func (s *Store) ListSkillVersions(ctx context.Context, realm, skillID string) ([]domain.SkillVersion, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT realm, skill_id, version, digest, created_by, created_at
		FROM governance_skill_versions WHERE realm=$1 AND skill_id=$2
		ORDER BY created_at DESC, version DESC`, realm, skillID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.SkillVersion{}
	for rows.Next() {
		var version domain.SkillVersion
		if err := rows.Scan(&version.Realm, &version.SkillID, &version.Version, &version.Digest, &version.CreatedBy, &version.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, version)
	}
	return out, rows.Err()
}

func (s *Store) GetSkillVersion(ctx context.Context, realm, skillID, version string) (domain.SkillVersion, error) {
	var out domain.SkillVersion
	err := s.pool.QueryRow(ctx, `
		SELECT realm, skill_id, version, content, digest, created_by, created_at
		FROM governance_skill_versions WHERE realm=$1 AND skill_id=$2 AND version=$3`, realm, skillID, version,
	).Scan(&out.Realm, &out.SkillID, &out.Version, &out.Content, &out.Digest, &out.CreatedBy, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.SkillVersion{}, ErrNotFound
	}
	return out, err
}

// RuntimeSkillSnapshot returns exactly the source revisions named by the
// explicit published pointers. Drafts are intentionally absent. Callers must
// still validate the returned bytes before turning them into a signed Registry
// artifact because the database is an index, not a node trust root.
func (s *Store) RuntimeSkillSnapshot(ctx context.Context, realm string) (domain.RuntimeSkillSnapshot, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT sk.id, sk.name, sv.version, sv.digest, sv.content
		FROM governance_skills sk
		JOIN governance_skill_versions sv
		  ON sv.realm=sk.realm AND sv.skill_id=sk.id AND sv.version=sk.published_version
		WHERE sk.realm=$1 AND sk.published_version<>''
		ORDER BY sk.name, sk.id`, realm)
	if err != nil {
		return domain.RuntimeSkillSnapshot{}, err
	}
	defer rows.Close()
	snapshot := domain.RuntimeSkillSnapshot{Realm: realm, Skills: []domain.RuntimeSkillSource{}}
	for rows.Next() {
		var source domain.RuntimeSkillSource
		if err := rows.Scan(&source.SkillID, &source.Name, &source.Version, &source.Digest, &source.Content); err != nil {
			return domain.RuntimeSkillSnapshot{}, err
		}
		snapshot.Skills = append(snapshot.Skills, source)
	}
	return snapshot, rows.Err()
}

// CreateSkillVersion never overwrites a version. Updating the draft pointer
// and inserting source share one transaction so clients cannot observe a
// current_version that lacks content. It deliberately never changes the
// explicit runtime-release pointer.
func (s *Store) CreateSkillVersion(ctx context.Context, version domain.SkillVersion) (domain.SkillVersion, error) {
	if !version.Valid() {
		return domain.SkillVersion{}, fmt.Errorf("%w: skill version requires non-empty content up to 128 KiB", ErrBadRequest)
	}
	version.Digest = fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(version.Content)))
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.SkillVersion{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
		INSERT INTO governance_skill_versions (realm,skill_id,version,content,digest,created_by)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
		version.Realm, version.SkillID, version.Version, version.Content, version.Digest, version.CreatedBy,
	).Scan(&version.CreatedAt); err != nil {
		if isUniqueViolation(err) {
			return domain.SkillVersion{}, ErrConflict
		}
		return domain.SkillVersion{}, err
	}
	result, err := tx.Exec(ctx, `UPDATE governance_skills SET current_version=$3 WHERE realm=$1 AND id=$2`, version.Realm, version.SkillID, version.Version)
	if err != nil {
		return domain.SkillVersion{}, err
	}
	if result.RowsAffected() != 1 {
		return domain.SkillVersion{}, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.SkillVersion{}, err
	}
	return version, nil
}

// PublishSkillVersion atomically makes one immutable source revision the
// governed runtime-release snapshot. It copies the version digest into the
// pointer so callers can verify exactly which bytes were approved without
// treating the latest draft as executable.
func (s *Store) PublishSkillVersion(ctx context.Context, realm, skillID, version, publishedBy string) (domain.Skill, error) {
	if realm == "" || skillID == "" || version == "" || publishedBy == "" {
		return domain.Skill{}, fmt.Errorf("%w: realm, skill, version, and publisher are required", ErrBadRequest)
	}
	var skill domain.Skill
	err := s.pool.QueryRow(ctx, `
		WITH selected AS (
			SELECT digest FROM governance_skill_versions
			WHERE realm=$1 AND skill_id=$2 AND version=$3
		)
		UPDATE governance_skills sk
		SET published_version=$3,
			published_digest=selected.digest,
			published_by=$4,
			published_at=now()
		FROM selected
		WHERE sk.realm=$1 AND sk.id=$2
		RETURNING sk.id, sk.realm, sk.name, sk.kind, sk.visibility, sk.current_version,
		          sk.published_version, sk.published_digest, sk.published_by, sk.published_at,
		          sk.created_by, sk.description, sk.created_at`, realm, skillID, version, publishedBy,
	).Scan(&skill.ID, &skill.Realm, &skill.Name, &skill.Kind, &skill.Visibility, &skill.CurrentVersion,
		&skill.PublishedVersion, &skill.PublishedDigest, &skill.PublishedBy, &skill.PublishedAt,
		&skill.CreatedBy, &skill.Description, &skill.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Skill{}, ErrNotFound
	}
	return skill, err
}

func (s *Store) GrantSkill(ctx context.Context, grant domain.SkillGrant) error {
	if grant.ID == "" || grant.Realm == "" || grant.SkillID == "" || !grant.SubjectType.Valid() || grant.SubjectID == "" || grant.GrantedBy == "" {
		return fmt.Errorf("%w: invalid skill grant", ErrBadRequest)
	}
	if !s.skillExists(ctx, grant.Realm, grant.SkillID) {
		return ErrNotFound
	}
	if grant.IncludeChildren && grant.SubjectType != domain.SubjectDepartment {
		return fmt.Errorf("%w: only department grants can include children", ErrBadRequest)
	}
	if grant.VersionConstraint != "" {
		if _, err := s.GetSkillVersion(ctx, grant.Realm, grant.SkillID, grant.VersionConstraint); err != nil {
			return err
		}
	}
	tx, err := s.beginOrganizationChange(ctx, grant.Realm)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := checkSkillSubject(ctx, tx, grant.Realm, grant.SubjectType, grant.SubjectID, grant.ExpiresAt); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO governance_skill_grants (id,realm,skill_id,version_constraint,subject_type,subject_id,include_children,expires_at,granted_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		grant.ID, grant.Realm, grant.SkillID, grant.VersionConstraint, grant.SubjectType, grant.SubjectID,
		grant.IncludeChildren, grant.ExpiresAt, grant.GrantedBy)
	if isUniqueViolation(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	if err = recordUserAdminEvent(ctx, tx, grant.Realm, grant.GrantedBy, "skill_access_updated", grant.GrantedBy, map[string]any{"skill_id": grant.SkillID, "grant_id": grant.ID, "subject_type": grant.SubjectType, "subject_id": grant.SubjectID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RevokeSkill(ctx context.Context, revocation domain.SkillRevocation) error {
	if revocation.ID == "" || revocation.Realm == "" || revocation.SkillID == "" || !revocation.SubjectType.Valid() || revocation.SubjectID == "" || revocation.RevokedBy == "" {
		return fmt.Errorf("%w: invalid skill revocation", ErrBadRequest)
	}
	if !s.skillExists(ctx, revocation.Realm, revocation.SkillID) {
		return ErrNotFound
	}
	if !managedID.MatchString(revocation.SubjectID) || (revocation.ExpiresAt != nil && !revocation.ExpiresAt.After(time.Now())) || len([]rune(revocation.Reason)) > 500 {
		return fmt.Errorf("%w: invalid revocation subject, reason or expiry", ErrBadRequest)
	}
	tx, err := s.beginOrganizationChange(ctx, revocation.Realm)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO governance_skill_revocations (id,realm,skill_id,subject_type,subject_id,reason,expires_at,revoked_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		revocation.ID, revocation.Realm, revocation.SkillID, revocation.SubjectType, revocation.SubjectID,
		revocation.Reason, revocation.ExpiresAt, revocation.RevokedBy)
	if isUniqueViolation(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	if err = recordUserAdminEvent(ctx, tx, revocation.Realm, revocation.RevokedBy, "skill_access_updated", revocation.RevokedBy, map[string]any{"skill_id": revocation.SkillID, "revocation_id": revocation.ID, "subject_type": revocation.SubjectType, "subject_id": revocation.SubjectID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
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
	if !managedID.MatchString(node.ID) || node.Realm == "" || !managedID.MatchString(node.ClusterID) || node.OwnerUserID == "" || strings.TrimSpace(node.DisplayName) == "" || node.OS == "" || node.Arch == "" || node.Capacity < 1 || node.Capacity > 1024 || len(node.Capabilities) > 100 {
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
	tx, err := s.beginOrganizationChange(ctx, node.Realm)
	if err != nil {
		return domain.DesktopNode{}, err
	}
	defer tx.Rollback(ctx)
	capabilities, err := json.Marshal(node.Capabilities)
	if err != nil {
		return domain.DesktopNode{}, err
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO governance_desktop_nodes (realm,id,cluster_id,owner_user_id,display_name,os,arch,client_version,capacity,capabilities,residency,status,scheduling_eligible)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (realm,id) DO UPDATE SET
		  cluster_id=EXCLUDED.cluster_id, display_name=EXCLUDED.display_name,
		  os=EXCLUDED.os, arch=EXCLUDED.arch, client_version=EXCLUDED.client_version, capacity=EXCLUDED.capacity,
		  capabilities=EXCLUDED.capabilities, residency=EXCLUDED.residency, status='PENDING_ACTIVATION',
		  scheduling_eligible=false, last_seen_at=now()
		WHERE governance_desktop_nodes.owner_user_id=EXCLUDED.owner_user_id AND governance_desktop_nodes.status NOT IN ('REVOKED','DRAINING')
		RETURNING last_seen_at`,
		node.Realm, node.ID, node.ClusterID, node.OwnerUserID, node.DisplayName, node.OS, node.Arch, node.ClientVersion,
		node.Capacity, capabilities, node.Residency, node.Status, node.SchedulingEligible,
	).Scan(&node.LastSeenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DesktopNode{}, ErrForbidden
	}
	if err != nil {
		return domain.DesktopNode{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_device_connections SET enrollment_hash='',enrollment_expires=NULL,public_key_hash='',certificate_serial='',certificate_expires=NULL,
	 connection_id='',connection_expires=NULL,applied_revision=0,revision=revision+1,policy='{}'::jsonb WHERE realm=$1 AND node_id=$2`, node.Realm, node.ID); err != nil {
		return domain.DesktopNode{}, err
	}
	return node, tx.Commit(ctx)
}

func (s *Store) HeartbeatDesktopNode(ctx context.Context, realm, nodeID, ownerUserID string) (domain.DesktopNode, error) {
	var node domain.DesktopNode
	var capabilities []byte
	err := s.pool.QueryRow(ctx, `
		UPDATE governance_desktop_nodes
		SET last_seen_at=now(), status=CASE WHEN status IN ('DRAINING','PENDING_ACTIVATION') THEN status ELSE 'ONLINE' END
			WHERE realm=$1 AND id=$2 AND owner_user_id=$3 AND status<>'REVOKED'
			AND NOT EXISTS(SELECT 1 FROM governance_device_connections d WHERE d.realm=$1 AND d.node_id=$2 AND d.certificate_serial<>'')
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
		       (scheduling_eligible AND status='ONLINE' AND last_seen_at >= now() - interval '30 seconds'),last_seen_at
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
	schedule := task.Schedule
	if len(schedule) == 0 {
		schedule = json.RawMessage(`{}`)
	}
	if !json.Valid(schedule) {
		return domain.DelegatedTask{}, fmt.Errorf("%w: invalid task schedule", ErrBadRequest)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := prepareTaskIntent(ctx, tx, &task); err != nil {
		return domain.DelegatedTask{}, err
	}
	intentContract, err := json.Marshal(task.IntentContract)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO governance_delegation_tasks
		  (id,realm,title,intent,project_id,requester_user_id,assignee_user_id,required_tags,required_skills,inferred_tags,inferred_skills,selected_skills,state,match_score,rationale,scheduler_task_id,assigned_node_id,schedule,last_error,business_state,confidence_band,assignee_worker_id,score_breakdown,score_weights,intent_contract)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
		RETURNING created_at, updated_at`,
		task.ID, task.Realm, task.Title, task.Intent, task.ProjectID, task.RequesterUserID, task.AssigneeUserID,
		requiredTags, requiredSkills, inferredTags, inferredSkills, selectedSkills, task.State, task.MatchScore, rationale,
		task.SchedulerTaskID, task.AssignedNodeID, schedule, task.LastError, nullableText(task.BusinessState), nullableText(task.ConfidenceBand), nullableText(task.AssigneeWorkerID), scoreBreakdown, scoreWeights, intentContract).Scan(&task.CreatedAt, &task.UpdatedAt)
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
		if run.Realm != task.Realm || run.TaskID != task.ID {
			return domain.DelegatedTask{}, fmt.Errorf("%w: run must belong to its task and realm", ErrBadRequest)
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
	if err == nil && run.SchedulerTaskID == run.ID && run.State == domain.DelegationQueued {
		_, err = tx.Exec(ctx, `INSERT INTO governance_task_scheduling(run_id,realm) VALUES($1,$2)`, run.ID, run.Realm)
	}
	return err
}

type rowScanner interface{ Scan(dest ...any) error }

func scanDelegatedTask(row rowScanner, task *domain.DelegatedTask) error {
	var requiredTags, requiredSkills, inferredTags, inferredSkills, selectedSkills, rationale []byte
	var schedule, intentContract []byte
	var businessState, confidenceBand, assigneeWorkerID *string
	var scoreBreakdown, scoreWeights []byte
	if err := row.Scan(&task.ID, &task.Realm, &task.Title, &task.Intent, &task.ProjectID, &task.RequesterUserID, &task.AssigneeUserID, &task.AssigneeName,
		&requiredTags, &requiredSkills, &inferredTags, &inferredSkills, &selectedSkills, &task.State, &task.MatchScore, &rationale,
		&task.SchedulerTaskID, &task.AssignedNodeID, &schedule, &task.LastError, &businessState, &confidenceBand, &assigneeWorkerID,
		&scoreBreakdown, &scoreWeights, &task.CreatedAt, &task.UpdatedAt, &intentContract); err != nil {
		return err
	}
	if len(schedule) > 0 {
		task.Schedule = append(json.RawMessage(nil), schedule...)
	}
	if len(intentContract) > 0 {
		if err := json.Unmarshal(intentContract, &task.IntentContract); err != nil {
			return err
		}
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
	       t.schedule,t.last_error,t.business_state,t.confidence_band,t.assignee_worker_id,t.score_breakdown,t.score_weights,
	       t.created_at,t.updated_at,t.intent_contract
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

// ListDelegationTasks applies the task visibility scopes at the query boundary.
// A department manager may see their own tasks plus tasks whose requester or
// assignee belongs to an active department subtree they manage; it is never a
// realm-wide grant.
func (s *Store) ListDelegationTasks(ctx context.Context, realm, userID string, all, departmentScope bool) ([]domain.DelegatedTask, error) {
	query := delegationSelect + ` WHERE t.realm=$1`
	args := []any{realm}
	if !all {
		query += ` AND (t.requester_user_id=$2 OR t.assignee_user_id=$2`
		if departmentScope {
			query += ` OR EXISTS (
				SELECT 1
				FROM governance_departments managed
				LEFT JOIN governance_users requester ON requester.realm=t.realm AND requester.id=t.requester_user_id
				LEFT JOIN governance_departments requester_dept ON requester_dept.realm=t.realm AND requester_dept.id=requester.primary_dept_id
				LEFT JOIN governance_users assignee ON assignee.realm=t.realm AND assignee.id=t.assignee_user_id
				LEFT JOIN governance_departments assignee_dept ON assignee_dept.realm=t.realm AND assignee_dept.id=assignee.primary_dept_id
				WHERE managed.realm=t.realm AND managed.manager_user_id=$2 AND managed.status='active'
				  AND (requester_dept.path LIKE managed.path || '%' OR assignee_dept.path LIKE managed.path || '%')
			)`
		}
		query += `)`
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
	if !domain.DelegationStateActive(task.State) {
		if task.State != state {
			return domain.DelegatedTask{}, fmt.Errorf("%w: terminal execution requires a new run", ErrConflict)
		}
		return task, nil
	}
	err = scanDelegatedTask(s.pool.QueryRow(ctx, `
		UPDATE governance_delegation_tasks
		SET state=$3,
		    scheduler_task_id=CASE WHEN $4='' THEN scheduler_task_id ELSE $4 END,
		    assigned_node_id=CASE WHEN $5='' THEN assigned_node_id ELSE $5 END,
		    last_error=$6, updated_at=now()
		WHERE id=$1 AND realm=$2 AND state=$7
		RETURNING id,realm,title,intent,project_id,requester_user_id,assignee_user_id,
		          COALESCE((SELECT display_name FROM governance_users WHERE realm=$2 AND id=assignee_user_id),NULLIF(assignee_worker_id,''),''),
		  required_tags,required_skills,inferred_tags,inferred_skills,selected_skills,state,match_score,rationale,
		  scheduler_task_id,assigned_node_id,schedule,last_error,business_state,confidence_band,assignee_worker_id,score_breakdown,score_weights,created_at,updated_at,intent_contract`, taskID, realm, state, schedulerTaskID, nodeID, lastError, task.State), &task)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DelegatedTask{}, ErrConflict
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

// ListTaskAudit returns the latest immutable control-plane decisions in
// chronological order, suitable for a Task detail timeline.
func (s *Store) ListTaskAudit(ctx context.Context, realm, taskID string) ([]domain.TaskAuditEvent, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id,realm,task_id,event,actor,detail,created_at
		FROM governance_task_audit
		WHERE realm=$1 AND task_id=$2
		ORDER BY created_at ASC, id ASC`, realm, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []domain.TaskAuditEvent{}
	for rows.Next() {
		var event domain.TaskAuditEvent
		if err := rows.Scan(&event.ID, &event.Realm, &event.TaskID, &event.Event, &event.Actor, &event.Detail, &event.CreatedAt); err != nil {
			return nil, err
		}
		if len(event.Detail) == 0 {
			event.Detail = json.RawMessage(`{}`)
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

// TaskRunAssignment is the current execution projection selected when a new
// Run is assigned to a different worker. The former assignment remains on its
// immutable Run; only the task's current projection advances.
type TaskRunAssignment struct {
	UserID         string
	WorkerID       string
	SelectedSkills []string
	MatchScore     int
	Rationale      []string
	ConfidenceBand string
	ScoreBreakdown domain.DispatchScoreBreakdown
	ScoreWeights   domain.DispatchWeights
}

// CreateNextTaskRun materializes a legacy scheduler row before allocating the
// next attempt. This preserves the old node/error under attempt=1 and records
// why the migration happened instead of silently overwriting it.
func (s *Store) CreateNextTaskRun(ctx context.Context, realm, taskID string, run domain.TaskRun) (domain.TaskRun, error) {
	return s.createNextTaskRun(ctx, realm, taskID, run, nil)
}

// CreateNextAssignedTaskRun advances an immutable Run and its current task
// projection atomically. It is used for reassignments so a read can never see
// a new worker Run with the old worker still displayed as the assignee.
func (s *Store) CreateNextAssignedTaskRun(ctx context.Context, realm, taskID string, run domain.TaskRun, assignment TaskRunAssignment) (domain.TaskRun, error) {
	if assignment.WorkerID == "" || assignment.WorkerID != run.WorkerID {
		return domain.TaskRun{}, fmt.Errorf("%w: assignee worker must match run worker", ErrBadRequest)
	}
	return s.createNextTaskRun(ctx, realm, taskID, run, &assignment)
}

func (s *Store) createNextTaskRun(ctx context.Context, realm, taskID string, run domain.TaskRun, assignment *TaskRunAssignment) (domain.TaskRun, error) {
	if run.ID == "" || run.WorkerID == "" {
		return domain.TaskRun{}, fmt.Errorf("%w: run id and worker id are required", ErrBadRequest)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.TaskRun{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var task domain.DelegatedTask
	if err := scanDelegatedTask(tx.QueryRow(ctx, delegationSelect+` WHERE t.realm=$1 AND t.id=$2 FOR UPDATE OF t`, realm, taskID), &task); errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskRun{}, ErrNotFound
	} else if err != nil {
		return domain.TaskRun{}, err
	}
	if domain.DelegationStateActive(task.State) {
		return domain.TaskRun{}, fmt.Errorf("%w: current run is still active", ErrConflict)
	}
	if task.BusinessState == domain.BusinessDone || task.BusinessState == domain.BusinessRejected || task.BusinessState == domain.BusinessArchived {
		return domain.TaskRun{}, fmt.Errorf("%w: reroute the business task before creating another run", ErrConflict)
	}
	if err := parentAcceptsWork(ctx, tx, task); err != nil {
		return domain.TaskRun{}, err
	}
	var attempt int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(attempt),0) FROM governance_task_runs WHERE realm=$1 AND task_id=$2`, realm, taskID).Scan(&attempt); err != nil {
		return domain.TaskRun{}, err
	}
	if attempt == 0 && task.SchedulerTaskID != "" {
		legacyWorker := "user:" + task.AssigneeUserID
		legacyID := taskID + ":attempt:1"
		legacy := domain.TaskRun{ID: legacyID, Realm: realm, TaskID: taskID, Attempt: 1, WorkerID: legacyWorker, SchedulerTaskID: task.SchedulerTaskID, AssignedNodeID: task.AssignedNodeID, State: task.State, LastError: task.LastError}
		if err := insertTaskRun(ctx, tx, legacy); err != nil {
			return domain.TaskRun{}, err
		}
		detail, _ := json.Marshal(map[string]any{"legacy_scheduler_task_id": task.SchedulerTaskID, "attempt": 1})
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
	if run.Realm != realm || run.TaskID != taskID {
		return domain.TaskRun{}, fmt.Errorf("%w: run must belong to its task and realm", ErrBadRequest)
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
	// Advance the parent execution projection in the same transaction as the
	// immutable Run insert. This closes the retry race where two callers could
	// otherwise both observe a terminal task and allocate different attempts.
	if assignment == nil {
		if _, err := tx.Exec(ctx, `
			UPDATE governance_delegation_tasks
			SET state=$3,
			    scheduler_task_id=$4, assigned_node_id=$5,
			    business_state=CASE WHEN business_state IS NOT NULL THEN 'ASSIGNED' ELSE NULL END,
			    last_error=$6, updated_at=now()
			WHERE realm=$1 AND id=$2`, realm, taskID, run.State, run.SchedulerTaskID, run.AssignedNodeID, run.LastError); err != nil {
			return domain.TaskRun{}, err
		}
	} else {
		selectedSkills, err := json.Marshal(assignment.SelectedSkills)
		if err != nil {
			return domain.TaskRun{}, err
		}
		rationale, err := json.Marshal(assignment.Rationale)
		if err != nil {
			return domain.TaskRun{}, err
		}
		scoreBreakdown, err := json.Marshal(assignment.ScoreBreakdown)
		if err != nil {
			return domain.TaskRun{}, err
		}
		scoreWeights, err := json.Marshal(assignment.ScoreWeights)
		if err != nil {
			return domain.TaskRun{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE governance_delegation_tasks
			SET assignee_user_id=$3, assignee_worker_id=$4, selected_skills=$5,
			    match_score=$6, rationale=$7, confidence_band=$8,
			    score_breakdown=$9, score_weights=$10, state=$11,
			    scheduler_task_id=$12, assigned_node_id=$13,
			    business_state=CASE WHEN business_state IS NOT NULL THEN 'ASSIGNED' ELSE NULL END,
			    last_error=$14, updated_at=now()
			WHERE realm=$1 AND id=$2`,
			realm, taskID, assignment.UserID, assignment.WorkerID, selectedSkills,
			assignment.MatchScore, rationale, nullableText(assignment.ConfidenceBand), scoreBreakdown, scoreWeights,
			run.State, run.SchedulerTaskID, run.AssignedNodeID, run.LastError); err != nil {
			return domain.TaskRun{}, err
		}
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
	if !domain.DelegationStateActive(run.State) {
		if run.State != state {
			return domain.TaskRun{}, fmt.Errorf("%w: run result is terminal", ErrConflict)
		}
		return run, nil
	}
	err = scanTaskRun(s.pool.QueryRow(ctx, `
		UPDATE governance_task_runs SET state=$4,
		  scheduler_task_id=CASE WHEN $5='' THEN scheduler_task_id ELSE $5 END,
		  assigned_node_id=CASE WHEN $6='' THEN assigned_node_id ELSE $6 END,
		  failure_kind=CASE WHEN $7='' THEN failure_kind ELSE $7 END,
		  last_error=$8,
		  started_at=CASE WHEN $4='RUNNING' AND started_at IS NULL THEN now() ELSE started_at END,
		  ended_at=CASE WHEN $4 IN ('COMPLETED','FAILED','CANCELLED','BLOCKED') THEN COALESCE(ended_at,now()) ELSE ended_at END
		WHERE realm=$1 AND task_id=$2 AND id=$3 AND state=$9
		  AND attempt=(SELECT max(attempt) FROM governance_task_runs WHERE realm=$1 AND task_id=$2)
		RETURNING id,realm,task_id,attempt,worker_id,session_ref,scheduler_task_id,assigned_node_id,state,failure_kind,last_error,started_at,ended_at,created_at`,
		realm, taskID, runID, state, schedulerTaskID, nodeID, failureKind, lastError, run.State), &run)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskRun{}, ErrConflict
	}
	return run, err
}

func insertTaskAudit(ctx context.Context, tx pgx.Tx, taskID, event, actor string, detail []byte) error {
	if len(detail) == 0 {
		detail = []byte(`{}`)
	}
	_, err := tx.Exec(ctx, `INSERT INTO governance_task_audit (id,realm,task_id,event,actor,detail) SELECT gen_random_uuid()::text,realm,id,$2,$3,$4 FROM governance_delegation_tasks WHERE id=$1`, taskID, event, actor, detail)
	return err
}

// RecordTaskAudit appends a user-visible control decision. It is kept separate
// from the immutable Run row so retry/reassign reasons remain queryable even
// if execution placement is retried by the Scheduler.
func (s *Store) RecordTaskAudit(ctx context.Context, realm, taskID, event, actor string, detail any) error {
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO governance_task_audit (id,realm,task_id,event,actor,detail)
		SELECT gen_random_uuid()::text,realm,id,$3,$4,$5
		FROM governance_delegation_tasks WHERE realm=$1 AND id=$2`, realm, taskID, event, actor, raw)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// TransitionBusinessTask 是业务态迁移的唯一写入口。
//
// `gate` 是 §24.7 组合验证闸门的事实（P6c，见 `internal/domain/coordinator.go`），
// 只在 `complete`（`IN_REVIEW → DONE`）这条边上被读取；其余边上传不传都不影响结果。
// 零值即「没有证据」，闸门按打回处理——见 `domain.IntegrationGateFacts` 的 fail-closed 说明。
// 闸门判定为打回时，业务态回 `ROUTING` 而**不是**逐 Run 打回：§24.7 的失败主体是「组合」，
// 逐 Run 打回会让协调者停在「A 改好、B 又坏」的循环里。
func (s *Store) TransitionBusinessTask(ctx context.Context, realm, taskID, event, actor string, gate domain.IntegrationGateFacts) (domain.DelegatedTask, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var task domain.DelegatedTask
	if err := scanDelegatedTask(tx.QueryRow(ctx, delegationSelect+` WHERE t.realm=$1 AND t.id=$2 FOR UPDATE OF t`, realm, taskID), &task); errors.Is(err, pgx.ErrNoRows) {
		return domain.DelegatedTask{}, ErrNotFound
	} else if err != nil {
		return domain.DelegatedTask{}, err
	}
	current := task.BusinessState
	if current == "" {
		return domain.DelegatedTask{}, ErrLegacyTask
	}
	next, verdict, err := domain.TransitionBusinessTaskGated(current, event, gate)
	if err != nil {
		return domain.DelegatedTask{}, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	if current == next {
		return task, tx.Commit(ctx)
	}
	if event == "reject" || event == "archive" {
		summary, err := collaborationSummary(ctx, tx, realm, taskID)
		if err != nil {
			return domain.DelegatedTask{}, err
		}
		if domain.DelegationStateActive(task.State) || summary.Active > 0 {
			return domain.DelegatedTask{}, fmt.Errorf("%w: stop active executions before closing a task", ErrConflict)
		}
	}
	// 本批的协作摘要只算一次：`complete` 既用它做结构前置条件（子任务未验收即拒绝），
	// 又用它的 `Total` 当可证的影响面代理写进同一条审计（见下方 `review_impact`）。
	// 两处各算一次会让「拒绝时看到的孩子数」与「记录时看到的孩子数」来自不同快照，
	// 而这条审计的全部价值就在于它记的是**当时**的事实。
	var summary domain.CollaborationSummary
	if event == "complete" {
		// 结构前置条件先于闸门：子任务未验收、当前 Run 没有完成结果，这些都是 ErrConflict
		// （不改状态），与「本批组合验证没过」（改状态、回 ROUTING）是两件事，不能互相掩护。
		summary, err = collaborationSummary(ctx, tx, realm, taskID)
		if err != nil {
			return domain.DelegatedTask{}, err
		}
		if summary.Unresolved > 0 {
			return domain.DelegatedTask{}, fmt.Errorf("%w: %d child tasks still require acceptance", ErrConflict, summary.Unresolved)
		}
		var completed bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_task_runs r
		  JOIN governance_task_results e ON e.run_id=r.id AND e.realm=r.realm
		  WHERE r.realm=$1 AND r.task_id=$2 AND r.state='COMPLETED' AND e.payload->>'state'='COMPLETED'
		    AND r.attempt=(SELECT max(attempt) FROM governance_task_runs WHERE realm=$1 AND task_id=$2))`, realm, taskID).Scan(&completed); err != nil {
			return domain.DelegatedTask{}, err
		}
		if !completed {
			return domain.DelegatedTask{}, fmt.Errorf("%w: the current run has no completed execution result", ErrConflict)
		}
	}
	if event == "reroute" {
		if domain.DelegationStateActive(task.State) {
			return domain.DelegatedTask{}, fmt.Errorf("%w: stop the active run before rerouting", ErrConflict)
		}
		if err := parentAcceptsWork(ctx, tx, task); err != nil {
			return domain.DelegatedTask{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE governance_delegation_tasks SET business_state=$3,updated_at=now() WHERE realm=$1 AND id=$2`, realm, taskID, next); err != nil {
		return domain.DelegatedTask{}, err
	}
	fields := map[string]any{"from": current, "to": next, "event": event}
	if event == "complete" {
		// 闸门结论进审计链：一次「整批打回」必须能在事后被解释成「契约测试/冒烟没过」，
		// 而不是一条没有理由的 ROUTING。
		fields["integration_verdict"] = string(verdict)

		// §24.8 规则 1（派发者不验收自己的活）在治理面的落点：**记录，不阻断**。
		//
		// 两个身份都是既有事实，**不需要调用方声明**——这正是它不可绕过的原因：
		//   - dispatcher = 任务的承接人（`assignee_worker_id`，回退 `assignee_user_id`）
		//   - reviewer   = 本次 `complete` 的操作者（`actor`，签名里本来就有）
		//
		// **只记 `self-review`，不记 `homogeneous`。** 后者要求 model / preset / node
		// 三组事实才能证「不同源」，而治理面没有这三组数据 —— 于是它会在**每一次正常完成**
		// 上触发，记下来是噪音而不是发现。等那三组事实接进来（见 §14.5），这里再一并记。
		//
		// **为什么不阻断**：小团队里同一个人既承接又验收是常态，无条件拒绝会让任务永远完不成。
		// 设计的处置是「只在影响面 ≥3 时强制」（§14.5 末），而那个阈值的数据源**仍然不存在**
		// （排除过程见下方 `impact`）。所以这次仍然只记录，但把记录做扎实：不合格理由按闭集
		// 记、可证的影响面事实一并记、判不出来的那一项如实记为判不出来。
		dispatcher := task.AssigneeWorkerID
		if dispatcher == "" {
			dispatcher = task.AssigneeUserID
		}

		// 影响面事实：**治理面没有它的生产者**。逐条排除过，不留一条没查过的路：
		//   * `project_artifacts` / `registry_artifacts` 是项目级、仓库级的注册表，
		//     没有 task / run 归属——它们答的是「这个项目有哪些制品」，不是「这次改动动了几个」；
		//   * `governance_task_results.payload.output` 是执行方自报的自由 JSON（受治理执行里
		//     它就是模型那段文字），自报不是证据：改动少报一个就什么都不剩；
		//   * 唯一非自报的痕迹是数据面的 `session_log`（append-only、节点侧写入）：它不在本服务
		//     的库里——读它等于让控制面去读数据面的表；而且它的单位是**文件**，§24.8 刻意把
		//     单位从「文件」换成了「产出物」。
		// 于是这里传零值（= 无从证明）。**不发明一个请求参数让调用方声明影响面**：那会让
		// 调用方永远可以填 0 绕过审查，正是 §14.5 拒绝的形状。
		impact := domain.ReviewImpact{}
		facts := domain.ReviewerFacts{Dispatcher: dispatcher, Reviewer: actor}
		if impact.Proven {
			// 影响面一旦可证就喂进判据（第 4 条要真的能触发）。判不出来时不喂 0——
			// 0 在判据里读作「影响面小」，而这里的事实是「没有这个数」。
			facts.AffectedArtifacts = impact.Artifacts
		}
		if v := domain.ReviewerEligibility(facts); !v.Eligible && v.Reason == domain.ReviewerSelfReview {
			fields["reviewer_self_review"] = true
			// 闭集里的理由：留着布尔值（§14.5 记的落点就是它）之外再记一份，是为了让
			// 「本月有多少次审查因为同源被拒」是一次 GROUP BY。将来 model / preset / node
			// 三组事实进来、理由不再只有 self-review 时，聚合面不必再改一次键名。
			fields["reviewer_ineligibility"] = string(v.Reason)
			fields["review_disposition"] = string(domain.ReviewDispositionFor(impact))
			fields["review_impact"] = reviewImpactRecord(impact, summary)
		}
	}
	detail, _ := json.Marshal(fields)
	if err := insertTaskAudit(ctx, tx, taskID, event, actor, detail); err != nil {
		return domain.DelegatedTask{}, err
	}
	if err := notifyParentTask(ctx, tx, task, "child_transition", actor, detail); err != nil {
		return domain.DelegatedTask{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.DelegatedTask{}, err
	}
	return s.GetDelegationTask(ctx, realm, taskID)
}

// reviewImpactRecord 是影响面事实在审计里的形状：阈值入参 + 可证的代理指标。
//
// 两个键的来历不同，别读成一回事：
//   - `artifacts` / `artifacts_proven` 是**阈值入参**（§24.8 规则 3）。`artifacts` 只在
//     可证时出现：缺键是「没有这个数」，而 0 会被读成「0 个产出物」——这两者的区别正是
//     这条记录存在的理由。
//   - `batch_tasks` 是**可证的代理指标**：本批进入 DONE 的任务数（含本任务）。每个进入
//     DONE 的任务都走过了 `complete` 的结构前置条件（当前 Run 有一条 COMPLETED 的执行
//     结果），所以它是本批产出物数的**下界**。下界可以记，不能拿来当阈值入参：要么必须
//     把「只有一个任务」读成影响面小（无证据的假设），要么把每一次单线程完成都判成影响面
//     未知而强制阻断——后者是 §14.5 已经否掉的那条路（小团队里同一个人既派发又验收）。
func reviewImpactRecord(impact domain.ReviewImpact, summary domain.CollaborationSummary) map[string]any {
	record := map[string]any{"artifacts_proven": impact.Proven, "batch_tasks": summary.Total + 1}
	if impact.Proven {
		record["artifacts"] = impact.Artifacts
	}
	return record
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
	var taskID string
	if err := tx.QueryRow(ctx, `SELECT id FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR UPDATE`, outcome.Realm, outcome.TaskID).Scan(&taskID); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	var workerID string
	if err := tx.QueryRow(ctx, `SELECT worker_id FROM governance_task_runs WHERE realm=$1 AND task_id=$2 AND id=$3`, outcome.Realm, outcome.TaskID, outcome.RunID).Scan(&workerID); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if workerID != outcome.WorkerID {
		return fmt.Errorf("%w: outcome worker must match the run", ErrBadRequest)
	}
	var duplicate bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_dispatch_outcomes WHERE realm=$1 AND run_id=$2 AND outcome=$3)`, outcome.Realm, outcome.RunID, outcome.Outcome).Scan(&duplicate); err != nil {
		return err
	}
	if duplicate {
		return fmt.Errorf("%w: this run already has that outcome", ErrConflict)
	}
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
		SELECT $1,$2,sk.id,CASE WHEN $4::integer > 0 THEN 1 ELSE 0 END,CASE WHEN $4 > 0 THEN 0.2 ELSE 0.1 END,'outcome',1
		FROM governance_delegation_tasks t
		CROSS JOIN LATERAL jsonb_array_elements_text(t.selected_skills) selected(name)
		JOIN governance_skills sk ON sk.realm=$1 AND lower(sk.name)=lower(selected.name)
		WHERE t.realm=$1 AND t.id=$3
		ON CONFLICT (realm,worker_id,skill_id,source) DO UPDATE SET
			level=LEAST(5,GREATEST(0,governance_skill_proficiency.level + $4)),
			confidence=LEAST(1,GREATEST(0,governance_skill_proficiency.confidence + CASE WHEN $4 > 0 THEN 0.1 ELSE -0.1 END)),
			evidence_n=governance_skill_proficiency.evidence_n+1,updated_at=now()`, outcome.Realm, outcome.WorkerID, outcome.TaskID, delta)
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
		SELECT ur.role_id FROM governance_user_roles ur
		JOIN governance_roles r ON r.realm=ur.realm AND r.id=ur.role_id AND r.status='active'
		WHERE ur.realm=$1 AND ur.user_id=$2 AND (ur.expires_at IS NULL OR ur.expires_at > now())`, realm, userID)
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

// ProjectMember exposes the fail-closed membership check used when a
// Governance action is attached to a project managed by the Projects service.
func (s *Store) ProjectMember(ctx context.Context, projectID, userID string) (bool, error) {
	return s.projectMember(ctx, projectID, userID)
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
