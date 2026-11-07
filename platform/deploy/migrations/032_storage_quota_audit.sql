
ALTER TABLE governance_auth_security_events DROP CONSTRAINT IF EXISTS governance_auth_security_events_event_check;
ALTER TABLE governance_auth_security_events ADD CONSTRAINT governance_auth_security_events_event_check
  CHECK (event IN ('login_succeeded','login_failed','login_locked','logout','session_revoked','sessions_revoked','password_changed','mfa_enabled','mfa_disabled','passkey_registered','passkey_removed','passkey_login','passkey_clone_detected','user_created','user_updated','credentials_reset','role_assigned','role_revoked','role_updated','department_updated','node_updated','skill_access_updated','oidc_login','oidc_linked','oidc_unlinked','role_permissions_updated','role_parent_updated','storage_quota_updated'));
