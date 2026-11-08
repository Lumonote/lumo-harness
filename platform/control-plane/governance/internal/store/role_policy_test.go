package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func seedRolePolicyAdmin(t *testing.T, s *Store) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO governance_roles(realm,id,name,status) VALUES('realm','realm_admin','Admin','active'); INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('realm','manager','realm_admin','manager')`); err != nil {
		t.Fatal(err)
	}
}
func policyRole(t *testing.T, s *Store, id string) domain.Role {
	t.Helper()
	r, err := s.CreateRole(context.Background(), domain.Role{Realm: "realm", ID: id, Name: id, Status: "active"}, "manager")
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func TestRolePolicyTransactionsInheritanceCASAndAudit(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedRolePolicyAdmin(t, s)
	policyRole(t, s, "operator")
	policyRole(t, s, "child")
	state, err := s.SetRoleParent(ctx, "realm", "child", "operator", "manager", 1)
	if err != nil || state.Revision != 2 || !state.Resolution.Actions[domain.ActionTaskExecutionUpdate].Allowed {
		t.Fatalf("parent: %+v %v", state, err)
	}
	state, err = s.SetRolePermissions(ctx, "realm", "child", "manager", 2, []domain.RolePermission{{Action: domain.ActionTaskDelegate, Effect: "deny"}})
	if err != nil || state.Revision != 3 || state.Resolution.Actions[domain.ActionTaskDelegate].Allowed {
		t.Fatalf("deny: %+v %v", state, err)
	}
	if _, err = s.SetRolePermissions(ctx, "realm", "child", "manager", 2, nil); !errors.Is(err, ErrRolePolicyChanged) {
		t.Fatalf("stale CAS: %v", err)
	}
	state, err = s.SetRolePermissions(ctx, "realm", "child", "manager", 3, []domain.RolePermission{{Action: domain.ActionTaskDelegate, Effect: "inherit"}})
	if err != nil || len(state.Permissions) != 0 || !state.Resolution.Actions[domain.ActionTaskDelegate].Allowed {
		t.Fatalf("clear rule: %+v %v", state, err)
	}
	// Independent writers sharing one baseline must never both commit.
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, effect := range []string{"allow", "deny"} {
		wg.Add(1)
		go func(effect string) {
			defer wg.Done()
			_, e := s.SetRolePermissions(ctx, "realm", "child", "manager", state.Revision, []domain.RolePermission{{Action: domain.ActionTaskDelegate, Effect: effect}})
			errs <- e
		}(effect)
	}
	wg.Wait()
	close(errs)
	success, changed := 0, 0
	for err := range errs {
		if err == nil {
			success++
		} else if errors.Is(err, ErrRolePolicyChanged) {
			changed++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || changed != 1 {
		t.Fatalf("CAS winners %d changed %d", success, changed)
	}
	var audits int
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_auth_security_events WHERE realm='realm' AND event IN ('role_permissions_updated','role_parent_updated') AND detail->>'actor'='manager' AND detail->'before' IS NOT NULL AND detail->'after' IS NOT NULL`).Scan(&audits); err != nil || audits != 4 {
		t.Fatalf("transaction audit count=%d err=%v", audits, err)
	}
	if _, err = s.UpdateRole(ctx, domain.Role{Realm: "realm", ID: "operator", Name: "Operator", Status: "disabled"}, "manager"); err != nil {
		t.Fatal(err)
	}
	resolved, err := s.ResolveRoles(ctx, "realm", []string{"child"})
	if err != nil || len(resolved.EffectiveRoles) != 1 || resolved.Actions[domain.ActionTaskExecutionUpdate].Allowed {
		t.Fatalf("disabled ancestor: %+v %v", resolved, err)
	}
	for _, rules := range [][]domain.RolePermission{{{Action: "unknown", Effect: "allow"}}, {{Action: domain.ActionTaskDelegate, Effect: "admin"}}, {{Action: domain.ActionTaskDelegate, Effect: "allow"}, {Action: domain.ActionTaskDelegate, Effect: "deny"}}} {
		if _, err = s.SetRolePermissions(ctx, "realm", "child", "manager", 5, rules); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("invalid rules accepted: %+v %v", rules, err)
		}
	}
}

