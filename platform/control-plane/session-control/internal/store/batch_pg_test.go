package store

import (
	"context"
	"testing"
)

func TestControlsBatchRealmIsolation(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	_, err := s.pool.Exec(ctx, `INSERT INTO session_control_state (session_ref,realm,state)
       VALUES ('a','realm-a','awaiting-approval'),('b','realm-b','paused')`)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := s.Controls(ctx, "realm-a", []string{"a", "b", "missing"})
	if err != nil || len(rows) != 1 || rows[0].SessionRef != "a" {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
	if _, err := s.Load(ctx, "missing"); err != ErrNotFound {
		t.Fatalf("read registered a missing session: %v", err)
	}
	if _, err := s.Controls(ctx, "", []string{"a"}); err == nil {
		t.Fatal("blank realm accepted")
	}
	if _, err := s.Controls(ctx, "realm-a", make([]string, 101)); err == nil {
		t.Fatal("unbounded batch accepted")
	}
}

func TestTimelineForRealmFiltersBeforePagination(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	_, err := s.pool.Exec(ctx, `INSERT INTO session_control_audit
		(session_ref,realm,command,outcome,from_state,to_state) VALUES
		('s1','foreign','pause','denied','running','running'),
		('s1','a','pause','applied','running','paused'),
		('s1','foreign','resume','denied','paused','paused'),
		('s1','a','resume','applied','paused','running')`)
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.TimelineForRealm(ctx, "a", "s1", 0, 1)
	if err != nil || len(first) != 1 || first[0].Command != "pause" || first[0].Realm != "a" {
		t.Fatalf("first page=%+v err=%v", first, err)
	}
	second, err := s.TimelineForRealm(ctx, "a", "s1", first[0].ID, 1)
	if err != nil || len(second) != 1 || second[0].Command != "resume" || second[0].Realm != "a" {
		t.Fatalf("second page=%+v err=%v", second, err)
	}
	if _, err := s.TimelineForRealm(ctx, " ", "s1", 0, 1); err == nil {
		t.Fatal("blank realm accepted")
	}
}
