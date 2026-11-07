package integration_test

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/hub"
	"github.com/lumo-harness/platform/collaborator/internal/ownership"
	"github.com/lumo-harness/platform/collaborator/internal/server"
)

func TestSpaceGrantRevocationClosesExistingWebSocketBeforeInput(t *testing.T) {
	st, pool := newPGStore(t)
	ctx := context.Background()
	doc := domain.Document{ID: "revoked-doc", Realm: "r1", Space: "s1"}
	if err := st.EnsureDocument(ctx, doc); err != nil {
		t.Fatal(err)
	}
	if err := st.Grant(ctx, "s1", "r1", "alice", []domain.Permission{domain.PermRead, domain.PermEdit}); err != nil {
		t.Fatal(err)
	}
	ring := ownership.NewRing("node")
	h := hub.New(st, domain.DefaultLimits())
	h.ConfigureOwnership("node:boot", ring.IsMine)
	api := server.New(h, st, ring, threadRoundHTTPAuth{}, slog.Default())
	upstream := httptest.NewServer(api.Routes())
	defer upstream.Close()
	headers := http.Header{"X-Lumo-Realm": []string{"r1"}, "X-Lumo-User": []string{"alice"}}
	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(upstream.URL, "http")+"/docs/revoked-doc/ws", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err = st.Grant(ctx, "s1", "r1", "alice", []domain.Permission{}); err != nil {
		t.Fatal(err)
	}
	if err = connection.WriteJSON(map[string]any{"type": "update", "payload": []byte("forbidden")}); err != nil {
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err = connection.ReadMessage(); err == nil {
		t.Fatal("revoked socket emitted data or ACK")
	}
	if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("revoked socket remained open")
	}
	var writes int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM collab_document_wal WHERE doc_id='revoked-doc'`).Scan(&writes); err != nil || writes != 0 {
		t.Fatalf("revoked input persisted: %d %v", writes, err)
	}
}
