-- Admission is durable before execution starts. No expiry or reclaim path is
-- defined: an uncertain running turn must not be started a second time.
-- Keep this schema in sync with collaborator's startup DDL.
CREATE TABLE IF NOT EXISTS thread_rounds (
  realm TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  coordinator_session_ref TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  run_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  preset_revision INTEGER NOT NULL CHECK (preset_revision >= 1),
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency >= 1),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  session_mode TEXT NOT NULL CHECK (session_mode IN ('create','resume')),
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('running','completed','failed','cancelled')),
  summary TEXT NOT NULL DEFAULT '' CHECK (char_length(summary) <= 16000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (realm, thread_id, attempt),
  UNIQUE (realm, run_id),
  CHECK ((state='running' AND finished_at IS NULL) OR (state<>'running' AND finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS thread_rounds_active
  ON thread_rounds (realm, thread_id) WHERE state='running';
CREATE INDEX IF NOT EXISTS thread_rounds_agent_active
  ON thread_rounds (realm, agent_id) WHERE state='running';
