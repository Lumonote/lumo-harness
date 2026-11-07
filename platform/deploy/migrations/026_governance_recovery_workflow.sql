-- Durable two-person recovery and key-provider execution workflow.
CREATE TABLE IF NOT EXISTS governance_recovery_requests (
 realm TEXT NOT NULL,id TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('restore','key_destroy')),
 namespace TEXT NOT NULL,target_id TEXT NOT NULL,recovery_point TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL,
 requested_by TEXT NOT NULL,approved_by TEXT NOT NULL DEFAULT '',approved_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','executing','succeeded','failed','uncertain','expired','revoked')),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 provider_id TEXT NOT NULL,policy_digest TEXT NOT NULL,request_digest TEXT NOT NULL,
 execution_id TEXT NOT NULL UNIQUE,fencing_token BIGINT NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
 executed_by TEXT NOT NULL DEFAULT '',claim_hash TEXT NOT NULL DEFAULT '',lease_until TIMESTAMPTZ,last_error TEXT NOT NULL DEFAULT '',receipt JSONB,
 PRIMARY KEY(realm,id),
 CHECK(approved_by='' OR approved_by<>requested_by),
 CHECK(executed_by='' OR executed_by<>approved_by),
 CHECK((operation='restore' AND recovery_point<>'') OR (operation='key_destroy' AND recovery_point=''))
);
CREATE INDEX IF NOT EXISTS governance_recovery_requests_list ON governance_recovery_requests(realm,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS governance_recovery_audit (
 id BIGSERIAL PRIMARY KEY,realm TEXT NOT NULL,request_id TEXT NOT NULL,event TEXT NOT NULL CHECK(event IN ('requested','approved','claimed','succeeded','failed','uncertain','expired','revoked')),
 actor TEXT NOT NULL,revision BIGINT NOT NULL,fencing_token BIGINT NOT NULL,detail JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(realm,request_id) REFERENCES governance_recovery_requests(realm,id)
);
CREATE INDEX IF NOT EXISTS governance_recovery_audit_request ON governance_recovery_audit(realm,request_id,id);
