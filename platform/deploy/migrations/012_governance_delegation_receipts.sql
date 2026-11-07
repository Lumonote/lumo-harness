-- Governance owns this table; task/run/scheduling and receipt commit together.
-- Keep aligned with governance/internal/store/delegation_receipts.go.
CREATE TABLE IF NOT EXISTS governance_delegation_receipts (
 realm TEXT NOT NULL,
 requester_user_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id),
 run_id TEXT NOT NULL REFERENCES governance_task_runs(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(realm,requester_user_id,request_key)
);
