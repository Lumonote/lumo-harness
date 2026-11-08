package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func seedUserSecurity(t *testing.T, s *Store) {
	t.Helper()
	seedRolePolicyAdmin(t, s)
	_, err := s.pool.Exec(context.Background(), `INSERT INTO governance_roles(realm,id,name,status,parent_role_id) VALUES
 ('realm','child','Child','active','realm_admin'),('realm','deny','Deny','active',NULL),('realm','operator','Operator','active',NULL);
 INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by,expires_at) VALUES
 ('realm','employee','child','manager',NULL),('realm','employee','deny','manager',NULL),('realm','employee','operator','manager',now()-interval '1 day');
 INSERT INTO governance_role_permissions VALUES ('realm','deny','task:delegate','deny');
 INSERT INTO governance_users(realm,id,display_name,status) VALUES ('other','employee','Foreign employee','active');
 INSERT INTO governance_auth_sessions(token_hash,session_id,realm,user_id,client_ip,expires_at) VALUES
 ('secret-hash-a','session-a','realm','employee','127.0.0.1',now()+interval '1 day'),
 ('secret-hash-b','session-b','realm','employee','127.0.0.2',now()+interval '1 day'),
 ('secret-hash-expired','session-expired','realm','employee','127.0.0.3',now()-interval '1 day'),
 ('secret-hash-foreign','session-foreign','other','employee','127.0.0.4',now()+interval '1 day');
 INSERT INTO governance_auth_security_events(realm,user_id,event,detail) VALUES
 ('realm','employee','user_created','{"actor":"manager"}'),('other','employee','login_succeeded','{}')`)
	if err != nil {
		t.Fatal(err)
	}
}

func TestManagedUserSecurityRoleExplanationAndIsolation(t *testing.T) {
	s := taskTestStore(t)
	seedUserSecurity(t, s)
	ctx := context.Background()
	overview, err := s.UserSecurity(ctx, "realm", "employee", "manager")
	if err != nil || overview.OrganizationAdmin || len(overview.Resolution.DirectRoles) != 2 || len(overview.Resolution.EffectiveRoles) != 3 {
		t.Fatalf("inheritance should not confer organization authority: %+v %v", overview, err)
	}
	if overview.Resolution.Actions[domain.ActionTaskDelegate].Allowed || !overview.Resolution.Actions[domain.ActionTaskDelegate].ExplicitDeny || !overview.Resolution.Actions[domain.ActionTaskExecutionUpdate].Allowed {
		t.Fatalf("deny override/expired grant explanation: %+v", overview)
	}
	page, err := s.UserSessions(ctx, "realm", "employee", "manager", UserSecurityPageOptions{Limit: 1})
	if err != nil || page.Total != 2 || !page.HasMore || len(page.Sessions) != 1 {
		t.Fatalf("first page: %+v %v", page, err)
	}
	second, err := s.UserSessions(ctx, "realm", "employee", "manager", UserSecurityPageOptions{Limit: 1, Offset: 1})
	if err != nil || second.HasMore || len(second.Sessions) != 1 || second.Sessions[0].ID == page.Sessions[0].ID {
		t.Fatalf("stable second page: %+v %v", second, err)
	}
	raw, _ := json.Marshal(page)
	if strings.Contains(string(raw), "secret-hash") || strings.Contains(string(raw), "token_hash") || strings.Contains(string(raw), "session-foreign") {
		t.Fatalf("session secret/realm leak: %s", raw)
	}
	if _, err = s.UserSecurity(ctx, "realm", "employee", "employee"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("inherited admin can inspect sensitive data: %v", err)
	}
	if _, err = s.UserSecurity(ctx, "other", "employee", "manager"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-realm admin: %v", err)
	}
	if _, err = s.UserSecurity(ctx, "realm", "missing", "manager"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing target: %v", err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE governance_users SET status='suspended' WHERE realm='realm' AND id='employee'`); err != nil {
		t.Fatal(err)
	}
	overview, err = s.UserSecurity(ctx, "realm", "employee", "manager")
	if err != nil || len(overview.Resolution.EffectiveRoles) != 0 || overview.Resolution.Actions[domain.ActionTaskExecutionUpdate].Allowed {
		t.Fatalf("suspended account retains active permission: %+v %v", overview, err)
	}
}

