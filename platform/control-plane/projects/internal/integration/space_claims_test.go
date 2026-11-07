package integration_test

import (
	"context"
	"testing"

	"github.com/lumo-harness/platform/projects/internal/domain"
)

func TestSpaceIncarnationAndClaimsSurviveDetachAndProjectDeletion(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	if _, err := st.CreateProject(ctx, "p", "realm", "P", "owner"); err != nil {
		t.Fatal(err)
	}
	space := domain.Space{ID: "s", ProjectID: "p", Realm: "realm", Name: "Before"}
	if err := st.UpsertSpace(ctx, space); err != nil {
		t.Fatal(err)
	}
	var first, renamed, recreated string
	if err := pool.QueryRow(ctx, `SELECT incarnation::text FROM project_spaces WHERE space_id='s'`).Scan(&first); err != nil {
		t.Fatal(err)
	}
	space.Name = "After"
	if err := st.UpsertSpace(ctx, space); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT incarnation::text FROM project_spaces WHERE space_id='s'`).Scan(&renamed); err != nil || renamed != first {
		t.Fatalf("upsert replaced incarnation: %s %s %v", first, renamed, err)
	}
	if err := st.DeleteSpace(ctx, "p", "s", "After"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM project_space_claims WHERE realm='realm' AND space_id='s'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("claim lost after detach: %d %v", count, err)
	}
	if err := st.UpsertSpace(ctx, space); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT incarnation::text FROM project_spaces WHERE space_id='s'`).Scan(&recreated); err != nil || recreated == first {
		t.Fatalf("recreation reused incarnation: %s %s %v", first, recreated, err)
	}
	// Project deletion requires the normal archive transition first.
	if _, err := st.Transition(ctx, "p", "archive"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteProject(ctx, "p"); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM project_space_claims WHERE realm='realm' AND space_id='s'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("claim cascaded with project: %d %v", count, err)
	}
}
