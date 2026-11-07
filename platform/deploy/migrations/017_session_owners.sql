-- Immutable owner reservations. Legacy sessions are never adopted automatically.

CREATE TABLE IF NOT EXISTS session_owners (
 session_ref TEXT PRIMARY KEY,
 realm TEXT NOT NULL CHECK (realm <> ''),
 owner_user_id TEXT NOT NULL CHECK (owner_user_id <> ''),
 project_id TEXT NOT NULL CHECK (project_id <> ''),
 node_id TEXT NOT NULL CHECK (node_id <> ''),
 parent_session_ref TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL CHECK (state IN ('reserved','active','failed')),
 creation_token_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 activated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS session_owners_owner_idx ON session_owners (realm, owner_user_id, node_id, session_ref) WHERE state = 'active';
