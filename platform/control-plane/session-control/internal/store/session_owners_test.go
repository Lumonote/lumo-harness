package store

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

func TestSessionOwnerReserveActivateAndIsolation(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	in := ReserveSessionOwner{Realm: "r", OwnerUserID: "u", ProjectID: "p", NodeID: "n"}
	o, token, err := s.ReserveSessionOwner(ctx, in)
	if err != nil || o.State != "reserved" || o.SessionRef == "" || len(token) != 64 {
		t.Fatalf("reserve %+v %v", o, err)
	}
	if _, err = s.ActivateSessionOwner(ctx, "r", o.SessionRef, strings.Repeat("a", 64)); !errors.Is(err, ErrOwnerConflict) {
		t.Fatalf("forged nonce: %v", err)
	}
	active, err := s.ActivateSessionOwner(ctx, "r", o.SessionRef, token)
	if err != nil || active.State != "active" {
		t.Fatalf("activate %+v %v", active, err)
	}
	replay, err := s.ActivateSessionOwner(ctx, "r", o.SessionRef, token)
	if err != nil || !replay.ActivatedAt.Equal(*active.ActivatedAt) {
		t.Fatalf("replay %+v %v", replay, err)
	}
	if _, err = s.SessionOwner(ctx, "foreign", o.SessionRef); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign read %v", err)
	}
	rows, err := s.SessionOwners(ctx, "r", "other", "n", "", 100)
	if err != nil || len(rows) != 0 {
		t.Fatalf("foreign list %+v %v", rows, err)
	}
	in.ParentSessionRef = o.SessionRef
	in.OwnerUserID = "attacker"
	if _, _, err = s.ReserveSessionOwner(ctx, in); !errors.Is(err, ErrOwnerConflict) {
		t.Fatalf("parent adoption %v", err)
	}
	in.OwnerUserID = "u"
	child, _, err := s.ReserveSessionOwner(ctx, in)
	if err != nil || child.ParentSessionRef != o.SessionRef || child.SessionRef == o.SessionRef {
		t.Fatalf("child %+v %v", child, err)
	}
	fresh := New(s.pool)
	got, err := fresh.SessionOwner(ctx, "r", o.SessionRef)
	if err != nil || got.OwnerUserID != "u" {
		t.Fatalf("restart %+v %v", got, err)
	}
}
func TestSessionOwnerReservationConcurrencyNeverReassigns(t *testing.T) {
	s := newStore(t)
	var wg sync.WaitGroup
	ids := sync.Map{}
	ctx := context.Background()
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			o, _, err := s.ReserveSessionOwner(ctx, ReserveSessionOwner{Realm: "r", OwnerUserID: "u", ProjectID: "p", NodeID: "n"})
			if err != nil {
				t.Error(err)
				return
			}
			if _, used := ids.LoadOrStore(o.SessionRef, true); used {
				t.Error("reused identity")
			}
		}()
	}
	wg.Wait()
}
func TestSessionOwnerValidation(t *testing.T) {
	s := &Store{}
	if _, _, err := s.ReserveSessionOwner(context.Background(), ReserveSessionOwner{}); !errors.Is(err, ErrOwnerInvalid) {
		t.Fatal(err)
	}
	if _, err := s.SessionOwners(context.Background(), "r", "u", "n", "", 101); !errors.Is(err, ErrOwnerInvalid) {
		t.Fatal(err)
	}
}
