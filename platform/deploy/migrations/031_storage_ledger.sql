-- Logical retained bytes; never authorizes object deletion.

CREATE TABLE IF NOT EXISTS platform_storage_limits (
 realm TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('realm','project')),scope_id TEXT NOT NULL,
 limit_bytes BIGINT CHECK(limit_bytes>=0),revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(realm,scope,scope_id),
 CHECK((scope='realm' AND scope_id='') OR (scope='project' AND scope_id<>''))
);
CREATE TABLE IF NOT EXISTS platform_storage_charges (
 realm TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('session-attachment','run-file','task-artifact','knowledge-file')),
 reference_id TEXT NOT NULL,project_id TEXT NOT NULL,bytes BIGINT NOT NULL CHECK(bytes>=0),
 object_key TEXT NOT NULL DEFAULT '',released_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(realm,kind,reference_id)
);
CREATE INDEX IF NOT EXISTS platform_storage_charges_project ON platform_storage_charges(realm,project_id);
CREATE TABLE IF NOT EXISTS platform_storage_coverage (
 producer TEXT PRIMARY KEY CHECK(producer IN ('session-attachment','run-file','task-artifact','knowledge-file')),
 completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
