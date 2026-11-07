CREATE TABLE IF NOT EXISTS owned_connector_receipts (
 id TEXT PRIMARY KEY,realm TEXT NOT NULL,owner_user_id TEXT NOT NULL,
 project_id TEXT NOT NULL,session_ref TEXT NOT NULL,connector_id TEXT NOT NULL,
 operation TEXT NOT NULL,connector_version INTEGER NOT NULL,payload TEXT NOT NULL,
 digest TEXT NOT NULL,revision BIGINT NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','consumed','succeeded','failed','unknown')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 expires_at TIMESTAMPTZ NOT NULL,decided_at TIMESTAMPTZ,consumed_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS owned_connector_receipts_session_idx ON owned_connector_receipts(realm,owner_user_id,project_id,session_ref,created_at DESC);
CREATE INDEX IF NOT EXISTS owned_connector_receipts_expiry_idx ON owned_connector_receipts(expires_at) WHERE payload<>'null';
