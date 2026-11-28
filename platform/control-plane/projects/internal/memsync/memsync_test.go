package memsync

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const ws = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const id1 = "11111111-2222-4333-8444-555555555555"

type mem struct {
	mu   sync.Mutex
	seq  int64
	rows map[Scope]map[string]Item
}

func (m *mem) Pull(_ context.Context, s Scope, since int64, limit int) ([]Item, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Item{}
	for _, it := range m.rows[s] {
		if it.Seq > since {
			out = append(out, it)
		}
	}
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j].Seq < out[i].Seq {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	if len(out) > limit {
		out = out[:limit]
	}
	c := since
	if len(out) > 0 {
		c = out[len(out)-1].Seq
	}
	return out, c, nil
}

func (m *mem) Push(_ context.Context, s Scope, dev string, cs []Change) ([]Result, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = map[Scope]map[string]Item{}
	}
	if m.rows[s] == nil {
		m.rows[s] = map[string]Item{}
	}
	var res []Result
	for _, c := range cs {
		var cur *Item
		if it, ok := m.rows[s][c.ID]; ok {
			cur = &it
		}
		r := Result{ID: c.ID, Outcome: Decide(cur, c)}
		if r.Outcome == Accepted {
			m.seq++
			m.rows[s][c.ID] = Item{c.ID, c.Kind, c.Payload, c.HLC, dev, c.Deleted, m.seq}
			r.Seq = m.seq
		} else {
			r.Current = cur
		}
		res = append(res, r)
	}
	return res, nil
}

func TestDecideRules(t *testing.T) {
	cur := &Item{ID: id1, Kind: "card", Payload: "a", Seq: 5}
	cases := []struct {
		name string
		cur  *Item
		in   Change
		want Outcome
	}{
		{"new", nil, Change{Kind: "card", Payload: "a"}, Accepted},
		{"lost-base", nil, Change{Kind: "card", Payload: "a", BaseSeq: 3}, Conflict},
		{"same-content", cur, Change{Kind: "card", Payload: "a", BaseSeq: 1}, Duplicate},
		{"fast-forward", cur, Change{Kind: "card", Payload: "b", BaseSeq: 5}, Accepted},
		{"stale-edit", cur, Change{Kind: "card", Payload: "b", BaseSeq: 4}, Conflict},
		{"stale-delete-vs-edit", cur, Change{Kind: "card", Deleted: true, BaseSeq: 4}, Conflict},
		{"both-deleted", &Item{Deleted: true, Seq: 9, Kind: "card"}, Change{Kind: "card", Deleted: true, BaseSeq: 2}, Duplicate},
	}
	for _, c := range cases {
		if got := Decide(c.cur, c.in); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}

func TestValidate(t *testing.T) {
	ok := Change{ID: id1, Kind: "card", Payload: "x", HLC: "1764000000000-0001-dev1"}
	if ok.Validate() != nil {
		t.Fatal("valid change rejected")
	}
	bad := []Change{
		{ID: "x", Kind: "card", Payload: "x", HLC: ok.HLC},
		{ID: id1, Kind: "other", Payload: "x", HLC: ok.HLC},
		{ID: id1, Kind: "card", Payload: "", HLC: ok.HLC},
		{ID: id1, Kind: "card", Payload: "x", HLC: ok.HLC, Deleted: true},
		{ID: id1, Kind: "card", Payload: strings.Repeat("x", MaxPayload+1), HLC: ok.HLC},
		{ID: id1, Kind: "card", Payload: "x", HLC: "now"},
	}
	for i, b := range bad {
		if b.Validate() == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

func do(t *testing.T, mux *http.ServeMux, method, path, body, user, realm string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if user != "" {
		req.Header.Set("X-Lumo-User", user)
		req.Header.Set("X-Lumo-Realm", realm)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestHTTPFlowIsolationAndConflict(t *testing.T) {
	mux := http.NewServeMux()
	(&Handler{B: &mem{}, Log: slog.Default()}).Register(mux)
	push := func(payload string, base int, user, realm string) (int, map[string]any) {
		b := `{"workspace":"` + ws + `","device":"mac1","changes":[{"id":"` + id1 + `","kind":"card","payload":"` + payload + `","hlc":"1764000000000-0001-mac1","deleted":false,"baseSeq":` + itoa(base) + `}]}`
		return do(t, mux, "POST", "/v1/memory-sync/push", b, user, realm)
	}
	if code, _ := push("a", 0, "", ""); code != 401 {
		t.Fatalf("anonymous push: %d", code)
	}
	code, out := push("a", 0, "u1", "r1")
	if code != 200 || out["results"].([]any)[0].(map[string]any)["outcome"] != "accepted" {
		t.Fatalf("first push: %d %v", code, out)
	}
	_, out = push("b", 0, "u1", "r1")
	if r := out["results"].([]any)[0].(map[string]any); r["outcome"] != "conflict" || r["current"] == nil {
		t.Fatalf("stale push must conflict: %v", r)
	}
	_, out = push("b", 1, "u1", "r1")
	if out["results"].([]any)[0].(map[string]any)["outcome"] != "accepted" {
		t.Fatalf("keep-mine retry must win: %v", out)
	}
	_, out = do(t, mux, "GET", "/v1/memory-sync/changes?workspace="+ws+"&since=0", "", "u1", "r1")
	if items := out["items"].([]any); len(items) != 1 || items[0].(map[string]any)["payload"] != "b" {
		t.Fatalf("pull: %v", out)
	}
	for _, who := range [][2]string{{"u2", "r1"}, {"u1", "r2"}} {
		_, out = do(t, mux, "GET", "/v1/memory-sync/changes?workspace="+ws, "", who[0], who[1])
		if len(out["items"].([]any)) != 0 {
			t.Fatalf("isolation broken for %v", who)
		}
	}
	if code, _ := do(t, mux, "GET", "/v1/memory-sync/changes?workspace=../x", "", "u1", "r1"); code != 400 {
		t.Fatalf("bad workspace: %d", code)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestIdentityUsesAuthenticatedHeaders(t *testing.T) {
	mux := http.NewServeMux()
	(&Handler{}).Register(mux)
	for _, complete := range []bool{false, true} {
		r := httptest.NewRequest(http.MethodGet, "/v1/memory-sync/identity?realm=forged&userId=forged", nil)
		r.Header.Set("X-Lumo-User", "alice")
		if complete {
			r.Header.Set("X-Lumo-Realm", "realm-a")
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if !complete {
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("missing realm: %d", w.Code)
			}
			continue
		}
		var got map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if w.Code != http.StatusOK || got["realm"] != "realm-a" || got["userId"] != "alice" || len(got) != 2 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("identity response: %d %v", w.Code, got)
		}
	}
}
