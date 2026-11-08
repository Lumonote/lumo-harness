-- Retired ranges remain durable so the archive scanner never recreates an
-- expired segment from the append-only PostgreSQL source.
CREATE TABLE IF NOT EXISTS session_log_archive (
  session_ref TEXT NOT NULL,
  start_seq BIGINT NOT NULL,
  end_seq BIGINT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BIGINT NOT NULL,
  items BIGINT NOT NULL,
  archived_at BIGINT NOT NULL,
  retired_at BIGINT,
  PRIMARY KEY(session_ref,start_seq,end_seq)
);
ALTER TABLE session_log_archive ADD COLUMN IF NOT EXISTS retired_at BIGINT;
