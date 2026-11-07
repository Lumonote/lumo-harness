-- Single-source role action facts and same-realm inheritance.
ALTER TABLE governance_roles ADD COLUMN IF NOT EXISTS parent_role_id TEXT;
ALTER TABLE governance_roles ADD COLUMN IF NOT EXISTS permission_revision BIGINT NOT NULL DEFAULT 1;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='governance_roles_parent_fkey' AND conrelid='governance_roles'::regclass) THEN
  ALTER TABLE governance_roles ADD CONSTRAINT governance_roles_parent_fkey FOREIGN KEY(realm,parent_role_id) REFERENCES governance_roles(realm,id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='governance_roles_parent_check' AND conrelid='governance_roles'::regclass) THEN
  ALTER TABLE governance_roles ADD CONSTRAINT governance_roles_parent_check CHECK(parent_role_id IS NULL OR parent_role_id<>id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='governance_roles_permission_revision_check' AND conrelid='governance_roles'::regclass) THEN
  ALTER TABLE governance_roles ADD CONSTRAINT governance_roles_permission_revision_check CHECK(permission_revision>0);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS governance_role_permissions (
 realm TEXT NOT NULL,role_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('task:delegate','task:execution:update')),
 effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
 PRIMARY KEY(realm,role_id,action),
 FOREIGN KEY(realm,role_id) REFERENCES governance_roles(realm,id) ON DELETE CASCADE
);

-- Upgrade the pre-existing event CHECK as well as fresh databases.
ALTER TABLE governance_auth_security_events DROP CONSTRAINT IF EXISTS governance_auth_security_events_event_check;
ALTER TABLE governance_auth_security_events ADD CONSTRAINT governance_auth_security_events_event_check
  CHECK (event IN ('login_succeeded','login_failed','login_locked','logout','session_revoked','sessions_revoked','password_changed','mfa_enabled','mfa_disabled','passkey_registered','passkey_removed','passkey_login','passkey_clone_detected','user_created','user_updated','credentials_reset','role_assigned','role_revoked','role_updated','department_updated','node_updated','skill_access_updated','oidc_login','oidc_linked','oidc_unlinked','role_permissions_updated','role_parent_updated'));