func TestManagedUserSessionRevocationAuditAndAtomicity(t *testing.T) {
	s := taskTestStore(t)
	seedUserSecurity(t, s)
	ctx := context.Background()
	if _, err := s.RevokeUserSessions(ctx, "realm", "employee", "session-foreign", "manager", "wrong realm"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign session revoked: %v", err)
	}
	if count, err := s.RevokeUserSessions(ctx, "realm", "employee", "session-a", "manager", "  device lost  "); err != nil || count != 1 {
		t.Fatalf("single revoke: %d %v", count, err)
	}
	page, err := s.UserSecurityEvents(ctx, "realm", "employee", "manager", UserSecurityPageOptions{Limit: 1})
	if err != nil || page.Total != 2 || !page.HasMore || page.Events[0].Event != "admin_session_revoked" || page.Events[0].Detail["actor"] != "manager" || page.Events[0].Detail["reason"] != "device lost" {
		t.Fatalf("audit page: %+v %v", page, err)
	}
	// Failure to persist the mandatory audit must roll back the session deletion.
	if _, err = s.pool.Exec(ctx, `ALTER TABLE governance_auth_security_events ADD CONSTRAINT test_reject_bulk CHECK (event <> 'admin_sessions_revoked')`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.RevokeUserSessions(ctx, "realm", "employee", "", "manager", "offboarding"); err == nil {
		t.Fatal("audit failure accepted")
	}
	sessions, err := s.UserSessions(ctx, "realm", "employee", "manager", UserSecurityPageOptions{})
	if err != nil || sessions.Total != 1 || sessions.Sessions[0].ID != "session-b" {
		t.Fatalf("audit failure left a partial revocation: %+v %v", sessions, err)
	}
	if _, err = s.pool.Exec(ctx, `ALTER TABLE governance_auth_security_events DROP CONSTRAINT test_reject_bulk`); err != nil {
		t.Fatal(err)
	}
	if count, err := s.RevokeUserSessions(ctx, "realm", "employee", "", "manager", "offboarding"); err != nil || count != 2 {
		t.Fatalf("bulk revoke includes expired rows: %d %v", count, err)
	}
	var foreign int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_auth_sessions WHERE realm='other'`).Scan(&foreign); err != nil || foreign != 1 {
		t.Fatalf("bulk revoke crossed realm: %d %v", foreign, err)
	}
}

func TestOrganizationWritesRevalidateAdministratorAfterLock(t *testing.T) {
	operations := map[string]func(*Store) error{
		"create_user": func(s *Store) error {
			_, err := s.CreateLocalUser(context.Background(), LocalUser{User: domain.User{Realm: "realm", ID: "new", DisplayName: "New"}, Username: "new", Password: "test-password-long"}, "manager")
			return err
		},
		"update_user": func(s *Store) error {
			_, err := s.UpsertUser(context.Background(), domain.User{Realm: "realm", ID: "employee", DisplayName: "Changed"}, "manager")
			return err
		},
		"reset_credentials": func(s *Store) error {
			return s.SetUserCredentials(context.Background(), "realm", "employee", "employee", "test-password-long", "manager")
		},
		"assign_role": func(s *Store) error {
			return s.AssignRole(context.Background(), "realm", "employee", "operator", "manager", nil)
		},
		"revoke_role": func(s *Store) error {
			return s.RevokeRole(context.Background(), "realm", "employee", "child", "manager")
		},
		"create_role": func(s *Store) error {
			_, err := s.CreateRole(context.Background(), domain.Role{Realm: "realm", ID: "new", Name: "New"}, "manager")
			return err
		},
		"update_role": func(s *Store) error {
			_, err := s.UpdateRole(context.Background(), domain.Role{Realm: "realm", ID: "child", Name: "Changed", Status: "active"}, "manager")
			return err
		},
		"create_department": func(s *Store) error {
			_, err := s.CreateDepartment(context.Background(), domain.Department{Realm: "realm", ID: "new", Name: "New"}, "manager")
			return err
		},
		"update_department": func(s *Store) error {
			_, err := s.UpdateDepartment(context.Background(), domain.Department{Realm: "realm", ID: "new", Name: "New", Status: "active"}, "manager")
			return err
		},
		"link_oidc": func(s *Store) error {
			s.SetOIDCProvider("https://id.example.test", "realm")
			return s.LinkOIDCUser(context.Background(), "realm", "employee", "https://id.example.test", "employee", "manager")
		},
		"unlink_oidc": func(s *Store) error { return s.UnlinkOIDCUser(context.Background(), "realm", "employee", "manager") },
		"revoke_session": func(s *Store) error {
			_, err := s.RevokeUserSessions(context.Background(), "realm", "employee", "session-a", "manager", "device lost")
			return err
		},
		"read_security": func(s *Store) error {
			_, err := s.UserSecurity(context.Background(), "realm", "employee", "manager")
			return err
		},
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			s := taskTestStore(t)
			seedUserSecurity(t, s)
			ctx := context.Background()
			blocker, err := s.beginOrganizationChange(ctx, "realm")
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(ctx)
			result := make(chan error, 1)
			go func() { result <- operation(s) }()
			select {
			case err := <-result:
				t.Fatalf("operation bypassed lock: %v", err)
			case <-time.After(150 * time.Millisecond):
			}
			if _, err := blocker.Exec(ctx, `DELETE FROM governance_user_roles WHERE realm='realm' AND user_id='manager'`); err != nil {
				t.Fatal(err)
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-result:
				if !errors.Is(err, ErrForbidden) {
					t.Fatalf("revoked admin retained authority: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("operation did not finish")
			}
		})
	}
}

func TestUserSecurityRejectsInvalidRequestsBeforeDatabaseAccess(t *testing.T) {
	s := &Store{}
	for _, options := range []UserSecurityPageOptions{{Limit: -1}, {Limit: 101}, {Offset: -1}, {Offset: 1_000_001}} {
		if _, err := s.UserSessions(context.Background(), "realm", "user", "admin", options); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("invalid page: %+v %v", options, err)
		}
		if _, err := s.UserSecurityEvents(context.Background(), "realm", "user", "admin", options); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("invalid event page: %+v %v", options, err)
		}
	}
	for _, reason := range []string{"", "  ", strings.Repeat("界", 501)} {
		if _, err := s.RevokeUserSessions(context.Background(), "realm", "user", "", "admin", reason); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("invalid reason accepted: %v", err)
		}
	}
}

func TestUserSecurityAuditMigrationAndStartupPreserveHistory(t *testing.T) {
	s := taskTestStore(t)
	seedRolePolicyAdmin(t, s)
	ctx := context.Background()
	// Simulate a database deployed before this capability, including quota audit.
	previous, err := os.ReadFile("../../../../deploy/migrations/032_storage_quota_audit.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, string(previous)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `INSERT INTO governance_auth_security_events(realm,user_id,event) VALUES ('realm','manager','storage_quota_updated')`); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../../../deploy/migrations/034_user_security_audit.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateRole(ctx, domain.Role{Realm: "realm", ID: "audited", Name: "Audited"}, "manager"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateDepartment(ctx, domain.Department{Realm: "realm", ID: "audited", Name: "Audited"}, "manager"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.RevokeUserSessions(ctx, "realm", "employee", "", "manager", "acceptance"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `INSERT INTO governance_auth_security_events(realm,user_id,event) VALUES ('realm','employee','admin_session_revoked')`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("reapply with new history: %v", err)
	}
	if err = s.Init(ctx); err != nil {
		t.Fatalf("startup with new history: %v", err)
	}
	var count int
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_auth_security_events`).Scan(&count); err != nil || count != 5 {
		t.Fatalf("history lost: %d %v", count, err)
	}
	if _, err = s.pool.Exec(ctx, `INSERT INTO governance_auth_security_events(realm,event) VALUES ('realm','undefined_event')`); err == nil {
		t.Fatal("event constraint removed")
	}
}
