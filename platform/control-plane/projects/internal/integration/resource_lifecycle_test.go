package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/lumo-harness/platform/projects/internal/domain"
	"github.com/lumo-harness/platform/projects/internal/store"
)

func TestSpaceRenameAndDetachUseScopeAndSnapshot(t *testing.T) {
	st, _ := newStore(t)
	ctx := context.Background()
	for _, id := range []string{"one", "two"} {
		if _, err := st.CreateProject(ctx, id, "realm", id, "owner"); err != nil {
			t.Fatal(err)
		}
	}
	for _, space := range []domain.Space{{ID: "space", ProjectID: "one", Realm: "realm", Name: "Before"}, {ID: "other", ProjectID: "one", Realm: "realm", Name: "Taken"}} {
		if err := st.UpsertSpace(ctx, space); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.RenameSpace(ctx, "two", "space", "Foreign", "Before"); !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	if _, err := st.RenameSpace(ctx, "one", "space", "After", "Before"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RenameSpace(ctx, "one", "space", "Overwrite", "Before"); !errors.Is(err, store.ErrResourceStale) {
		t.Fatal(err)
	}
	if _, err := st.RenameSpace(ctx, "one", "space", "Taken", "After"); !errors.Is(err, store.ErrResourceConflict) {
		t.Fatal(err)
	}
	if err := st.DeleteSpace(ctx, "one", "space", "Before"); !errors.Is(err, store.ErrResourceStale) {
		t.Fatal(err)
	}
	if err := st.DeleteSpace(ctx, "two", "space", "After"); !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, "one", "archive"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteSpace(ctx, "one", "space", "After"); !errors.Is(err, store.ErrArchived) {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, "one", "unarchive"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteSpace(ctx, "one", "space", "After"); err != nil {
		t.Fatal(err)
	}
	spaces, err := st.ListSpaces(ctx, "one")
	if err != nil || len(spaces) != 1 || spaces[0].ID != "other" {
		t.Fatalf("%+v %v", spaces, err)
	}
}

func TestAutomationLifecycleUsesRevisionAndLegacyWritesAdvanceIt(t *testing.T) {
	st, _ := newStore(t)
	ctx := context.Background()
	for _, id := range []string{"one", "two"} {
		if _, err := st.CreateProject(ctx, id, "realm", id, "owner"); err != nil {
			t.Fatal(err)
		}
	}
	a := domain.Automation{ID: "automation", ProjectID: "one", TriggerKind: "event", TriggerSpec: "task.done", FlowRef: "flow", Enabled: true}
	saved, err := st.CreateAutomation(ctx, a)
	if err != nil || saved.Revision != 1 {
		t.Fatalf("create %+v %v", saved, err)
	}
	if _, err := st.CreateAutomation(ctx, a); !errors.Is(err, store.ErrResourceConflict) {
		t.Fatal(err)
	}
	a.ProjectID = "two"
	if _, err := st.UpdateAutomation(ctx, a, 1); !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	a.ProjectID = "one"
	a.Enabled = false
	saved, err = st.UpdateAutomation(ctx, a, 1)
	if err != nil || saved.Revision != 2 || saved.Enabled {
		t.Fatalf("update %+v %v", saved, err)
	}
	if _, err := st.UpdateAutomation(ctx, a, 1); !errors.Is(err, store.ErrResourceStale) {
		t.Fatal(err)
	}
	if err := st.UpsertAutomation(ctx, a); err != nil {
		t.Fatal(err)
	}
	items, err := st.ListAutomations(ctx, "one")
	if err != nil || len(items) != 1 || items[0].Revision != 3 {
		t.Fatalf("legacy update revision %+v %v", items, err)
	}
	old := int64(2)
	if err := st.DeleteAutomationVersion(ctx, "one", a.ID, &old); !errors.Is(err, store.ErrResourceStale) {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, "one", "archive"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpdateAutomation(ctx, a, 3); !errors.Is(err, store.ErrArchived) {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, "one", "unarchive"); err != nil {
		t.Fatal(err)
	}
	current := int64(3)
	if err := st.DeleteAutomationVersion(ctx, "one", a.ID, &current); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteAutomation(ctx, "one", a.ID); err != nil {
		t.Fatal(err)
	}
}

func TestArtifactVersionCompareAndSwapAndDetach(t *testing.T) {
	st, _ := newStore(t)
	ctx := context.Background()
	for _, id := range []string{"one", "two"} {
		if _, err := st.CreateProject(ctx, id, "realm", id, "owner"); err != nil {
			t.Fatal(err)
		}
	}
	item := domain.Artifact{ProjectID: "one", Kind: "skill", Name: "review", Version: "1"}
	empty := ""
	if err := st.SaveArtifact(ctx, item, &empty); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveArtifact(ctx, item, &empty); !errors.Is(err, store.ErrResourceStale) {
		t.Fatal(err)
	}
	before := "1"
	item.Version = "2"
	if err := st.SaveArtifact(ctx, item, &before); err != nil {
		t.Fatal(err)
	}
	item.Version = "3"
	if err := st.SaveArtifact(ctx, item, &before); !errors.Is(err, store.ErrResourceStale) {
		t.Fatal(err)
	}
	if err := st.DeleteArtifact(ctx, "two", item.Kind, item.Name, "2"); !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	if err := st.DeleteArtifact(ctx, "one", item.Kind, item.Name, "1"); !errors.Is(err, store.ErrResourceStale) {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, "one", "archive"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteArtifact(ctx, "one", item.Kind, item.Name, "2"); !errors.Is(err, store.ErrArchived) {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, "one", "unarchive"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteArtifact(ctx, "one", item.Kind, item.Name, "2"); err != nil {
		t.Fatal(err)
	}
	items, err := st.ListArtifacts(ctx, "one")
	if err != nil || len(items) != 0 {
		t.Fatalf("%+v %v", items, err)
	}
}
