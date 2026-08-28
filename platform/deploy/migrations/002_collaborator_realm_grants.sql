-- Keep collaborator grants tenant-scoped. The original local-lite DDL used
-- (space, subject), which could make two realms collide on the same space id.
CREATE TABLE IF NOT EXISTS collab_space_grants (
  space       TEXT NOT NULL,
  realm       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  permissions TEXT[] NOT NULL,
  PRIMARY KEY (realm, space, subject)
);

ALTER TABLE collab_space_grants
  DROP CONSTRAINT IF EXISTS collab_space_grants_pkey;

ALTER TABLE collab_space_grants
  ADD CONSTRAINT collab_space_grants_pkey PRIMARY KEY (realm, space, subject);
