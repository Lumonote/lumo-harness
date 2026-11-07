package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/hub"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

func TestDocumentWALFencesStaleWriterAndSnapshotAfterTakeover(t *testing.T) {
	st, pool := newPGStore(t)
	ctx := context.Background()
	doc := domain.Document{ID: "fenced-document", Realm: "r1", Space: "s1"}
	if err := st.EnsureDocument(ctx, doc); err != nil {
		t.Fatal(err)
	}
	a, err := st.AcquireDocumentLease(ctx, doc.ID, "A:boot1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AcquireDocumentLease(ctx, doc.ID, "B:boot1"); !errors.Is(err, store.ErrDocumentFenced) {
		t.Fatalf("live owner must exclude B: %v", err)
	}
	if seq, err := st.AppendDocumentWAL(ctx, a, domain.Update{DocID: doc.ID, Actor: "alice", Payload: []byte("a")}); err != nil || seq != 1 {
		t.Fatalf("append1: %d %v", seq, err)
	}
	// Pause A after it has captured/merged seq1; B takes over an expired lease.
	if _, err := pool.Exec(ctx, `UPDATE collab_document_runtime SET expires_at='-infinity' WHERE doc_id=$1`, string(doc.ID)); err != nil {
		t.Fatal(err)
	}
	if err := st.RenewDocumentLease(ctx, a); !errors.Is(err, store.ErrDocumentFenced) {
		t.Fatalf("expired owner must not renew: %v", err)
	}
	b, err := st.AcquireDocumentLease(ctx, doc.ID, "B:boot1")
	if err != nil {
		t.Fatal(err)
	}
	if b.Epoch <= a.Epoch {
		t.Fatal("takeover must advance epoch")
	}
	if _, err := st.AppendDocumentWAL(ctx, b, domain.Update{DocID: doc.ID, Actor: "bob", Payload: []byte("b")}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ReadDocumentWAL(ctx, doc.ID, 0, 2); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveDocumentSnapshot(ctx, b, []byte("ab"), 0, 2); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveDocumentSnapshot(ctx, a, []byte("a"), 0, 1); !errors.Is(err, store.ErrDocumentFenced) {
		t.Fatalf("old snapshot must be fenced: %v", err)
	}
	if _, err := st.AppendDocumentWAL(ctx, a, domain.Update{DocID: doc.ID, Payload: []byte("old")}); !errors.Is(err, store.ErrDocumentFenced) {
		t.Fatalf("old WAL must be fenced: %v", err)
	}
	state, seq, err := st.LoadState(ctx, doc.ID)
	if err != nil || seq != 2 || string(state) != "ab" {
		t.Fatalf("confirmed state regressed: %q %d %v", state, seq, err)
	}
	if err := st.SaveDocumentSnapshot(ctx, b, []byte("old"), 0, 0); err == nil {
		t.Fatal("current owner cannot overwrite a changed snapshot base")
	}
	if _, err := st.ReadDocumentWAL(ctx, doc.ID, 2, 2); err != nil {
		t.Fatal(err)
	}
}

func TestDocumentWALConcurrentSequenceAndCapturedSnapshotPrefix(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	doc := domain.Document{ID: "concurrent-document", Realm: "r1", Space: "s1"}
	if err := st.EnsureDocument(ctx, doc); err != nil {
		t.Fatal(err)
	}
	lease, err := st.AcquireDocumentLease(ctx, doc.ID, "A")
	if err != nil {
		t.Fatal(err)
	}
	const n = 24
	var wg sync.WaitGroup
	errorsCh := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := st.AppendDocumentWAL(ctx, lease, domain.Update{DocID: doc.ID, Payload: []byte("x")})
			errorsCh <- err
		}()
	}
	wg.Wait()
	close(errorsCh)
	for err := range errorsCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	updates, err := st.ReadDocumentWAL(ctx, doc.ID, 0, n)
	if err != nil || len(updates) != n {
		t.Fatalf("concurrent sequence: %d %v", len(updates), err)
	}
	// Capture only 1..12 while 13..24 already exist. A snapshot must not claim
	// later updates; they must remain recoverable after trimming the prefix.
	if err := st.SaveDocumentSnapshot(ctx, lease, []byte("prefix12"), 0, 12); err != nil {
		t.Fatal(err)
	}
	tail, err := st.ReadDocumentWAL(ctx, doc.ID, 12, n)
	if err != nil || len(tail) != 12 {
		t.Fatalf("tail lost: %d %v", len(tail), err)
	}
	if err := st.SaveDocumentSnapshot(ctx, lease, []byte("all24"), 12, n); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveDocumentSnapshot(ctx, lease, []byte("stale"), 12, 13); err == nil {
		t.Fatal("snapshot CAS must reject stale base")
	}
}

