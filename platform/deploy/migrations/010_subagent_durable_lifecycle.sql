-- 子代理跨节点启动、回执重接、执行进程代际及父进程崩溃后的放置清理。
-- 与各运行时组件自带 DDL 同文，集中迁移与 Compose 自动初始化收敛。
-- 旧回执缺少 owner/parent 时保留为空；恢复接口拒绝没有可证明归属的历史记录。
-- 旧 admitted 记录没有 start_request 且无既存回执时保留现场并拒绝启动，不臆造恢复目标。

CREATE TABLE IF NOT EXISTS subagent_callback_outbox (
  realm TEXT NOT NULL,
  run_id TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  callback_origin TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_token TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(realm,run_id)
);
CREATE INDEX IF NOT EXISTS subagent_callback_pending_idx
  ON subagent_callback_outbox(next_attempt_at) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS subagent_callback_inbox (
  realm TEXT NOT NULL,
  run_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  payload JSONB,
  scheduler_attempt INTEGER,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(realm,run_id)
);
ALTER TABLE subagent_callback_inbox ALTER COLUMN payload DROP NOT NULL;
ALTER TABLE subagent_callback_inbox ADD COLUMN IF NOT EXISTS scheduler_node_id TEXT;
ALTER TABLE subagent_callback_inbox ADD COLUMN IF NOT EXISTS parent_session_id TEXT;
ALTER TABLE subagent_callback_inbox ADD COLUMN IF NOT EXISTS owner_user_id TEXT;

CREATE TABLE IF NOT EXISTS subagent_start_guard (
  realm TEXT NOT NULL, child_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  node_id TEXT NOT NULL, cancelled BOOLEAN NOT NULL DEFAULT false,
  admitted BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(realm,child_id)
);
ALTER TABLE subagent_start_guard ADD COLUMN IF NOT EXISTS start_request JSONB;
ALTER TABLE subagent_start_guard ADD COLUMN IF NOT EXISTS boot_holder TEXT;
ALTER TABLE subagent_start_guard ADD COLUMN IF NOT EXISTS boot_token BIGINT;
ALTER TABLE subagent_start_guard ADD COLUMN IF NOT EXISTS settled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subagent_start_guard ADD COLUMN IF NOT EXISTS cancel_all BOOLEAN NOT NULL DEFAULT false;
UPDATE subagent_start_guard SET cancel_all=true WHERE attempt=0 AND cancelled=true AND cancel_all=false;
CREATE TABLE IF NOT EXISTS subagent_host_boot (
  node_id TEXT PRIMARY KEY, holder TEXT NOT NULL, fencing_token BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS subagent_placement_cleanup (
  realm TEXT NOT NULL, child_id TEXT NOT NULL, attempt INTEGER, node_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL, cancellation_needed BOOLEAN NOT NULL DEFAULT false,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), claim_token TEXT,
  PRIMARY KEY(realm,child_id)
);
