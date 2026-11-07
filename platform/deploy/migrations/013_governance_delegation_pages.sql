-- The service DDL creates this same index for deployments without migrate.sh.
-- Page order uses immutable creation keys rather than mutable updated_at.
CREATE INDEX IF NOT EXISTS governance_delegation_tasks_created_page_idx
  ON governance_delegation_tasks (realm, created_at DESC, id DESC);
