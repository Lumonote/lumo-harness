package proxy

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// 代理 happy path：请求体/响应体透传、上游收到 X-Forwarded-* 且看不到 hop-by-hop。
func TestReverseProxy_HappyPath(t *testing.T) {
	var gotXFF, gotXFH, gotXFP, gotHop, gotUpgrade string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotXFF = r.Header.Get("X-Forwarded-For")
		gotXFH = r.Header.Get("X-Forwarded-Host")
		gotXFP = r.Header.Get("X-Forwarded-Proto")
		gotHop = r.Header.Get("Proxy-Authorization") // 逐跳头, 应被剥除
		gotUpgrade = r.Header.Get("Upgrade")         // 没带 Connection: Upgrade, 属普通头, 也应被剥除
		_, _ = io.WriteString(w, "upstream-ok")
	}))
	defer upstream.Close()

	u, _ := url.Parse(upstream.URL)
	// 用默认 transport（流式）；测试里不需要拨号超时。
	rp := NewReverseProxy(u, http.DefaultTransport)

	front := httptest.NewServer(rp)
	defer front.Close()

	// 不自带 XFF：边缘网关作为入口，应把真实直连 peer（此处是测试环回 127.0.0.1）
	// 写入 X-Forwarded-For，且不应信任/保留客户端伪造的 XFF。
	req, _ := http.NewRequest(http.MethodGet, front.URL+"/path?q=1", nil)
	req.Header.Set("Proxy-Authorization", "should-be-stripped")
	req.Header.Set("Upgrade", "should-be-stripped")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "upstream-ok" {
		t.Fatalf("响应体未透传: %q", string(body))
	}
	if gotXFF != "127.0.0.1" {
		t.Errorf("X-Forwarded-For 应为直连 peer 127.0.0.1, 得到 %q", gotXFF)
	}
	if gotXFH == "" || gotXFP != "http" {
		t.Errorf("X-Forwarded-Host/Proto 缺失: host=%q proto=%q", gotXFH, gotXFP)
	}
	if gotHop != "" {
		t.Errorf("逐跳头 Proxy-Authorization 未被剥除: %q", gotHop)
	}
	if gotUpgrade != "" {
		t.Errorf("未带 Connection: Upgrade 的 Upgrade 头属普通头, 应被剥除: %q", gotUpgrade)
	}
}

// 上游 502：上游不可达时返回 502 而非 500。
func TestReverseProxy_UpstreamDown(t *testing.T) {
	dead, _ := url.Parse("http://127.0.0.1:1") // 无监听
	rp := NewReverseProxy(dead, http.DefaultTransport)
	front := httptest.NewServer(rp)
	defer front.Close()

	resp, err := http.Get(front.URL + "/")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("期望 502, 得到 %d", resp.StatusCode)
	}
}

