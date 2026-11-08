-- Keep the original receipt immutable as a tombstone. No original object key,
-- hash, size or author is overwritten, and no audit evidence is deleted.
ALTER TABLE governance_task_artifacts ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE governance_task_artifacts ADD COLUMN IF NOT EXISTS revoked_by TEXT NOT NULL DEFAULT '';
ALTER TABLE governance_task_artifacts ADD COLUMN IF NOT EXISTS revocation_reason TEXT NOT NULL DEFAULT '';
