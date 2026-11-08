-- Explicit local-owner approval and connection-fenced remote computer receipts.
ALTER TABLE governance_bot_grants DROP CONSTRAINT IF EXISTS governance_bot_grants_capability_check;
ALTER TABLE governance_bot_grants ADD CONSTRAINT governance_bot_grants_capability_check CHECK(capability IN ('delegation.create','computer-use.request'));
CREATE TABLE IF NOT EXISTS governance_remote_computer_requests (
 id TEXT PRIMARY KEY,realm TEXT NOT NULL,node_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,
 connection_id TEXT NOT NULL,device_revision BIGINT NOT NULL,execution_key TEXT NOT NULL,
 authority JSONB NOT NULL,plan_json TEXT NOT NULL,digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','denied','cancelled','unknown')),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),summary TEXT NOT NULL DEFAULT '',
 expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(realm,execution_key),FOREIGN KEY(realm,node_id) REFERENCES governance_desktop_nodes(realm,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS governance_remote_computer_active_device ON governance_remote_computer_requests(realm,node_id) WHERE state IN ('pending','running');
CREATE TABLE IF NOT EXISTS governance_remote_computer_receipts (
 request_id TEXT NOT NULL REFERENCES governance_remote_computer_requests(id),revision BIGINT NOT NULL,
 phase TEXT NOT NULL,state TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(request_id,revision)
);
