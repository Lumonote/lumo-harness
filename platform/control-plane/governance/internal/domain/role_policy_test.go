package domain

import (
	"fmt"
	"reflect"
	"testing"
)

func TestRolePolicyInheritanceDenyAndAdministratorBoundary(t *testing.T) {
	catalog := []RolePolicyFact{
		{RoleID: "editor", ParentRoleID: "operator", Status: "active", Permissions: []RolePermission{{ActionTaskDelegate, "deny"}}},
		{RoleID: "operator", ParentRoleID: "realm_admin", Status: "active"},
		{RoleID: "realm_admin", Status: "active"},
		{RoleID: "assistant", Status: "active", Permissions: []RolePermission{{ActionTaskDelegate, "allow"}}},
	}
	got, err := ResolveRolePolicy([]string{"editor", "assistant", "editor"}, catalog)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.DirectRoles, []string{"assistant", "editor"}) {
		t.Fatalf("direct credentials expanded: %+v", got)
	}
	if !reflect.DeepEqual(got.EffectiveRoles, []string{"assistant", "editor", "operator", "realm_admin"}) {
		t.Fatalf("inheritance missing: %+v", got)
	}
	if got.Actions[ActionTaskDelegate].Allowed || !got.Actions[ActionTaskDelegate].ExplicitDeny {
		t.Fatalf("deny did not override all allow/defaults: %+v", got)
	}
	if !got.Actions[ActionTaskExecutionUpdate].Allowed {
		t.Fatal("inherited action was lost")
	}
	catalog[0].Permissions = nil
	got, err = ResolveRolePolicy([]string{"editor"}, catalog)
	if err != nil || !got.Actions[ActionTaskDelegate].Allowed {
		t.Fatalf("inherit did not restore defaults: %+v %v", got, err)
	}
	catalog[1].Status = "disabled"
	got, err = ResolveRolePolicy([]string{"editor"}, catalog)
	if err != nil || len(got.EffectiveRoles) != 1 || got.Actions[ActionTaskDelegate].Allowed {
		t.Fatalf("disabled parent did not truncate: %+v %v", got, err)
	}
	// Existing installations may send built-in roles before seeding the catalog.
	got, err = ResolveRolePolicy([]string{"manager", "unregistered"}, nil)
	if err != nil || !got.Actions[ActionTaskDelegate].Allowed || got.Actions[ActionTaskExecutionUpdate].Allowed {
		t.Fatalf("legacy compatibility: %+v %v", got, err)
	}
}

func TestRolePolicyHierarchyRejectsCyclesMissingParentsAndDeepDescendants(t *testing.T) {
	catalog := []RolePolicyFact{}
	for i := 0; i < MaxRoleDepth; i++ {
		parent := ""
		if i > 0 {
			parent = fmt.Sprintf("r%d", i-1)
		}
		catalog = append(catalog, RolePolicyFact{RoleID: fmt.Sprintf("r%d", i), ParentRoleID: parent, Status: "active"})
	}
	if err := ValidateRoleHierarchy(catalog); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveRolePolicy([]string{"r31"}, catalog); err != nil {
		t.Fatal(err)
	}
	catalog[0].ParentRoleID = "r31"
	if err := ValidateRoleHierarchy(catalog); err == nil {
		t.Fatal("cycle accepted")
	}
	if _, err := ResolveRolePolicy([]string{"r31"}, catalog); err == nil {
		t.Fatal("runtime cycle accepted")
	}
	catalog[0].ParentRoleID = "new"
	catalog = append(catalog, RolePolicyFact{RoleID: "new", Status: "active"})
	if err := ValidateRoleHierarchy(catalog); err == nil {
		t.Fatal("reparenting made an existing descendant exceed the limit")
	}
	if _, err := ResolveRolePolicy([]string{"r31"}, catalog); err == nil {
		t.Fatal("runtime depth overflow accepted")
	}
	catalog[0].ParentRoleID = "missing"
	if err := ValidateRoleHierarchy(catalog); err == nil {
		t.Fatal("missing ancestor accepted")
	}
	if _, err := ResolveRolePolicy([]string{"r1"}, catalog); err == nil {
		t.Fatal("runtime missing ancestor accepted")
	}
}
