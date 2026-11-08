-- 显式会话迁移：可信快照回执与冻结/激活状态。

CREATE TABLE IF NOT EXISTS session_migrations (
 id TEXT PRIMARY KEY,session_ref TEXT NOT NULL REFERENCES session_owners(session_ref),
 realm TEXT NOT NULL,owner_user_id TEXT NOT NULL,project_id TEXT NOT NULL,
 source_node_id TEXT NOT NULL,target_node_id TEXT NOT NULL,
 source_process_id TEXT NOT NULL,source_node_fence BIGINT NOT NULL,source_fencing_token BIGINT NOT NULL,
 snapshot_key TEXT NOT NULL,snapshot_sha256 TEXT NOT NULL,snapshot_bytes BIGINT NOT NULL CHECK(snapshot_bytes>0 AND snapshot_bytes<=33554432),
 event_count INTEGER NOT NULL CHECK(event_count>=0 AND event_count<=10000),
 state TEXT NOT NULL CHECK(state IN ('checkpointed','activated')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),activated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS session_migrations_pending_idx ON session_migrations(session_ref) WHERE state='checkpointed';
CREATE INDEX IF NOT EXISTS session_migrations_session_idx ON session_migrations(realm,session_ref,created_at DESC);
