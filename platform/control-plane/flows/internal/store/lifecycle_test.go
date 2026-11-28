package store

import (
	"testing"

	"github.com/lumo-harness/platform/flows/internal/domain"
)

func TestMutationAuthorityUsesCurrentMembershipAndPublishedGovernance(t *testing.T) {
	f := &domain.Flow{Realm: "r", Author: "author", Status: domain.StatusDraft}
	author := MutationActor{Realm: "r", UserID: "author"}
	for _, action := range []string{"edit", domain.EventSubmit, domain.EventDeprecate} {
		if !CanMutateFlow(f, action, domain.RoleEditor, true, author) {
			t.Errorf("editor cannot %s own draft", action)
		}
		for _, role := range []string{"", "viewer"} {
			if CanMutateFlow(f, action, role, true, author) {
				t.Errorf("%s retained %s", role, action)
			}
		}
		if CanMutateFlow(f, action, domain.RoleEditor, false, author) {
			t.Errorf("archived project retained %s", action)
		}
	}
	f.Status = domain.StatusPublished
	if CanMutateFlow(f, domain.EventDeprecate, domain.RoleEditor, true, author) {
		t.Fatal("published author bypassed governance")
	}
	if !CanMutateFlow(f, domain.EventDeprecate, domain.RoleOwner, true, author) {
		t.Fatal("owner cannot deprecate")
	}
	author.Admin = true
	if !CanMutateFlow(f, domain.EventDeprecate, "viewer", true, author) {
		t.Fatal("current admin member cannot deprecate")
	}
	author.Realm = "other"
	if CanMutateFlow(f, domain.EventDeprecate, domain.RoleOwner, true, author) {
		t.Fatal("cross realm mutation")
	}
}
