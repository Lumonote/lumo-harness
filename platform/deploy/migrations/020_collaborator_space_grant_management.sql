-- Collaborator owns Space grants. Projects/Governance tables are only read
-- by this service; all deployed services already share LUMO_PG_DSN.
ALTER TABLE collab_space_grants ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE collab_space_grants ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS collab_space_grant_audit (
  realm TEXT NOT NULL,
  space TEXT NOT NULL,
  subject TEXT NOT NULL,
  revision BIGINT NOT NULL,
  project_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  permissions TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, space, subject, revision)
);
