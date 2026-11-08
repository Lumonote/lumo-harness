-- Controlled in-memory repository scope; no live working-tree or arbitrary tool attestation.

ALTER TABLE governance_agent_presets ADD COLUMN IF NOT EXISTS output_profile TEXT NOT NULL DEFAULT 'platform-closed-text-v1';
ALTER TABLE governance_agent_presets DROP CONSTRAINT IF EXISTS governance_agent_presets_output_profile_check;
ALTER TABLE governance_agent_presets ADD CONSTRAINT governance_agent_presets_output_profile_check CHECK(output_profile IN ('platform-closed-text-v1','platform-closed-text-files-v1','platform-closed-repository-v1'));

CREATE TABLE IF NOT EXISTS governance_run_repository_snapshots (
 realm TEXT NOT NULL,run_id TEXT PRIMARY KEY REFERENCES governance_task_runs(id),
 digest TEXT NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS governance_repository_publications (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),realm TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id),run_id TEXT NOT NULL REFERENCES governance_task_runs(id),
 manifest_digest TEXT NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),actor TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','publishing','draft')),
 url TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),published_at TIMESTAMPTZ,
 UNIQUE(realm,run_id,manifest_digest)
);