func TestRolePolicyHierarchyIsolationAndDirectAdministrator(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedRolePolicyAdmin(t, s)
	for i := 0; i < domain.MaxRoleDepth; i++ {
		id := fmt.Sprintf("r%d", i)
		policyRole(t, s, id)
		if i > 0 {
			if _, err := s.SetRoleParent(ctx, "realm", id, fmt.Sprintf("r%d", i-1), "manager", 1); err != nil {
				t.Fatal(err)
			}
		}
	}
	policyRole(t, s, "extra")
	for _, parent := range []string{"r31", "extra"} {
		if _, err := s.SetRoleParent(ctx, "realm", "r0", parent, "manager", 1); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("cycle/deep reparent accepted: %s %v", parent, err)
		}
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_roles(realm,id,name,status) VALUES('foreign','foreign-role','Foreign','active')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetRoleParent(ctx, "realm", "r0", "foreign-role", "manager", 1); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("cross-realm parent: %v", err)
	}
	if _, err := s.SetRolePermissions(ctx, "foreign", "foreign-role", "manager", 1, nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-realm actor accepted: %v", err)
	}
	if _, err := s.SetRoleParent(ctx, "realm", "extra", "realm_admin", "manager", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('realm','employee','extra','manager')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetRolePermissions(ctx, "realm", "r0", "employee", 1, nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("inherited admin authorized policy mutation: %v", err)
	}
	// A role status update invalidates a permission draft too.
	if _, err := s.UpdateRole(ctx, domain.Role{Realm: "realm", ID: "r0", Name: "Renamed", Status: "active"}, "manager"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetRolePermissions(ctx, "realm", "r0", "manager", 1, nil); !errors.Is(err, ErrRolePolicyChanged) {
		t.Fatalf("metadata revision did not invalidate draft: %v", err)
	}
}

func TestRolePolicyRevalidatesAdministratorAfterRealmLock(t *testing.T) {
	for _, operation := range []string{"permissions", "parent"} {
		t.Run(operation, func(t *testing.T) {
			s := taskTestStore(t)
			ctx := context.Background()
			seedRolePolicyAdmin(t, s)
			policyRole(t, s, "custom")
			blocker, err := s.beginOrganizationChange(ctx, "realm")
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(ctx)
			result := make(chan error, 1)
			go func() {
				var err error
				if operation == "permissions" {
					_, err = s.SetRolePermissions(ctx, "realm", "custom", "manager", 1, nil)
				} else {
					_, err = s.SetRoleParent(ctx, "realm", "custom", "realm_admin", "manager", 1)
				}
				result <- err
			}()
			// Both writes must queue behind the administrative transaction.
			select {
			case err := <-result:
				t.Fatalf("write bypassed Realm lock: %v", err)
			case <-time.After(100 * time.Millisecond):
			}
			if _, err = blocker.Exec(ctx, `DELETE FROM governance_user_roles WHERE realm='realm' AND user_id='manager' AND role_id='realm_admin'`); err != nil {
				t.Fatal(err)
			}
			if err = blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err = <-result:
				if !errors.Is(err, ErrForbidden) {
					t.Fatalf("stale administrator wrote after revoke: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("pending write did not finish")
			}
			state, err := s.RolePolicy(ctx, "realm", "custom")
			if err != nil || state.Revision != 1 {
				t.Fatalf("denied write changed policy: %+v %v", state, err)
			}
		})
	}
}

func TestRolePolicySkillsAndPrincipalsShareInheritanceWithoutCredentialExpansion(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedRolePolicyAdmin(t, s)
	policyRole(t, s, "custom")
	if _, err := s.SetRoleParent(ctx, "realm", "custom", "realm_admin", "manager", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('realm','employee','custom','manager');
 INSERT INTO governance_skills(realm,id,name,kind,current_version,created_by) VALUES('realm','inherited-skill','Inherited skill','prompt','1.0.0','manager');
 INSERT INTO governance_skill_grants(id,realm,skill_id,subject_type,subject_id,granted_by) VALUES('inherited-grant','realm','inherited-skill','role','realm_admin','manager')`); err != nil {
		t.Fatal(err)
	}
	for _, principalReader := range []func(context.Context, string, string) (AuthPrincipal, error){s.authPrincipal, s.RuntimeThreadPrincipal} {
		principal, err := principalReader(ctx, "realm", "employee")
		if err != nil || len(principal.Roles) != 1 || principal.Roles[0] != "custom" || len(principal.EffectiveRoles) != 2 {
			t.Fatalf("inherited role promoted into direct credentials: %+v %v", principal, err)
		}
	}
	skills, err := s.EffectiveSkills(ctx, "realm", "employee", "")
	if err != nil || len(skills) != 1 || skills[0].SkillID != "inherited-skill" {
		t.Fatalf("skill inheritance inconsistent: %+v %v", skills, err)
	}
	if _, err := s.UpdateRole(ctx, domain.Role{Realm: "realm", ID: "realm_admin", Name: "Admin", Status: "disabled"}, "manager"); err != nil {
		t.Fatal(err)
	}
	skills, err = s.EffectiveSkills(ctx, "realm", "employee", "")
	if err != nil || len(skills) != 0 {
		t.Fatalf("disabled ancestor skill remained effective: %+v %v", skills, err)
	}
}

func TestRolePolicyAuditEventUpgradePreservesOldHistoryAndNewEvents(t *testing.T) {
	for _, mode := range []string{"startup", "migration"} {
		t.Run(mode, func(t *testing.T) {
			s := taskTestStore(t)
			ctx := context.Background()
			seedRolePolicyAdmin(t, s)
			policyRole(t, s, "custom")
			// Reproduce an already-deployed CHECK that predates role policy events.
			if _, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_security_events WHERE event='role_created';
 ALTER TABLE governance_auth_security_events DROP CONSTRAINT governance_auth_security_events_event_check;
 ALTER TABLE governance_auth_security_events ADD CONSTRAINT governance_auth_security_events_event_check CHECK(event IN ('login_succeeded','login_failed','role_assigned'));
 INSERT INTO governance_auth_security_events(realm,user_id,event) VALUES('realm','manager','login_succeeded')`); err != nil {
				t.Fatal(err)
			}
			upgrade := func() error { return s.Init(ctx) }
			if mode == "migration" {
				migration, err := os.ReadFile("../../../../deploy/migrations/021_governance_role_policies.sql")
				if err != nil {
					t.Fatal(err)
				}
				upgrade = func() error { _, err := s.pool.Exec(ctx, string(migration)); return err }
			}
			if err := upgrade(); err != nil {
				t.Fatalf("legacy CHECK upgrade: %v", err)
			}
			if _, err := s.SetRolePermissions(ctx, "realm", "custom", "manager", 1, []domain.RolePermission{{Action: domain.ActionTaskDelegate, Effect: "allow"}}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.SetRoleParent(ctx, "realm", "custom", "realm_admin", "manager", 2); err != nil {
				t.Fatal(err)
			}
			// Restart/reapply after new events have been persisted. A stale CHECK in any
			// earlier startup phase must not narrow the enum and reject this history.
			if err := upgrade(); err != nil {
				t.Fatalf("reapply with role policy history: %v", err)
			}
			if err := s.Init(ctx); err != nil {
				t.Fatalf("startup after migration with role policy history: %v", err)
			}
			var count int
			if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_auth_security_events WHERE realm='realm' AND user_id='manager' AND event IN ('login_succeeded','role_permissions_updated','role_parent_updated')`).Scan(&count); err != nil || count != 3 {
				t.Fatalf("old/new audit history count=%d err=%v", count, err)
			}
			if _, err := s.pool.Exec(ctx, `INSERT INTO governance_auth_security_events(realm,event) VALUES('realm','undefined_policy_event')`); err == nil {
				t.Fatal("audit CHECK was removed instead of upgraded")
			}
		})
	}
}