func TestHubRecoveryWithoutRedisAndOwnershipChange(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	doc := domain.Document{ID: "recover-document", Realm: "r1", Space: "s1"}
	var owns atomic.Bool
	owns.Store(true)
	a := hub.New(st, domain.DefaultLimits())
	a.ConfigureOwnership("A", func(domain.DocumentID) bool { return owns.Load() })
	if _, err := a.Open(ctx, doc); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Apply(ctx, doc.ID, "alice", []byte("a")); err != nil {
		t.Fatal(err)
	}
	closed := false
	if _, err := a.Subscribe(doc.ID, &hub.Subscriber{UserID: "alice", Send: func(domain.Update) error { return nil }, Close: func() { closed = true }}); err != nil {
		t.Fatal(err)
	}
	owns.Store(false)
	a.ReconcileOwnership(ctx)
	if !closed {
		t.Fatal("old WS must be closed on ownership change")
	}
	b := hub.New(st, domain.DefaultLimits())
	b.ConfigureOwnership("B", func(domain.DocumentID) bool { return true })
	if _, err := b.Open(ctx, doc); err != nil {
		t.Fatal(err)
	}
	// A recovered WAL tail must be dirty even if B receives no new updates.
	if err := b.Snapshot(ctx, func(state []byte, updates []domain.Update) ([]byte, error) {
		for _, u := range updates {
			state = append(state, u.Payload...)
		}
		return state, nil
	}); err != nil {
		t.Fatal(err)
	}
	state, seq, err := st.LoadState(ctx, doc.ID)
	if err != nil || string(state) != "a" || seq != 1 {
		t.Fatalf("recovered WAL not snapshotted: %q %d %v", state, seq, err)
	}
}

