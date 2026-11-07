CREATE TABLE IF NOT EXISTS session_attachment_receipts (
 realm TEXT NOT NULL,session_ref TEXT NOT NULL REFERENCES session_owners(session_ref),receipt_id TEXT NOT NULL,
 owner_user_id TEXT NOT NULL,project_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('text','image')),
 name TEXT NOT NULL,media_type TEXT NOT NULL,bytes BIGINT NOT NULL CHECK(bytes>0 AND bytes<=8388608),
 sha256 TEXT NOT NULL,native_ref JSONB NOT NULL,inherited_from_session TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(realm,session_ref,receipt_id)
);
