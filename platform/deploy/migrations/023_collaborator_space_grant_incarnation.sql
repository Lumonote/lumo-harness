-- Existing managed grants fail closed until an owner explicitly reauthorizes
-- their current revision. Never infer an old grant's resource incarnation.
ALTER TABLE collab_space_grants ADD COLUMN IF NOT EXISTS space_incarnation UUID;
ALTER TABLE collab_space_grant_audit ADD COLUMN IF NOT EXISTS space_incarnation UUID;
