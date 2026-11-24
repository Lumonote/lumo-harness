package identity

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type fakeResolver struct {
	p   Principal
	err error
	got string
}

func (f *fakeResolver) Resolve(_ context.Context, token string) (Principal, error) {
	f.got = token
	return f.p, f.err
}

func run(t *testing.T, res Resolver, token string, hdr map[string]string) (*httptest.ResponseRecorder, http.Header) {
	t.Helper()
	var seen http.Header
	h := Middleware(res, "svc-token")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/v1/memory-sync/changes", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec, seen
}

func TestMiddleware_StripsForgedAndInjectsVerified(t *testing.T) {
	res := &fakeResolver{p: Principal{Realm: "r1", UserID: "alice", Roles: []string{"member"}, PrimaryDeptID: "d1"}}
	rec, seen := run(t, res, "user-tok", map[string]string{
		"X-Lumo-Realm": "evil", "X-Lumo-User": "root", "X-Lumo-Roles": "platform_admin",
		"X-Lumo-Project": "p-forged", "x-lumo-identity": "forged", "X-Lumo-Correlation-Id": "c-1",
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d", rec.Code)
	}
	if res.got != "user-tok" {
		t.Fatalf("resolver got %q", res.got)
	}
	want := map[string]string{"X-Lumo-Realm": "r1", "X-Lumo-User": "alice", "X-Lumo-Roles": "member", "X-Lumo-Dept": "d1",
		"Authorization": "Bearer svc-token", "X-Lumo-Correlation-Id": "c-1"}
	for k, v := range want {
		if got := seen.Get(k); got != v {
			t.Fatalf("%s = %q, want %q", k, got, v)
		}
	}
	for _, k := range []string{"X-Lumo-Project", "X-Lumo-Identity", "X-Lumo-Session"} {
		if seen.Get(k) != "" {
			t.Fatalf("forged header %s leaked: %q", k, seen.Get(k))
		}
	}
	if len(seen.Values("X-Lumo-Realm")) != 1 {
		t.Fatalf("realm must be single-valued: %v", seen.Values("X-Lumo-Realm"))
	}
}

func TestMiddleware_FailClosed(t *testing.T) {
	cases := []struct {
		name  string
		res   Resolver
		token string
		code  int
	}{
		{"无令牌", &fakeResolver{p: Principal{Realm: "r", UserID: "u"}}, "", http.StatusUnauthorized},
		{"令牌无效", &fakeResolver{err: ErrUnauthenticated}, "bad", http.StatusUnauthorized},
		{"governance 不可用", &fakeResolver{err: errors.New("dial")}, "t", http.StatusServiceUnavailable},
		{"未配置解析器", nil, "t", http.StatusServiceUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec, seen := run(t, tc.res, tc.token, map[string]string{"X-Lumo-User": "root", "X-Lumo-Realm": "evil"})
			if rec.Code != tc.code {
				t.Fatalf("want %d, got %d", tc.code, rec.Code)
			}
			if seen != nil {
				t.Fatal("request must not reach upstream")
			}
		})
	}
}

func TestTokenFrom_PrefersSessionHeader(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer b")
	r.Header.Set(SessionHeader, "s")
	if TokenFrom(r) != "s" {
		t.Fatal("X-Lumo-Session should win")
	}
}

func TestGovernanceResolver(t *testing.T) {
	var calls atomic.Int32
	gov := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/auth/session" || r.Header.Get("Authorization") != "Bearer svc" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		switch r.Header.Get(SessionHeader) {
		case "good":
			_, _ = w.Write([]byte(`{"principal":{"realm":"r1","user_id":"alice","roles":["member"],"username":"a"}}`))
		case "weird":
			_, _ = w.Write([]byte(`{"principal":{"realm":"r1\nX","user_id":"alice","roles":["member"]}}`))
		case "down":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer gov.Close()
	now := time.Unix(1000, 0)
	g := &GovernanceResolver{BaseURL: gov.URL + "/", ServiceToken: "svc", TTL: 10 * time.Second, Now: func() time.Time { return now }}
	p, err := g.Resolve(context.Background(), "good")
	if err != nil || p.UserID != "alice" || p.Realm != "r1" {
		t.Fatalf("got %+v %v", p, err)
	}
	if _, err := g.Resolve(context.Background(), "good"); err != nil || calls.Load() != 1 {
		t.Fatalf("second call should hit cache, calls=%d err=%v", calls.Load(), err)
	}
	now = now.Add(11 * time.Second)
	if _, err := g.Resolve(context.Background(), "good"); err != nil || calls.Load() != 2 {
		t.Fatalf("expired cache should revalidate, calls=%d", calls.Load())
	}
	for _, tok := range []string{"nope", "weird", ""} {
		if _, err := g.Resolve(context.Background(), tok); !errors.Is(err, ErrUnauthenticated) {
			t.Fatalf("%q: want ErrUnauthenticated, got %v", tok, err)
		}
	}
	if _, err := g.Resolve(context.Background(), "down"); err == nil || errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("5xx must be an availability error, got %v", err)
	}
}
