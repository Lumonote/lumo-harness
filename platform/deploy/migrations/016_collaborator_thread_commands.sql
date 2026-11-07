-- Durable asynchronous fixed-node Thread mailbox.

CREATE TABLE IF NOT EXISTS thread_commands (
 realm TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id),
 owner_user_id TEXT NOT NULL, node_id TEXT NOT NULL, coordinator_session_ref TEXT NOT NULL,
 task_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt>0), prompt TEXT NOT NULL,
 request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('waiting','pending','claimed','completed','failed','expired')),
 wake_key TEXT NOT NULL DEFAULT '', wake_deadline TIMESTAMPTZ, event_id TEXT NOT NULL DEFAULT '',
 claim_hash TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
 PRIMARY KEY(realm,id), UNIQUE(realm,thread_id,attempt)
);
CREATE INDEX IF NOT EXISTS thread_commands_pending ON thread_commands(realm,node_id,owner_user_id,created_at,id) WHERE state='pending';
CREATE UNIQUE INDEX IF NOT EXISTS thread_commands_active ON thread_commands(realm,thread_id) WHERE state IN ('waiting','pending','claimed');
