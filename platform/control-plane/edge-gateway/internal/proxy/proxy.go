// Package proxy 实现边缘网关的「协议适配/接入」（§12.1 四件事之一）。
//
// 用 net/http/httputil.ReverseProxy 做反向代理。重点是三件事：① 流式安全——
// 不缓冲整个响应体，让 SSE / LLM 逐 chunk 透传；② 逐跳（hop-by-hop）头不跨跳泄漏；
// ③ 在边界注入 X-Forwarded-*，让内网上游拿到真实客户端来源。
//
// ②**交给标准库**，本包不自己剥（曾经剥过，见下）。理由是时序：
// httputil.ReverseProxy 在 `p.Director(outreq)` 返回**之后**才调
// `upgradeType(outreq.Header)` 决定要不要走 101 转发，紧接着它自己调
// `removeHopByHopHeaders`；等到改写响应时它也会先剥一遍再交给 ModifyResponse。
// 在 Director 里抢先剥掉 Connection/Upgrade，等于把「这是一次协议升级」这个事实
// 从标准库眼前抹掉：reqUpType 变成 ""，上游回的 101 会被判成
// 「backend tried to switch protocol "websocket" when "" was requested」，
// 于是所有 WebSocket 终端都连不上，而日志里只有一个看起来像上游的错。
// 而这个自研版本能提供的东西标准库也已经有了——removeHopByHopHeaders 除了内置
// 短名单，还会按 RFC 7230 §6.1 解析 Connection 里点名的任意令牌。
// 对应回归用例见 proxy_test.go 的 TestReverseProxy_UpgradeIsForwarded。
package proxy

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// NewReverseProxy 构造指向单个上游的反向代理。
//
// 流式安全的关键在 FlushInterval=0：它让 ReverseProxy 每从上游读到一截就立刻
// flush 给客户端，而不是攒批。若设成非零值，小 chunk 会被缓冲，出现「挂着流式
// 名号干缓冲的活」的假流式，LLM/SSE 场景会明显卡顿。
func NewReverseProxy(target *url.URL, transport http.RoundTripper) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		FlushInterval: 0,
		Transport:     transport,
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host

			// 边界网关是南北入口，它之后都是受信内网。X-Forwarded-For 由
			// httputil.ReverseProxy 自动按 RFC 7239 追加「直连 peer」——我们
			// 在此先删掉客户端自报的 XFF，避免上游被伪造的整条链误导；ReverseProxy
			// 随后只会写入真实直连 IP。X-Forwarded-Host / -Proto 官方 ReverseProxy
			// 不管，我们补上，让上游拿到「客户端看到的 Host/协议」。
			req.Header.Del("X-Forwarded-For")
			req.Header.Set("X-Forwarded-Host", req.Host)
			if req.TLS != nil {
				req.Header.Set("X-Forwarded-Proto", "https")
			} else {
				req.Header.Set("X-Forwarded-Proto", "http")
			}
		},
		// 上游连不上/超时：返回 502 而非 ReverseProxy 默认的 500，语义更准
		// （500 是「服务端自己错了」，502 才是「网关背后的上游错了」）。
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "bad gateway", http.StatusBadGateway)
		},
	}
}
