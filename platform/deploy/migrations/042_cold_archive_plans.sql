-- Freeze each managed upload range before external IO, so appends and changed
-- page sizes cannot strand a successful object after its metadata commit fails.
CREATE TABLE IF NOT EXISTS session_log_archive_plans (
  session_ref TEXT NOT NULL,
  start_seq BIGINT NOT NULL,
  end_seq BIGINT NOT NULL,
  realm TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  bytes BIGINT NOT NULL CHECK(bytes > 0),
  items INTEGER NOT NULL CHECK(items BETWEEN 1 AND 1000),
  planned_at BIGINT NOT NULL,
  PRIMARY KEY(session_ref,start_seq,end_seq),
  CHECK(start_seq >= 0 AND end_seq >= start_seq)
);
