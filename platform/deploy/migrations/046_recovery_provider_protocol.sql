-- Existing executions retain v1 for read-only reconciliation. New requests
-- explicitly persist v2; old approvals cannot execute without the deadline.
ALTER TABLE governance_recovery_requests ADD COLUMN IF NOT EXISTS provider_protocol TEXT NOT NULL DEFAULT 'lumo.recovery.v1' CHECK(provider_protocol IN ('lumo.recovery.v1','lumo.recovery.v2'));