func TestSnapshotRejectsMissingWALPrefix(t *testing.T) {
	st, pool := newPGStore(t)
	ctx := context.Background()
	doc := domain.Document{ID: "gap-document", Realm: "r1", Space: "s1"}
	if err := st.EnsureDocument(ctx, doc); err != nil {
		t.Fatal(err)
	}
	lease, err := st.AcquireDocumentLease(ctx, doc.ID, "A")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := st.AppendDocumentWAL(ctx, lease, domain.Update{DocID: doc.ID, Payload: []byte("x")}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `DELETE FROM collab_document_wal WHERE doc_id=$1 AND seq=2`, string(doc.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ReadDocumentWAL(ctx, doc.ID, 0, 3); err == nil {
		t.Fatal("missing seq must fail restore")
	}
	if err := st.SaveDocumentSnapshot(ctx, lease, []byte("invalid"), 0, 3); err == nil {
		t.Fatal("missing seq must not be trimmed as saved")
	}
}

func TestQuiescedLegacyRedisWALImportPreservesTailAndRequiresSource(t *testing.T) {
	addr := os.Getenv("LUMO_TEST_REDIS_ADDR")
	if addr == "" {
		t.Skip("LUMO_TEST_REDIS_ADDR 未设置，跳过旧 Redis WAL 导入回归")
	}
	st, pool := newPGStore(t)
	ctx := context.Background()
	id := domain.DocumentID(fmt.Sprintf("legacy-%d", time.Now().UnixNano()))
	if _, err := pool.Exec(ctx, `INSERT INTO collab_documents(doc_id,realm,space,title) VALUES($1,'r','s','legacy');`, string(id)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO collab_state(doc_id,state,wal_seq) VALUES($1,$2,1)`, string(id), []byte("a")); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AcquireDocumentLease(ctx, id, "owner"); err == nil {
		t.Fatal("missing Redis must not silently mark a legacy document migrated")
	}
	legacy, err := store.New(ctx, pool.Config().ConnString(), addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(legacy.Close)
	rdb := redis.NewClient(&redis.Options{Addr: addr})
	t.Cleanup(func() { _ = rdb.Del(ctx, "collab:wal:"+string(id)).Err(); _ = rdb.Close() })
	for seq := int64(2); seq <= 3; seq++ {
		blob, err := json.Marshal(map[string]any{"seq": seq, "update": domain.Update{DocID: id, Payload: []byte{byte('a' + seq - 1)}}})
		if err != nil {
			t.Fatal(err)
		}
		if err := rdb.RPush(ctx, "collab:wal:"+string(id), string(blob)).Err(); err != nil {
			t.Fatal(err)
		}
	}
	lease, err := legacy.AcquireDocumentLease(ctx, id, "owner")
	if err != nil {
		t.Fatal(err)
	}
	updates, err := legacy.ReadDocumentWAL(ctx, id, 1, 3)
	if err != nil || len(updates) != 2 {
		t.Fatalf("legacy tail missing: %v %v", updates, err)
	}
	if _, err := legacy.AppendDocumentWAL(ctx, lease, domain.Update{DocID: id, Payload: []byte("d")}); err != nil {
		t.Fatal(err)
	}
	if err := legacy.ReleaseDocumentLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	// Migration is durable: a new process now recovers entirely from PG.
	if _, err := st.AcquireDocumentLease(ctx, id, "new-owner"); err != nil {
		t.Fatal(err)
	}
	updates, err = st.ReadDocumentWAL(ctx, id, 1, 4)
	if err != nil || len(updates) != 3 {
		t.Fatalf("PG recovery after legacy import: %v %v", updates, err)
	}
	if n, err := rdb.LLen(ctx, "collab:wal:"+string(id)).Result(); err != nil || n != 2 {
		t.Fatalf("upgrade must preserve Redis rollback evidence: %d %v", n, err)
	}
}

func TestSameUserConnectionsRemainIndependentSubscriptions(t *testing.T) {
	st, _ := newPGStore(t)
	h := hub.New(st, domain.DefaultLimits())
	h.ConfigureOwnership("owner", func(domain.DocumentID) bool { return true })
	ctx := context.Background()
	id := domain.DocumentID("multi-device")
	if _, err := h.Open(ctx, domain.Document{ID: id, Realm: "r", Space: "s"}); err != nil {
		t.Fatal(err)
	}
	var first, second int
	one, err := h.Subscribe(id, &hub.Subscriber{UserID: "alice", Send: func(domain.Update) error { first++; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.Subscribe(id, &hub.Subscriber{UserID: "alice", Send: func(domain.Update) error { second++; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Apply(ctx, id, "bob", []byte("one")); err != nil {
		t.Fatal(err)
	}
	one()
	if _, err := h.Apply(ctx, id, "bob", []byte("two")); err != nil {
		t.Fatal(err)
	}
	if first != 1 || second != 2 {
		t.Fatalf("one connection replaced or unsubscribed another: %d %d", first, second)
	}
}

func TestConcurrentReplicaSchemaInitialization(t *testing.T) {
	st, pool := newPGStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `DROP TABLE collab_document_wal,collab_document_runtime`); err != nil {
		t.Fatal(err)
	}
	const n = 8
	results := make(chan error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- st.Init(ctx) }()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatalf("parallel replica startup: %v", err)
		}
	}
}
