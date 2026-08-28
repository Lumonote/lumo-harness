-- Scheduler advanced placement metadata: EDF, weighted queues and hard anti-affinity.
-- The service DDL is still idempotent for local-lite; production applies this
-- migration before enabling the advanced scheduling fields.
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS deadline_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS queue TEXT NOT NULL DEFAULT 'default';
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS avoid_nodes TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_pending_edf
  ON scheduler_tasks (deadline_ms, priority DESC, created_at)
  WHERE state = 'PENDING';
