-- Session-control owns immutable owner execution fencing and current node routes.

CREATE TABLE IF NOT EXISTS session_execution_nodes (
 realm TEXT NOT NULL,node_id TEXT NOT NULL,project_id TEXT NOT NULL,
 process_id TEXT NOT NULL,endpoint TEXT NOT NULL,token_hash TEXT NOT NULL,
 fence BIGINT NOT NULL CHECK(fence>0),expires_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(realm,node_id)
);
CREATE TABLE IF NOT EXISTS session_execution_leases (
 session_ref TEXT PRIMARY KEY REFERENCES session_owners(session_ref),
 realm TEXT NOT NULL,node_id TEXT NOT NULL,project_id TEXT NOT NULL,
 process_id TEXT NOT NULL,node_fence BIGINT NOT NULL,
 fencing_token BIGINT NOT NULL CHECK(fencing_token>0),
 writer_holder TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS session_owners_project_idx ON session_owners(realm,owner_user_id,project_id,session_ref) WHERE state='active';
