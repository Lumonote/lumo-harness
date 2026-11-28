package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/edge-gateway/internal/routing"
	"github.com/lumo-harness/platform/edge-gateway/internal/waf"
	"github.com/lumo-harness/platform/observability"
)

// fakeSession 模拟 identity.Middleware：令牌 "good" 通过并注入身份，其余 401。
func fakeSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer good" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		r.Header.Del("X-Lumo-User")
		r.Header.Set("X-Lumo-User", "alice")
		r.Header.Set("Authorization", "Bearer cp-token")
		next.ServeHTTP(w, r)
	})
}

func gateway(t *testing.T, mw func(http.Handler) http.Handler) (*httptest.Server, *httptest.Server) {
	t.Helper()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.URL.Path+"|"+r.Header.Get("X-Lumo-User")+"|"+r.Header.Get("Authorization"))
	}))
	u, _ := url.Parse(up.URL)
	rt := &routing.RouteTable{Whitelist: []string{u.Host}, Routes: []routing.Route{
		{Prefix: "/v1/memory-sync/", Upstream: up.URL, Identity: "session"},
		{Prefix: "/v1/projects", Upstream: up.URL},
	}}
	if err := rt.Validate(); err != nil {
		t.Fatal(err)
	}
	c, _ := rt.Compile()
	srv := New(Options{Compiled: c, WafRules: waf.DefaultRules(), SessionIdentity: mw})
	mux := http.NewServeMux()
	srv.Routes(mux)
	front := httptest.NewServer(srv.Front(observability.RequireControlPlaneToken("cp-token")(mux)))
	return front, up
}

func get(t *testing.T, u, auth string, extra map[string]string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestSessionRoute_InjectsVerifiedIdentity(t *testing.T) {
	front, up := gateway(t, fakeSession)
	defer front.Close()
	defer up.Close()
	for _, path := range []string{"/v1/memory-sync/changes", "/v1/memory-sync/identity"} {
		code, body := get(t, front.URL+path, "Bearer good", map[string]string{"X-Lumo-User": "root"})
		if code != 200 || body != path+"|alice|Bearer cp-token" {
			t.Fatalf("got %d %q", code, body)
		}
		if code, _ := get(t, front.URL+path, "Bearer bad", nil); code != http.StatusUnauthorized {
			t.Fatalf("bad token: %d", code)
		}
	}

}

func TestSessionRoute_DoesNotOpenOtherRoutes(t *testing.T) {
	front, up := gateway(t, fakeSession)
	defer front.Close()
	defer up.Close()
	// 非 session 路由仍然要控制面令牌；用户会话令牌不能借道
	if code, _ := get(t, front.URL+"/v1/projects", "Bearer good", nil); code != http.StatusUnauthorized {
		t.Fatalf("/v1/projects with user token: %d", code)
	}
	if code, body := get(t, front.URL+"/v1/projects", "Bearer cp-token", nil); code != 200 || !strings.HasPrefix(body, "/v1/projects|") {
		t.Fatalf("/v1/projects with cp token: %d %q", code, body)
	}
	if code, _ := get(t, front.URL+"/v1/routes", "Bearer good", nil); code != http.StatusUnauthorized {
		t.Fatalf("/v1/routes must stay protected: %d", code)
	}
}

func TestSessionRoute_FailClosedWithoutResolver(t *testing.T) {
	front, up := gateway(t, nil)
	defer front.Close()
	defer up.Close()
	if code, _ := get(t, front.URL+"/v1/memory-sync/changes", "Bearer cp-token", nil); code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 without resolver, got %d", code)
	}
}

func TestRouteIdentity_UnknownModeRejected(t *testing.T) {
	rt := &routing.RouteTable{Whitelist: []string{"svc:1"}, Routes: []routing.Route{{Prefix: "/x", Upstream: "http://svc:1", Identity: "header"}}}
	if err := rt.Validate(); err == nil || !strings.Contains(err.Error(), "identity") {
		t.Fatalf("want identity error, got %v", err)
	}
}
