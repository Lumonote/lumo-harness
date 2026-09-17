package server

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/terminal-gateway/internal/capability"
	"github.com/lumo-harness/platform/terminal-gateway/internal/events"
	"github.com/lumo-harness/platform/terminal-gateway/internal/policy"
	"github.com/lumo-harness/platform/terminal-gateway/internal/presence"
	"github.com/lumo-harness/platform/terminal-gateway/internal/ws"
)

func newTestServer(t *testing.T, opts Options) *httptest.Server {
	t.Helper()
	srv := New(opts)
	mux := http.NewServeMux()
	srv.Routes(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func TestPresenceQuery(t *testing.T) {
	store := presence.NewStore(30*time.Second, nil)
	store.Touch(presence.Entry{
		SessionRef: "s1", TerminalID: "t1", Kind: capability.KindWeb,
		Renderers: []capability.RendererKey{capability.RendererChart},
	})
	ts := newTestServer(t, Options{Presence: store})

	resp, err := http.Get(ts.URL + "/v1/terminals/s1/presence")
	if err != nil {
		t.Fatalf("查询 presence 失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("presence 查询应 200，得到 %d", resp.StatusCode)
	}
	var body struct {
		Presence []struct {
			TerminalID string `json:"terminal_id"`
			Kind       string `json:"kind"`
		} `json:"presence"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("解析 presence 响应失败: %v", err)
	}
	if len(body.Presence) != 1 || body.Presence[0].TerminalID != "t1" {
		t.Fatalf("presence 内容不符: %+v", body.Presence)
	}
}

// 反例：未配置历史事件源 → 诚实 503，绝不能伪造空历史让终端以为「本就没有事件」。
func TestNoEventSource_503(t *testing.T) {
	ts := newTestServer(t, Options{}) // Source 为 nil
	resp, err := http.Get(ts.URL + "/v1/terminals/s1")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("未配置来源应 503，得到 %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), "no_event_source") {
		t.Fatalf("503 响应应说明没有历史源，得到 %q", string(b))
	}
}

// 反例：握手缺 Sec-WebSocket-Key → 必须在劫持前以 400 拒绝。
func TestWS_BadHandshake_NoKey(t *testing.T) {
	mem := events.NewMemory()
	ts := newTestServer(t, Options{Source: mem})

	u, _ := url.Parse(ts.URL)
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	req := "GET /v1/terminals/s1 HTTP/1.1\r\nHost: " + u.Host +
		"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n"
	conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	br := bufio.NewReader(conn)
	status, _ := br.ReadString('\n')
	if !strings.Contains(status, "400") {
		t.Fatalf("缺 key 应返回 400，得到 %q", status)
	}
}

// wsClient 是测试用的极简 WebSocket 客户端（仅覆盖本网关用到的路径）。
type wsClient struct {
	conn   net.Conn
	reader *bufio.Reader
	writer *bufio.Writer
}

func (c *wsClient) Close() error { return c.conn.Close() }

func (c *wsClient) write(payload string) {
	// 单条完整消息：Fin 必须为 true，否则服务端会按分片帧（FIN=0）拒绝。
	if err := ws.WriteClientFrame(c.writer, ws.Frame{Fin: true, OpCode: ws.OpText, Payload: []byte(payload)}); err != nil {
		panic(err)
	}
}

func (c *wsClient) read(t *testing.T) map[string]any {
	t.Helper()
	c.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	f, err := ws.ReadFrameFrom(c.reader, 1<<20, false) // 服务端帧不掩码
	if err != nil {
		t.Fatalf("读服务端帧失败: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(f.Payload, &m); err != nil {
		t.Fatalf("帧不是 JSON: %v payload=%q", err, string(f.Payload))
	}
	return m
}

// dialWS 完成握手并返回客户端。断言拿到 101。
func dialWS(t *testing.T, ts *httptest.Server, path string) *wsClient {
	t.Helper()
	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	// 16 字节固定 key 即可：握手只校验 key 存在且接受值 = SHA1(key+magic) 的 base64，
	// 内容是否随机对测试无关紧要。
	acceptKey := base64.StdEncoding.EncodeToString([]byte("a-16-byte-key!!"))
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n",
		path, u.Host, acceptKey)
	conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(conn)
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	status, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("读握手响应失败: %v", err)
	}
	if !strings.Contains(status, "101") {
		t.Fatalf("握手应返回 101，得到 %q", status)
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("读握手响应头失败: %v", err)
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	return &wsClient{conn: conn, reader: br, writer: bufio.NewWriter(conn)}
}

// 完整 happy path：能力声明 → 协商结果 → replay 历史，并验证 presence 已注册。
func TestWS_Happy_ReplayAndNegotiation(t *testing.T) {
	mem := events.NewMemory()
	mem.Append("s1", events.Event{Type: "step", NodeKind: "cost", Payload: json.RawMessage(`{"i":1}`)})
	mem.Append("s1", events.Event{Type: "step", NodeKind: "cost", Payload: json.RawMessage(`{"i":2}`)})
	store := presence.NewStore(30*time.Second, nil)
	ts := newTestServer(t, Options{Source: mem, Presence: store, Auth: policy.NewAuthorizer("k", "")})

	cli := dialWS(t, ts, "/v1/terminals/s1")
	defer cli.Close()

	// 声明能力：web，认识 chart/table → 协商应得 chart。
	cli.write(`{"terminal_id":"t1","capabilities":{"kind":"web","renderers":["chart","table"]}}`)

	neg := cli.read(t)
	if neg["type"] != "capability_negotiated" {
		t.Fatalf("首帧应为协商结果，得到 %v", neg)
	}
	ev1 := cli.read(t)
	ev2 := cli.read(t)
	for _, ev := range []map[string]any{ev1, ev2} {
		if ev["type"] != "session_event" {
			t.Fatalf("应为 session_event，得到 %v", ev)
		}
		if ev["renderer"] != "chart" {
			t.Fatalf("web 应协商出 chart，得到 renderer=%v", ev["renderer"])
		}
	}

	// presence 已通过该连接注册（查询早于关闭，避免 defer Leave 清理）。
	pres := getPresence(t, ts, "s1")
	if len(pres) != 1 || pres[0]["terminal_id"] != "t1" {
		t.Fatalf("presence 应含 t1，得到 %v", pres)
	}
}

// live push：连接后新追加的事件应通过订阅实时推给客户端。
func TestWS_LivePush(t *testing.T) {
	mem := events.NewMemory() // 不预置事件，先只收协商帧
	ts := newTestServer(t, Options{Source: mem, Auth: policy.NewAuthorizer("k", "")})

	cli := dialWS(t, ts, "/v1/terminals/s1")
	defer cli.Close()
	cli.write(`{"terminal_id":"t1","capabilities":{"kind":"cli","renderers":["table"]}}`)

	// 先收协商帧。
	neg := cli.read(t)
	if neg["type"] != "capability_negotiated" {
		t.Fatalf("首帧应为协商结果，得到 %v", neg)
	}
	// 然后服务端侧追加一条事件 → 应被实时推到。
	mem.Append("s1", events.Event{Type: "live", NodeKind: "cost", Payload: json.RawMessage(`{"i":99}`)})
	live := cli.read(t) // 带 3s 超时
	if live["type"] != "session_event" {
		t.Fatalf("应收到 live 事件，得到 %v", live)
	}
	if live["renderer"] != "table" {
		t.Fatalf("cli 应协商出 table，得到 renderer=%v", live["renderer"])
	}
}

// 敏感动作（claim_control）但 OPA 未配置 → 必须 fail-closed 拒绝，并写明原因。
func TestWS_ControlClaim_OPAUnconfigured(t *testing.T) {
	mem := events.NewMemory()
	ts := newTestServer(t, Options{Source: mem, Auth: policy.NewAuthorizer("k", "")}) // OPA 未配置

	cli := dialWS(t, ts, "/v1/terminals/s1")
	defer cli.Close()
	cli.write(`{"terminal_id":"t1","capabilities":{"kind":"web","renderers":["chart"]}}`)
	neg := cli.read(t)
	if neg["type"] != "capability_negotiated" {
		t.Fatalf("首帧应为协商结果，得到 %v", neg)
	}

	// 构造一条带签名的 claim_control（密钥 "k"，与 Authorizer 一致）。
	claim := policy.ControlClaim{
		SessionRef:    "s1",
		Claimant:      "u1",
		CredentialKey: policy.CredentialKey{Realm: "r1", Role: "operator", User: "u1"},
	}
	msg := map[string]any{
		"action":      "claim_control",
		"session_ref": claim.SessionRef,
		"claimant":    claim.Claimant,
		"realm":       claim.Realm,
		"role":        claim.Role,
		"user":        claim.User,
		"signature":   policy.Sign("k", claim),
	}
	payload, _ := json.Marshal(msg)
	cli.write(string(payload))

	res := cli.read(t)
	if res["type"] != "control_claim_result" {
		t.Fatalf("应回 control_claim_result，得到 %v", res)
	}
	if res["allowed"] != false {
		t.Fatalf("OPA 未配置必须 fail-closed 拒绝，却放行了")
	}
	if !strings.Contains(fmt.Sprint(res["reason"]), "OPA 未配置") {
		t.Fatalf("拒绝原因应写明 OPA 未配置，得到 %v", res["reason"])
	}
}

// 非敏感控制指令（如 pause）本网关不处理：应回「只渲染视图」的拒绝，而非偷偷落地状态机。
func TestWS_NonSensitiveAction_Rejected(t *testing.T) {
	mem := events.NewMemory()
	ts := newTestServer(t, Options{Source: mem, Auth: policy.NewAuthorizer("k", "")})
	cli := dialWS(t, ts, "/v1/terminals/s1")
	defer cli.Close()
	cli.write(`{"terminal_id":"t1","capabilities":{"kind":"web","renderers":["chart"]}}`)
	neg := cli.read(t)
	if neg["type"] != "capability_negotiated" {
		t.Fatalf("首帧应为协商结果，得到 %v", neg)
	}
	cli.write(`{"action":"pause"}`)
	res := cli.read(t)
	if res["type"] != "error" {
		t.Fatalf("非敏感指令应回 error，得到 %v", res)
	}
	if !strings.Contains(fmt.Sprint(res["message"]), "只渲染视图") {
		t.Fatalf("拒绝原因应说明只渲染视图，得到 %v", res["message"])
	}
}

func getPresence(t *testing.T, ts *httptest.Server, session string) []map[string]any {
	t.Helper()
	resp, err := http.Get(ts.URL + "/v1/terminals/" + session + "/presence")
	if err != nil {
		t.Fatalf("查询 presence 失败: %v", err)
	}
	defer resp.Body.Close()
	var body struct {
		Presence []map[string]any `json:"presence"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("解析 presence 失败: %v", err)
	}
	return body.Presence
}
