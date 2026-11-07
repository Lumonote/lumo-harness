-- Governed execution identity, closed text output and independent review evidence.

CREATE TABLE IF NOT EXISTS governance_run_execution_snapshots (
 run_id TEXT PRIMARY KEY REFERENCES governance_task_runs(id), realm TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id), snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS governance_run_output_manifests (
 run_id TEXT PRIMARY KEY REFERENCES governance_task_runs(id), realm TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id), digest TEXT NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 manifest JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS governance_run_reviews (
 review_run_id TEXT PRIMARY KEY REFERENCES governance_task_runs(id), realm TEXT NOT NULL,
 producer_task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id), producer_run_id TEXT NOT NULL REFERENCES governance_task_runs(id),
 manifest_digest TEXT NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
 created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 CHECK(review_run_id<>producer_run_id)
);
CREATE INDEX IF NOT EXISTS governance_run_reviews_producer ON governance_run_reviews(realm,producer_run_id);
