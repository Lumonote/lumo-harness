package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/server"
)

// TestRolloutHTTP keeps the command/query path attached to the live PG index:
// only published versions become desired targets, and the command itself still
// needs the gateway-projected realm-admin role.
func TestRolloutHTTP(t *testing.T) {
	ctx := context.Background()
	priv, ts := testKey(t, "acme", []string{"kb:query"})
	s, objs := newStore(t, ts)
	raw := mf("sales-kb", "1.2.0", []string{"kb:query"}, nil)
	if _, err := s.Publish(ctx, raw, sign(priv, raw)); err != nil {
		t.Fatal(err)
	}
	h := server.New(s, ts, objs)

	req := httptest.NewRequest(http.MethodPut, "/v1/rollouts/stable/sales-kb", bytes.NewBufferString(`{"version":"1.2.0","percent":100}`))
	req.Header.Set("X-Lumo-User", "operator")
	req.Header.Set("X-Lumo-Realm", "dev")
	req.Header.Set("X-Lumo-Roles", "realm_admin")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("写期望状态应 200，得到 %d: %s", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/rollouts/stable/sales-kb", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("读期望状态应 200，得到 %d: %s", w.Code, w.Body.String())
	}
	var got struct {
		Rollout struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Percent int    `json:"percent"`
		} `json:"rollout"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Rollout.Name != "sales-kb" || got.Rollout.Version != "1.2.0" || got.Rollout.Percent != 100 {
		t.Fatalf("期望状态不正确: %+v", got.Rollout)
	}
}
