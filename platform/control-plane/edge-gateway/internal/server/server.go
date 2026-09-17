// Package server 把 routing / proxy / waf / gate 四件套装配成可运行的边缘网关：
// /healthz、/metrics、只读自省 /v1/routes（受控制面令牌保护），以及兜底的反向
// 代理（每条路由都被整套横切治理包裹）。路由表支持热重载（原子替换）。
package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"

	"github.com/lumo-harness/platform/edge-gateway/internal/gate"
	"github.com/lumo-harness/platform/edge-gateway/internal/proxy"
	"github.com/lumo-harness/platform/edge-gateway/internal/routing"
	"github.com/lumo-harness/platform/edge-gateway/internal/waf"
	"github.com/lumo-harness/platform/observability"
)

// Options 装配网关所需的全部依赖与阈值。
type Options struct {
	Compiled     *routing.Compiled
	ProxyClient  *http.Client // 注意：不应设整体 Timeout，否则会截断流式响应
	Limiter      gate.RateLimiter
	GlobalRPM    int   // 全局每客户端配额（0 = 不限）
	FailOpen     bool  // 限流器不可用时是否放行（默认 false = fail-closed）
	MaxBodyBytes int64 // 请求体上限（0 = 不限）
	MaxConns     int64 // 全局在途连接数上限（0 = 不限）
	CORSOrigins  []string
	CORSMethods  string
	WafRules     waf.Rules
	Logger       *slog.Logger
}

// Server 持有当前路由表与代理工厂，支持原子热重载。
type Server struct {
	mu       sync.RWMutex
	compiled *routing.Compiled
	byRoute  map[*routing.CompiledRoute]http.Handler
	factory  *proxyFactory
	opts     Options
}

type proxyFactory struct {
	mu        sync.Mutex
	transport http.RoundTripper
	cache     map[string]*httputil.ReverseProxy
}

func (f *proxyFactory) For(target *url.URL) *httputil.ReverseProxy {
	key := target.String()
	f.mu.Lock()
	defer f.mu.Unlock()
	if p, ok := f.cache[key]; ok {
		return p
	}
	// 同一上游 URL 复用同一个 ReverseProxy：它是并发安全的，且复用能共享底层
	// 连接池。以 URL 字符串为键，避免同一主机反复 New。
	p := proxy.NewReverseProxy(target, f.transport)
	f.cache[key] = p
	return p
}

// New 用初始路由表装配 Server，并立即构建各路由的治理链。
func New(opts Options) *Server {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.ProxyClient == nil {
		opts.ProxyClient = &http.Client{Transport: http.DefaultTransport}
	}
	s := &Server{
		opts:    opts,
		factory: &proxyFactory{transport: opts.ProxyClient.Transport, cache: make(map[string]*httputil.ReverseProxy)},
	}
	s.Swap(opts.Compiled)
	return s
}

// Swap 原子替换路由表（热重载）。并发请求不会看到半构建的治理链。
func (s *Server) Swap(c *routing.Compiled) {
	byRoute := make(map[*routing.CompiledRoute]http.Handler, len(c.Routes))
	for _, cr := range c.Routes {
		byRoute[cr] = s.buildHandler(cr)
	}
	s.mu.Lock()
	s.compiled = c
	s.byRoute = byRoute
	s.mu.Unlock()
}

// buildHandler 为单条路由组装「连接数 → CORS → 全局限流 → 路由限流 → 体大小
// → WAF → 反向代理」的治理链。顺序有讲究：CORS 在最前，让预检 OPTIONS 直接
// 204 返回、不消耗限流配额；限流在体大小/WAF 之前，先把失控流量挡在门外。
func (s *Server) buildHandler(cr *routing.CompiledRoute) http.Handler {
	proxyH := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := cr.SelectUpstream(r)
		s.factory.For(target).ServeHTTP(w, r)
	})
	h := gate.NewConnLimit(s.opts.MaxConns).Wrap(
		gate.CORS(s.opts.CORSOrigins, s.opts.CORSMethods)(
			gate.RateLimit(s.opts.Limiter, s.globalLimitOpts())(
				gate.RateLimit(s.opts.Limiter, s.routeLimitOpts(cr))(
					gate.MaxBodyBytes(s.opts.MaxBodyBytes)(
						waf.Middleware(s.opts.WafRules)(proxyH))))))
	return h
}

func (s *Server) globalLimitOpts() gate.RateLimitOpts {
	return gate.RateLimitOpts{
		RPM:      s.opts.GlobalRPM,
		KeyFor:   func(r *http.Request) string { return "global:" + gate.ClientIP(r) },
		FailOpen: s.opts.FailOpen,
		Logger:   s.opts.Logger,
	}
}

func (s *Server) routeLimitOpts(cr *routing.CompiledRoute) gate.RateLimitOpts {
	return gate.RateLimitOpts{
		RPM:      cr.Raw.RateLimitRPM,
		KeyFor:   func(r *http.Request) string { return cr.Prefix + ":" + gate.ClientIP(r) },
		FailOpen: s.opts.FailOpen,
		Logger:   s.opts.Logger,
	}
}

// CatchAll 兜底处理：按路径+Host 匹配路由，未命中返回 404。
func (s *Server) CatchAll(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	compiled := s.compiled
	byRoute := s.byRoute
	s.mu.RUnlock()
	cr := compiled.Match(r.URL.Path, r.Host)
	if cr == nil {
		http.NotFound(w, r)
		return
	}
	byRoute[cr].ServeHTTP(w, r)
}

// Introspect 返回当前路由表的只读视图（受控制面令牌保护，见 main 装配）。
func (s *Server) Introspect(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	compiled := s.compiled
	s.mu.RUnlock()

	type canaryView struct {
		Header   string `json:"header,omitempty"`
		Upstream string `json:"upstream"`
		Weight   int    `json:"weight"`
	}
	type routeView struct {
		Prefix       string      `json:"prefix"`
		Host         string      `json:"host,omitempty"`
		Upstream     string      `json:"upstream"`
		RateLimitRPM int         `json:"rate_limit_rpm"`
		Canary       *canaryView `json:"canary,omitempty"`
	}
	views := make([]routeView, 0, len(compiled.Routes))
	for _, cr := range compiled.Routes {
		v := routeView{Prefix: cr.Prefix, Host: cr.Host, Upstream: cr.Primary.String(), RateLimitRPM: cr.Raw.RateLimitRPM}
		if cr.Canary != nil {
			v.Canary = &canaryView{Header: cr.Canary.Header, Upstream: cr.Canary.URL.String(), Weight: cr.Canary.Weight}
		}
		views = append(views, v)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"whitelist": compiled.Whitelist,
		"routes":    views,
	})
}

// Routes 把端点注册到给定 mux。注意顺序：具体路径（/healthz、/metrics、
// /v1/routes）必须早于兜底 "/"，否则会被反向代理吞掉。
func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("/metrics", http.HandlerFunc(observability.Handler))
	mux.HandleFunc("/v1/routes", s.Introspect)
	mux.Handle("/", http.HandlerFunc(s.CatchAll))
}