// TestReverseProxy_UpgradeIsForwarded 协议升级（WebSocket 等）必须原样透传到上游。
//
// 这条用例守护的是一个**曾经真实存在**的缺陷：本包原先在 Director 里自研剥逐跳头，
// 而 httputil.ReverseProxy 是在 Director 返回**之后**才读 Upgrade 来决定要不要走
// 101 转发。于是 Upgrade 被删 → reqUpType 变成 "" → 上游回的 101 被判成
// 「backend tried to switch protocol "websocket" when "" was requested」→
// 网关对所有 WebSocket 终端返回 502，而错误信息看起来像上游的问题。
//
// 因此这里断言的是**上游拿到的头**与**客户端收到的状态行**两件事。只看后者不够：
// 上游可以「因为收不到 Upgrade 而正常回 400」，那条路径下客户端拿到的也是非 101，
// 失败信息会指向错误的方向；只看前者则会漏掉标准库那一侧的判定。
func TestReverseProxy_UpgradeIsForwarded(t *testing.T) {
	const upProto = "websocket"
	// 带缓冲 + 只在一次请求上写入：上游 handler 与测试主体在不同 goroutine，
	// 用共享变量会构成数据竞争（`-race` 下必炸）。
	seen := make(chan [2]string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- [2]string{r.Header.Get("Connection"), r.Header.Get("Upgrade")}
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "上游不可 hijack", http.StatusInternalServerError)
			return
		}
		conn, brw, err := hj.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: " + upProto + "\r\n\r\n")
		_ = brw.Flush()
	}))
	defer upstream.Close()

	u, _ := url.Parse(upstream.URL)
	front := httptest.NewServer(NewReverseProxy(u, http.DefaultTransport))
	defer front.Close()

	// 用裸 TCP 而非 http.Client：Go 的 client 对 101 有自己的处理路径，
	// 而这里要验的正是「握手响应有没有被网关原样转回来」。
	status := rawRequest(t, front.Listener.Addr().String(),
		"GET /v1/terminals/s1 HTTP/1.1",
		"Connection: Upgrade",
		"Upgrade: "+upProto,
	)
	if !strings.Contains(status, "101") {
		t.Fatalf("期望上游的 101 被原样转回，实际状态行 %q（说明握手头被网关吃掉了）", status)
	}

	got := <-seen
	if !strings.EqualFold(got[1], upProto) {
		t.Fatalf("上游应看到 Upgrade=%s，实际 Connection=%q Upgrade=%q", upProto, got[0], got[1])
	}
	if !strings.Contains(strings.ToLower(got[0]), "upgrade") {
		t.Fatalf("上游应看到 Connection 含 Upgrade，实际 %q", got[0])
	}
}

// TestReverseProxy_HopByHopNamedInConnectionIsStripped RFC 7230 §6.1：中间节点必须
// 把 Connection 里**点名**的任意头也当逐跳处理，不能只认内置短名单。
//
// 这条用于证明「不自研剥头」不等于「不剥」：我们依赖标准库的 removeHopByHopHeaders，
// 它两个方向都覆盖。有人若把它换成只删固定名单的自研实现，这里会红。
func TestReverseProxy_HopByHopNamedInConnectionIsStripped(t *testing.T) {
	seen := make(chan [2]string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- [2]string{r.Header.Get("X-Custom-Hop"), r.Header.Get("Proxy-Authorization")}
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()

	u, _ := url.Parse(upstream.URL)
	front := httptest.NewServer(NewReverseProxy(u, http.DefaultTransport))
	defer front.Close()

	status := rawRequest(t, front.Listener.Addr().String(),
		"GET /x HTTP/1.1",
		"Connection: X-Custom-Hop",
		"X-Custom-Hop: should-be-stripped",
		"Proxy-Authorization: should-be-stripped",
	)
	if !strings.Contains(status, "200") {
		t.Fatalf("期望 200，实际状态行 %q", status)
	}
	got := <-seen
	if got[0] != "" {
		t.Errorf("Connection 点名的 X-Custom-Hop 未被剥除: %q", got[0])
	}
	if got[1] != "" {
		t.Errorf("内置短名单里的 Proxy-Authorization 未被剥除: %q", got[1])
	}
}

// rawRequest 用裸 TCP 发一个带指定头的最小 HTTP/1.1 请求，返回状态行。
//
// 用裸连接而不是 http.Client：其一，Go 的 client 对 101 有独立处理、也可能替调用方
// 规范 Connection 这类头，会把「网关做了什么」和「客户端做了什么」混在一起；其二，
// 这里要构造的正是「客户端自报 Connection: <自定义令牌>」这种 http.Client 不鼓励的
// 请求形态，而它恰恰是 RFC 7230 §6.1 那条规则要防的输入。
func rawRequest(t *testing.T, addr, requestLine string, extraHeaders ...string) string {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("拨号 %s 失败: %v", addr, err)
	}
	defer conn.Close()

	var b strings.Builder
	b.WriteString(requestLine + "\r\n")
	b.WriteString("Host: " + addr + "\r\n")
	for _, h := range extraHeaders {
		b.WriteString(h + "\r\n")
	}
	b.WriteString("\r\n")
	if _, err := fmt.Fprint(conn, b.String()); err != nil {
		t.Fatalf("写请求失败: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatalf("读状态行失败: %v", err)
	}
	return strings.TrimSpace(line)
}
