package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/lumo-harness/platform/edge-gateway/internal/routing"
	"github.com/lumo-harness/platform/edge-gateway/internal/waf"
)

// 用真实 httptest 上游，验证「整条治理链 + 反向代理」的 happy path：请求能透传
// 到上游、兜底路由能按前缀匹配。
func TestServer_ProxyHappyPath(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "backend:"+r.URL.Path)
	}))
	defer upstream.Close()

	u, _ := url.Parse(upstream.URL)
	rt := &routing.RouteTable{
		Whitelist: []string{u.Host},
		Routes:    []routing.Route{{Prefix: "/api", Upstream: upstream.URL}},
	}
	if err := rt.Validate(); err != nil {
		t.Fatalf("校验失败: %v", err)
	}
	compiled, err := rt.Compile()
	if err != nil {
		t.Fatalf("编译失败: %v", err)
	}

	srv := New(Options{
		Compiled:    compiled,
		ProxyClient: &http.Client{Transport: http.DefaultTransport},
		WafRules:    waf.DefaultRules(),
	})
	mux := http.NewServeMux()
	srv.Routes(mux)
	front := httptest.NewServer(mux)
	defer front.Close()

	resp, err := http.Get(front.URL + "/api/hello")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "backend:/api/hello" {
		t.Fatalf("代理未正确转发路径, 得到 %q", string(body))
	}
}

// 未命中任何路由 → 404。
func TestServer_NoRoute(t *testing.T) {
	rt := &routing.RouteTable{
		Whitelist: []string{"svc:8080"},
		Routes:    []routing.Route{{Prefix: "/api", Upstream: "http://svc:8080"}},
	}
	_ = rt.Validate()
	compiled, _ := rt.Compile()
	srv := New(Options{Compiled: compiled, WafRules: waf.DefaultRules()})
	mux := http.NewServeMux()
	srv.Routes(mux)
	front := httptest.NewServer(mux)
	defer front.Close()

	resp, _ := http.Get(front.URL + "/nope")
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("未命中应 404, 得到 %d", resp.StatusCode)
	}
}

// /v1/routes 自省返回当前路由表。
func TestServer_Introspect(t *testing.T) {
	rt := &routing.RouteTable{
		Whitelist: []string{"svc:8080"},
		Routes:    []routing.Route{{Prefix: "/api", Upstream: "http://svc:8080", RateLimitRPM: 500}},
	}
	_ = rt.Validate()
	compiled, _ := rt.Compile()
	srv := New(Options{Compiled: compiled, WafRules: waf.DefaultRules()})
	mux := http.NewServeMux()
	srv.Routes(mux)
	front := httptest.NewServer(mux)
	defer front.Close()

	resp, err := http.Get(front.URL + "/v1/routes")
	if err != nil {
		t.Fatalf("请求 /v1/routes 失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("自省应 200, 得到 %d", resp.StatusCode)
	}
	if len(body) == 0 {
		t.Fatal("自省响应为空")
	}
}

// 热重载：Swap 后新路由表生效，且切换是原子的（不会半构建）。
func TestServer_Reload(t *testing.T) {
	old := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "v1")
	}))
	defer old.Close()
	nu := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "v2")
	}))
	defer nu.Close()

	oldU, _ := url.Parse(old.URL)
	rt1 := &routing.RouteTable{Whitelist: []string{oldU.Host}, Routes: []routing.Route{{Prefix: "/api", Upstream: old.URL}}}
	_ = rt1.Validate()
	c1, _ := rt1.Compile()

	srv := New(Options{Compiled: c1, ProxyClient: &http.Client{Transport: http.DefaultTransport}, WafRules: waf.DefaultRules()})
	mux := http.NewServeMux()
	srv.Routes(mux)
	front := httptest.NewServer(mux)
	defer front.Close()

	get := func() string {
		resp, err := http.Get(front.URL + "/api/x")
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}
	if got := get(); got != "v1" {
		t.Fatalf("重载前应为 v1, 得到 %q", got)
	}

	// 切到新上游。
	nuU, _ := url.Parse(nu.URL)
	rt2 := &routing.RouteTable{Whitelist: []string{nuU.Host}, Routes: []routing.Route{{Prefix: "/api", Upstream: nu.URL}}}
	_ = rt2.Validate()
	c2, _ := rt2.Compile()
	srv.Swap(c2)

	if got := get(); got != "v2" {
		t.Fatalf("重载后应为 v2, 得到 %q", got)
	}
}
