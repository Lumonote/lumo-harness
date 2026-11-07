-- Controlled UTF-8 file output and independently read review evidence.

ALTER TABLE governance_agent_presets ADD COLUMN IF NOT EXISTS output_profile TEXT NOT NULL DEFAULT 'platform-closed-text-v1';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='governance_agent_presets_output_profile_check' AND conrelid='governance_agent_presets'::regclass) THEN
 ALTER TABLE governance_agent_presets ADD CONSTRAINT governance_agent_presets_output_profile_check CHECK(output_profile IN ('platform-closed-text-v1','platform-closed-text-files-v1'));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS governance_run_file_blobs (
 realm TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES governance_task_runs(id),entry_id TEXT NOT NULL,
 name TEXT NOT NULL,media_type TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 32768),
 sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),body BYTEA NOT NULL CHECK(octet_length(body)=bytes),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(run_id,entry_id)
);
CREATE INDEX IF NOT EXISTS governance_run_file_blobs_realm ON governance_run_file_blobs(realm,run_id);
CREATE TABLE IF NOT EXISTS governance_review_file_reads (
 realm TEXT NOT NULL,review_run_id TEXT NOT NULL REFERENCES governance_run_reviews(review_run_id),
 producer_run_id TEXT NOT NULL,entry_id TEXT NOT NULL,manifest_digest TEXT NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
 receipt TEXT NOT NULL CHECK(receipt ~ '^[0-9a-f]{64}$'),node_id TEXT NOT NULL,session_ref TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(review_run_id,entry_id),
 FOREIGN KEY(producer_run_id,entry_id) REFERENCES governance_run_file_blobs(run_id,entry_id)
);
