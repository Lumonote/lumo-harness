// Package server_test 连接器网关接入面行为测试（真 PG + httptest 假上游）。
//
// 判据（seam 远程形态 §1 项 8）：
//  1. /web/fetch 公网放行（AllowPrivateNetwork=true 打 httptest —— 单测上游
//     只能落在 127.0.0.1，仅公网禁令在测试里经显式配置放行，与设计说明同法）；
//  2. 全局黑名单拒绝（策略层单测在 policy 包，这里锁一条走 server 的断言）；
//  3. 私网拒绝（strict 模式 guardDial 按真实建连地址复核）；
//  4. 重定向不跟随（302 如实返回，上游命中数=1）；
//  5. 响应超限 → payload_too_large；
//  6. 响应脱敏 redacted=true（PII 形态字符串被掩码）；
//  7. 限速 429（假 redis.Scripter 注入令牌桶）；
//  8. 缺身份 401；
//  9. 审计+计量同事务双行（outbox payload 形状逐字段断言）；
//
// 10. denied → 审计有行、计量无行；
// 11. 缺 X-Lumo-Dept → 入账 dept='unknown' 且非 400（缺省+告警，不破现有链）；
// 12. 传输错误（响应缺失）→ 计量无行、审计有行；
// 13. invoke 路径同法断计量行。
package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/lumo-harness/platform/connector-gateway/internal/approval"
	"github.com/lumo-harness/platform/connector-gateway/internal/audit"
	"github.com/lumo-harness/platform/connector-gateway/internal/breaker"
	"github.com/lumo-harness/platform/connector-gateway/internal/credentials"
	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
	"github.com/lumo-harness/platform/connector-gateway/internal/gateway"
	"github.com/lumo-harness/platform/connector-gateway/internal/policy"
	"github.com/lumo-harness/platform/connector-gateway/internal/ratelimit"
	"github.com/lumo-harness/platform/connector-gateway/internal/registry"
	"github.com/lumo-harness/platform/connector-gateway/internal/server"
)

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过 connector-gateway server 测试（真 PG）")
	}
	return dsn
}

// redisErr 是 redis.Error 的最小实现（error + 一个 RedisError() 空方法）。
//
// 必须用它而不是 `errors.New`：go-redis 判断「脚本未加载」走的是
// `errors.As(err, &redis.Error)`（v9 的 `HasErrorPrefix`，见依赖的 error.go），
// 而不是字符串前缀匹配。返回普通 error 时 `Script.Run` 的 NOSCRIPT→EVAL 回退
// **不会触发**，脚本一次都没执行，`Allow` 直接把错误抛上去 —— 网关那边落到
// 「限流器不可用，保守拒绝」，于是「第一次应放行」拿到 429。
// 这个 fake 是按旧版 go-redis（纯字符串前缀）写的，依赖升级后悄悄失效了。
type redisErr string

func (e redisErr) Error() string { return string(e) }
func (e redisErr) RedisError()   {}

// fakeScripter 假 redis.Scripter：限流 Lua 走 EVAL（EvalSha 回 NOSCRIPT 让
// go-redis 落回 EVAL），前 allow 次放行、之后拒绝。不依赖真 Redis。
type fakeScripter struct {
	mu    sync.Mutex
	calls int
	allow int
}

type catalogRegistry struct {
	visible   []domain.Connector
	all       []domain.Connector
	allCalls  int
	enabledID string
}

func (r *catalogRegistry) Lookup(_ context.Context, _ domain.RealmID, _ string) (domain.Connector, error) {
	return domain.Connector{}, domain.ErrNotFound
}
func (r *catalogRegistry) List(_ context.Context, _ domain.RealmID) ([]domain.Connector, error) {
	return r.visible, nil
}
func (r *catalogRegistry) ListAll(_ context.Context, _ domain.RealmID) ([]domain.Connector, error) {
	r.allCalls++
	return r.all, nil
}
func (r *catalogRegistry) Upsert(_ context.Context, _ domain.Connector) error          { return nil }
func (r *catalogRegistry) Disable(_ context.Context, _ domain.RealmID, _ string) error { return nil }
func (r *catalogRegistry) Enable(_ context.Context, _ domain.RealmID, id string) error {
	r.enabledID = id
	return nil
}

func (f *fakeScripter) Eval(ctx context.Context, _ string, _ []string, _ ...any) *redis.Cmd {
	f.mu.Lock()
	f.calls++
	ok := f.calls <= f.allow
	f.mu.Unlock()
	cmd := redis.NewCmd(ctx)
	v, retry := int64(0), int64(60_000)
	if ok {
		v, retry = 1, 0
	}
	cmd.SetVal([]any{v, retry})
	return cmd
}

func (f *fakeScripter) EvalSha(ctx context.Context, _ string, _ []string, _ ...any) *redis.Cmd {
	cmd := redis.NewCmd(ctx)
	cmd.SetErr(redisErr("NOSCRIPT No matching script"))
	return cmd
}

func (f *fakeScripter) EvalRO(ctx context.Context, _ string, _ []string, _ ...any) *redis.Cmd {
	cmd := redis.NewCmd(ctx)
	cmd.SetErr(redisErr("NOSCRIPT No matching script"))
	return cmd
}

func (f *fakeScripter) EvalShaRO(ctx context.Context, _ string, _ []string, _ ...any) *redis.Cmd {
	cmd := redis.NewCmd(ctx)
	cmd.SetErr(redisErr("NOSCRIPT No matching script"))
	return cmd
}

func (f *fakeScripter) ScriptExists(_ context.Context, _ ...string) *redis.BoolSliceCmd {
	return redis.NewBoolSliceCmd(context.Background())
}

func (f *fakeScripter) ScriptLoad(_ context.Context, _ string) *redis.StringCmd {
	return redis.NewStringCmd(context.Background())
}

// testAuth 镜像 main.go 的 headerAuth（main 包不可导入）：
// X-Lumo-User/Realm 必填，归因元数据头可空（缺省在网关 buildMeter）。
type testAuth struct{}

func (testAuth) Authenticate(r *http.Request) (domain.Caller, error) {
	uid := r.Header.Get("X-Lumo-User")
	realm := r.Header.Get("X-Lumo-Realm")
	if uid == "" || realm == "" {
		return domain.Caller{}, errors.New("缺少网关注入的身份头")
	}
	return domain.Caller{
		UserID:      uid,
		Realm:       domain.RealmID(realm),
		Roles:       splitCSV(r.Header.Get("X-Lumo-Roles")),
		SessionID:   r.Header.Get("X-Lumo-Session"),
		ProjectID:   r.Header.Get("X-Lumo-Project"),
		DeptID:      r.Header.Get("X-Lumo-Dept"),
		Role:        r.Header.Get("X-Lumo-Role"),
		AgentID:     r.Header.Get("X-Lumo-Agent"),
		ComponentID: r.Header.Get("X-Lumo-Component"),
		Feature:     r.Header.Get("X-Lumo-Feature"),
		TraceID:     r.Header.Get("X-Lumo-Trace"),
	}, nil
}

func splitCSV(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// idHeaders 既有 TS 客户端今天就会发的身份头族（User/Realm/Roles/Project）。
func idHeaders() map[string]string {
	return map[string]string{
		"X-Lumo-User":    "u1",
		"X-Lumo-Realm":   "r1",
		"X-Lumo-Roles":   "operator",
		"X-Lumo-Project": "p1",
	}
}

func TestConnectorCatalogIncludesStoppedItemsOnlyForAdminsAndCanRestore(t *testing.T) {
	active := domain.Connector{ID: "active", Name: "Active", Protocol: domain.ProtocolREST, Version: 3, Enabled: true}
	stopped := domain.Connector{ID: "stopped", Name: "Stopped", Protocol: domain.ProtocolREST, Version: 7, Enabled: false}
	reg := &catalogRegistry{visible: []domain.Connector{active}, all: []domain.Connector{active, stopped}}
	h := server.New(server.Options{Auth: testAuth{}, Registry: reg}).Routes()

	request := func(method, target, role string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, target, nil)
		for key, value := range idHeaders() {
			r.Header.Set(key, value)
		}
		r.Header.Set("X-Lumo-Roles", role)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	visible := request(http.MethodGet, "/connectors", "operator")
	if visible.Code != http.StatusOK || reg.allCalls != 0 {
		t.Fatalf("ordinary catalog = status %d allCalls %d, want 200 and no stopped lookup", visible.Code, reg.allCalls)
	}
	var visibleBody struct {
		Connectors []struct {
			ID      string `json:"id"`
			Enabled bool   `json:"enabled"`
		} `json:"connectors"`
	}
	if err := json.NewDecoder(visible.Body).Decode(&visibleBody); err != nil {
		t.Fatal(err)
	}
	if len(visibleBody.Connectors) != 1 || !visibleBody.Connectors[0].Enabled {
		t.Fatalf("ordinary catalog leaked stopped connector: %#v", visibleBody.Connectors)
	}

	forbidden := request(http.MethodGet, "/connectors?includeDisabled=true", "operator")
	if forbidden.Code != http.StatusForbidden || reg.allCalls != 0 {
		t.Fatalf("non-admin stopped catalog = status %d allCalls %d, want 403 and no lookup", forbidden.Code, reg.allCalls)
	}
	all := request(http.MethodGet, "/connectors?includeDisabled=true", "admin")
	if all.Code != http.StatusOK || reg.allCalls != 1 {
		t.Fatalf("admin catalog = status %d allCalls %d, want 200 and 1", all.Code, reg.allCalls)
	}
	var allBody struct {
		Connectors []struct {
			ID      string `json:"id"`
			Enabled bool   `json:"enabled"`
		} `json:"connectors"`
	}
	if err := json.NewDecoder(all.Body).Decode(&allBody); err != nil {
		t.Fatal(err)
	}
	if len(allBody.Connectors) != 2 || allBody.Connectors[1].Enabled {
		t.Fatalf("admin catalog lost stopped state: %#v", allBody.Connectors)
	}

	if restored := request(http.MethodPost, "/connectors/stopped/enable", "admin"); restored.Code != http.StatusNoContent || reg.enabledID != "stopped" {
		t.Fatalf("restore = status %d id %q, want 204 and stopped", restored.Code, reg.enabledID)
	}
}

// setup 独立 schema（connector_audit/connectors 由各自 Init 建，
// usage_event_outbox 在测试内建 —— DDL 真相源在 TS pg-meter，与 llm-gateway 同规）
// + 网关测试服（httptest 假上游）。
func setup(t *testing.T, upstreamURL string, webEgress domain.WebEgress, limiter *ratelimit.Limiter) (*httptest.Server, *pgxpool.Pool, registry.Registry) {
	t.Helper()
	base := testDSN(t)
	schema := fmt.Sprintf("cg_srv_%d", time.Now().UnixNano())
	admin, err := pgxpool.New(context.Background(), base)
	if err != nil {
		t.Fatalf("admin: %v", err)
	}
	if _, err := admin.Exec(context.Background(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("建 schema: %v", err)
	}
	admin.Close()
	u, _ := url.Parse(base)
	q := u.Query()
	q.Set("options", "-c search_path="+schema)
	u.RawQuery = q.Encode()
	pool, err := pgxpool.New(context.Background(), u.String())
	if err != nil {
		t.Fatalf("连接: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(context.Background(), `
		CREATE TABLE IF NOT EXISTS usage_event_outbox (
		  seq BIGSERIAL PRIMARY KEY, event_key TEXT NOT NULL UNIQUE,
		  payload JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT now(),
		  projected_at TIMESTAMPTZ, published_at TIMESTAMPTZ)`); err != nil {
		t.Fatalf("建 usage_event_outbox: %v", err)
	}
	sink := audit.NewPg(pool)
	if err := sink.Init(context.Background()); err != nil {
		t.Fatalf("init audit: %v", err)
	}
	approvals := approval.NewPg(pool)
	if err := approvals.Init(context.Background()); err != nil {
		t.Fatalf("init approvals: %v", err)
	}
	reg := registry.NewPg(pool, time.Minute)
	if err := reg.Init(context.Background()); err != nil {
		t.Fatalf("init registry: %v", err)
	}
	gw := gateway.New(gateway.Options{
		Registry: reg,
		Creds:    credentials.NewEnvStore("CG_TEST_CRED_"),
		Policy:   policy.DefaultRules(),
		Limiter:  limiter,
		Breakers: breaker.NewGroup(breaker.DefaultConfig()),
		Audit:    sink,
		Logger:   discardLogger(),
	})
	srv := server.New(server.Options{
		Gateway: gw, Registry: reg, Breakers: breaker.NewGroup(breaker.DefaultConfig()),
		Approvals: approvals, Auth: testAuth{}, WebEgress: webEgress,
	})
	ts := httptest.NewServer(srv.Routes())
	t.Cleanup(ts.Close)
	return ts, pool, reg
}

// discardLogger 测试日志（丢弃）；缺省归因告警不该污染测试输出。
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func post(t *testing.T, ts *httptest.Server, path string, body string, hdr map[string]string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest("POST", ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatalf("构造请求: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	buf := new(bytes.Buffer)
	_, _ = buf.ReadFrom(resp.Body)
	resp.Body.Close()
	return resp, buf.String()
}

// webResp /web/fetch 的成功响应面（InvokeResult 形状 + url 回显）。
type webResp struct {
	Status      int             `json:"status"`
	URL         string          `json:"url"`
	Body        json.RawMessage `json:"body"`
	Encoding    string          `json:"encoding"`
	ContentType string          `json:"contentType"`
	Redacted    bool            `json:"redacted"`
	DurationMS  int64           `json:"durationMs"`
	Error       string          `json:"error"`
	Code        string          `json:"code"`
}

type auditRow struct {
	Decision   string
	DenyReason string
	Status     int
	Connector  string
	Operation  string
	Method     string
	TargetHost string
}

func readAudit(t *testing.T, pool *pgxpool.Pool) []auditRow {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT decision, COALESCE(deny_reason,''), COALESCE(status,-1), connector_id, operation, method, target_host
		FROM connector_audit ORDER BY id`)
	if err != nil {
		t.Fatalf("读审计: %v", err)
	}
	defer rows.Close()
	out := []auditRow{}
	for rows.Next() {
		var a auditRow
		if err := rows.Scan(&a.Decision, &a.DenyReason, &a.Status, &a.Connector, &a.Operation, &a.Method, &a.TargetHost); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, a)
	}
	return out
}

type outboxEvent struct {
	CostType string            `json:"costType"`
	Qty      float64           `json:"qty"`
	Unit     string            `json:"unit"`
	TraceID  string            `json:"traceId"`
	Emitter  string            `json:"emitter"`
	CostUSD  float64           `json:"costUsd"`
	Context  map[string]string `json:"context"`
}

func readOutbox(t *testing.T, pool *pgxpool.Pool) []outboxEvent {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT payload FROM usage_event_outbox ORDER BY seq`)
	if err != nil {
		t.Fatalf("读 outbox: %v", err)
	}
	defer rows.Close()
	out := []outboxEvent{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatalf("scan: %v", err)
		}
		var e outboxEvent
		if err := json.Unmarshal(raw, &e); err != nil {
			t.Fatalf("payload 解析: %v", err)
		}
		out = append(out, e)
	}
	return out
}

// ── 判据 1+6+9：公网放行 + 响应脱敏 + 审计计量同事务双行 ────────────────

func TestWebFetchAllowedMetersAndRedacts(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<html>联系 alice@example.com 或 13812345678</html>")
	}))
	t.Cleanup(up.Close)

	ts, pool, _ := setup(t, up.URL, domain.WebEgress{AllowPrivateNetwork: true, RedactResponse: true}, ratelimit.New(&fakeScripter{allow: 99}))
	_ = pool

	resp, body := post(t, ts, "/web/fetch", fmt.Sprintf(`{"url":%q}`, up.URL+"/page"), idHeaders())
	if resp.StatusCode != 200 {
		t.Fatalf("web fetch 应 200: %d %s", resp.StatusCode, body)
	}
	var r webResp
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		t.Fatalf("响应解析: %v", err)
	}
	if r.Status != 200 || r.URL != up.URL+"/page" || r.Encoding != "text" {
		t.Fatalf("响应面: %+v", r)
	}
	if !r.Redacted {
		t.Fatalf("PII 响应应标记 redacted=true: %s", body)
	}
	if !strings.Contains(string(r.Body), "«email»") || strings.Contains(string(r.Body), "alice@example.com") {
		t.Fatalf("邮箱应被掩码: %s", string(r.Body))
	}
	if !strings.Contains(string(r.Body), "«phone»") {
		t.Fatalf("手机号应被掩码: %s", string(r.Body))
	}

	// 审计：allowed 一行
	audits := readAudit(t, pool)
	if len(audits) != 1 || audits[0].Decision != "allowed" || audits[0].Connector != "web" || audits[0].Operation != "fetch" {
		t.Fatalf("审计行: %+v", audits)
	}
	// 计量：恰好 1 条 connector.call
	events := readOutbox(t, pool)
	if len(events) != 1 {
		t.Fatalf("应恰好 1 条计量事件, got %d", len(events))
	}
	e := events[0]
	if e.CostType != "connector.call" || e.Unit != "call" || e.Emitter != "connector-gateway" || e.Qty != 1 || e.CostUSD != 0 {
		t.Fatalf("计量截面: %+v", e)
	}
	if e.TraceID == "" {
		t.Fatalf("traceId 必填: %+v", e)
	}
	for _, k := range []string{"userId", "deptId", "role", "projectId", "agentId", "componentId", "feature", "sessionRef"} {
		if e.Context[k] == "" {
			t.Fatalf("归因八维缺 %s: %+v", k, e.Context)
		}
	}
	if e.Context["userId"] != "u1" || e.Context["projectId"] != "p1" || e.Context["role"] != "operator" {
		t.Fatalf("归因取值: %+v", e.Context)
	}
	if e.Context["feature"] != "connector.call" {
		t.Fatalf("web 路径缺省 feature 应为 connector.call: %+v", e.Context)
	}
}

// ── 判据 2：全局黑名单拒绝（走 server 的断言）─────────────────────────

func TestWebFetchBlacklistDenied(t *testing.T) {
	ts, pool, _ := setup(t, "http://unused.invalid", domain.WebEgress{AllowPrivateNetwork: true, RedactResponse: true}, ratelimit.New(&fakeScripter{allow: 99}))
	resp, body := post(t, ts, "/web/fetch", `{"url":"http://metadata.google.internal/computeMetadata/v1/"}`, idHeaders())
	if resp.StatusCode != http.StatusForbidden || !strings.Contains(body, "egress_denied") {
		t.Fatalf("黑名单应 403 egress_denied: %d %s", resp.StatusCode, body)
	}
	audits := readAudit(t, pool)
	if len(audits) != 1 || audits[0].Decision != "denied" || !strings.Contains(audits[0].DenyReason, "黑名单") {
		t.Fatalf("denied 审计行: %+v", audits)
	}
	if n := len(readOutbox(t, pool)); n != 0 {
		t.Fatalf("denied 不得计计量: %d", n)
	}
}

// ── 判据 3：私网拒绝（strict 模式 guardDial）────────────────────────────

func TestWebFetchPrivateNetworkBlocked(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "should not be reached")
	}))
	t.Cleanup(up.Close)

	// strict 模式（AllowPrivateNetwork=false）：httptest 落在 127.0.0.1，建连时被 guardDial 拦下
	ts, pool, _ := setup(t, up.URL, domain.WebEgress{RedactResponse: true}, ratelimit.New(&fakeScripter{allow: 99}))
	resp, body := post(t, ts, "/web/fetch", fmt.Sprintf(`{"url":%q}`, up.URL+"/"), idHeaders())
	if resp.StatusCode != http.StatusForbidden || !strings.Contains(body, "egress_denied") {
		t.Fatalf("私网目标应 403 egress_denied: %d %s", resp.StatusCode, body)
	}
	audits := readAudit(t, pool)
	if len(audits) != 1 || audits[0].Decision != "allowed" || !strings.Contains(audits[0].DenyReason, "上游失败") {
		t.Fatalf("私网拒审计行: %+v", audits)
	}
	if n := len(readOutbox(t, pool)); n != 0 {
		t.Fatalf("响应缺失不得计计量: %d", n)
	}
}

// ── 判据 4：重定向不跟随 ────────────────────────────────────────────────

func TestWebFetchRedirectNotFollowed(t *testing.T) {
	var hits int
	mux := http.NewServeMux()
	mux.HandleFunc("GET /start", func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.Header().Set("Location", "/target")
		w.WriteHeader(http.StatusFound)
	})
	mux.HandleFunc("GET /target", func(w http.ResponseWriter, _ *http.Request) {
		hits++
		_, _ = io.WriteString(w, "target")
	})
	up := httptest.NewServer(mux)
	t.Cleanup(up.Close)

	ts, _, _ := setup(t, up.URL, domain.WebEgress{AllowPrivateNetwork: true, RedactResponse: true}, ratelimit.New(&fakeScripter{allow: 99}))
	resp, body := post(t, ts, "/web/fetch", fmt.Sprintf(`{"url":%q}`, up.URL+"/start"), idHeaders())
	if resp.StatusCode != 200 {
		t.Fatalf("302 应如实返回: %d %s", resp.StatusCode, body)
	}
	var r webResp
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		t.Fatalf("响应解析: %v", err)
	}
	if r.Status != http.StatusFound {
		t.Fatalf("应原样带回 302: %+v", r)
	}
	if hits != 1 {
		t.Fatalf("重定向不应被跟随，上游命中数应为 1，got %d", hits)
	}
}

// ── 判据 5：响应超限 → ErrTooLarge → payload_too_large ───────────────────

func TestWebFetchResponseTooLarge(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("x", 500))
	}))
	t.Cleanup(up.Close)

	ts, pool, _ := setup(t, up.URL, domain.WebEgress{AllowPrivateNetwork: true, RedactResponse: true, MaxResponseBytes: 100}, ratelimit.New(&fakeScripter{allow: 99}))
	resp, body := post(t, ts, "/web/fetch", fmt.Sprintf(`{"url":%q}`, up.URL+"/big"), idHeaders())
	if resp.StatusCode != http.StatusRequestEntityTooLarge || !strings.Contains(body, "payload_too_large") {
		t.Fatalf("超限应 413 payload_too_large: %d %s", resp.StatusCode, body)
	}
	audits := readAudit(t, pool)
	if len(audits) != 1 || audits[0].Decision != "allowed" {
		t.Fatalf("超限审计行: %+v", audits)
	}
	if n := len(readOutbox(t, pool)); n != 0 {
		t.Fatalf("无法安全取回不计计量: %d", n)
	}
}

// ── 判据 7：限速 429（假 scripter 注入令牌桶）────────────────────────────

func TestWebFetchRateLimited(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	t.Cleanup(up.Close)

	sc := &fakeScripter{allow: 1}
	ts, _, _ := setup(t, up.URL,
		domain.WebEgress{AllowPrivateNetwork: true, RedactResponse: true, RequestsPerMinute: 60, Burst: 1},
		ratelimit.New(sc))
	hdr := idHeaders()
	resp1, _ := post(t, ts, "/web/fetch", fmt.Sprintf(`{"url":%q}`, up.URL+"/"), hdr)
	resp2, body2 := post(t, ts, "/web/fetch", fmt.Sprintf(`{"url":%q}`, up.URL+"/"), hdr)
	if resp1.StatusCode != 200 {
		t.Fatalf("第一次应放行: %d", resp1.StatusCode)
	}
	if resp2.StatusCode != http.StatusTooManyRequests || !strings.Contains(body2, "rate_limited") {
		t.Fatalf("第二次应 429 rate_limited: %d %s", resp2.StatusCode, body2)
	}
}

// ── 判据 8：缺身份 401 ──────────────────────────────────────────────────

func TestWebFetchMissingIdentity(t *testing.T) {
	ts, _, _ := setup(t, "http://unused.invalid", domain.WebEgress{AllowPrivateNetwork: true, RedactResponse: true}, ratelimit.New(&fakeScripter{allow: 99}))
	resp, _ := post(t, ts, "/web/fetch", `{"url":"http://example.com/"}`, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("缺身份应 401: %d", resp.StatusCode)
	}
}

// ── 判据 11：缺 X-Lumo-Dept → 入账 dept='unknown' 且非 400 ────────────────

func TestWebFetchAttributionDefaults(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "hello")
	}))
	t.Cleanup(up.Close)

	ts, pool, _ := setup(t, up.URL, domain.WebEgress{AllowPrivateNetwork: true, RedactResponse: true}, ratelimit.New(&fakeScripter{allow: 99}))
	// 只发既有客户端必发的头族 + X-Lumo-Trace；Dept/Agent/Component/Feature/Session 全缺
	hdr := map[string]string{
		"X-Lumo-User": "u1", "X-Lumo-Realm": "r1",
		"X-Lumo-Roles": "operator", "X-Lumo-Project": "p1",
		"X-Lumo-Trace": "tr-1",
	}
	resp, body := post(t, ts, "/web/fetch", fmt.Sprintf(`{"url":%q}`, up.URL+"/"), hdr)
	if resp.StatusCode != 200 {
		t.Fatalf("缺归因头应缺省放行而非 400: %d %s", resp.StatusCode, body)
	}
	events := readOutbox(t, pool)
	if len(events) != 1 {
		t.Fatalf("应恰好 1 条事件: %d", len(events))
	}
	c := events[0].Context
	if c["deptId"] != "unknown" || c["agentId"] != "system" || c["componentId"] != "connector-gateway" ||
		c["sessionRef"] != "system" || c["feature"] != "connector.call" || c["role"] != "operator" {
		t.Fatalf("缺省归因: %+v", c)
	}
	if events[0].TraceID != "tr-1" {
		t.Fatalf("X-Lumo-Trace 应优先: %s", events[0].TraceID)
	}
}

// ── 判据 12：传输错误 → 计量无行、审计有行 ───────────────────────────────

func TestWebFetchTransportErrorNoMeter(t *testing.T) {
	// 先起后关：拿到一个「曾经存在」的 127.0.0.1 端口 → 建连被拒（真传输错误）
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	dead := up.URL
	up.Close()

	ts, pool, _ := setup(t, dead, domain.WebEgress{AllowPrivateNetwork: true, RedactResponse: true}, ratelimit.New(&fakeScripter{allow: 99}))
	resp, body := post(t, ts, "/web/fetch", fmt.Sprintf(`{"url":%q}`, dead+"/"), idHeaders())
	if resp.StatusCode != http.StatusBadGateway || !strings.Contains(body, "upstream_error") {
		t.Fatalf("传输错误应 502 upstream_error: %d %s", resp.StatusCode, body)
	}
	audits := readAudit(t, pool)
	if len(audits) != 1 || audits[0].Decision != "allowed" || !strings.Contains(audits[0].DenyReason, "上游失败") {
		t.Fatalf("传输错误审计行: %+v", audits)
	}
	if n := len(readOutbox(t, pool)); n != 0 {
		t.Fatalf("响应缺失不得计计量: %d", n)
	}
}

// ── 判据 13：invoke 路径同法断计量行 ─────────────────────────────────────

func TestInvokeMeters(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(up.Close)

	ts, pool, reg := setup(t, up.URL, domain.WebEgress{AllowPrivateNetwork: true, RedactResponse: true}, ratelimit.New(&fakeScripter{allow: 99}))
	err := reg.Upsert(context.Background(), domain.Connector{
		ID: "c1", Realm: "r1", Name: "测试连接器", Protocol: domain.ProtocolREST,
		BaseURL: up.URL,
		Auth:    domain.Auth{Kind: domain.AuthNone},
		// 上游是 httptest（明文 http + 环回地址），必须显式声明允许内网（见 validate.go）。
		Egress: domain.Egress{AllowPrivateNetwork: true},
		Operations: map[string]domain.Operation{
			"ping": {Name: "ping", Method: "GET", Path: "/ping"},
		},
		Roles:   []string{"operator"},
		Enabled: true,
	})
	if err != nil {
		t.Fatalf("注册连接器: %v", err)
	}

	// 放行路径：计量一条 connector.call，feature 缺省 connector.invoke，trace 用 correlationId
	hdr := idHeaders()
	hdr["X-Lumo-Dept"] = "d1"
	resp, body := post(t, ts, "/connectors/c1/invoke",
		`{"operation":"ping","correlationId":"corr-1"}`, hdr)
	if resp.StatusCode != 200 {
		t.Fatalf("invoke 应 200: %d %s", resp.StatusCode, body)
	}
	events := readOutbox(t, pool)
	if len(events) != 1 || events[0].CostType != "connector.call" || events[0].Unit != "call" ||
		events[0].Emitter != "connector-gateway" || events[0].Qty != 1 {
		t.Fatalf("invoke 计量: %+v", events)
	}
	if events[0].TraceID != "corr-1" || events[0].Context["feature"] != "connector.invoke" || events[0].Context["deptId"] != "d1" {
		t.Fatalf("invoke 归因: %+v", events)
	}
	audits := readAudit(t, pool)
	if len(audits) != 1 || audits[0].Connector != "c1" || audits[0].Operation != "ping" || audits[0].Decision != "allowed" {
		t.Fatalf("invoke 审计: %+v", audits)
	}

	// deny 路径（未登记操作）：审计有行、计量无行
	resp2, body2 := post(t, ts, "/connectors/c1/invoke", `{"operation":"nope"}`, hdr)
	if resp2.StatusCode != http.StatusBadRequest || !strings.Contains(body2, "operation_invalid") {
		t.Fatalf("未登记操作应 400: %d %s", resp2.StatusCode, body2)
	}
	audits = readAudit(t, pool)
	if len(audits) != 2 || audits[1].Decision != "denied" {
		t.Fatalf("deny 审计行: %+v", audits)
	}
	if n := len(readOutbox(t, pool)); n != 1 {
		t.Fatalf("denied 不得再计计量: %d", n)
	}
}

// High-sensitivity writes must be approved by someone other than the requester.
// The approved record is bound to the exact connector version and request fields,
// and is consumed before the one permitted outbound call starts.
func TestHighSensitivityInvokeRequiresOneTimeBoundApproval(t *testing.T) {
	upstreamCalls := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(up.Close)

	ts, _, reg := setup(t, up.URL, domain.WebEgress{AllowPrivateNetwork: true, RedactResponse: true}, ratelimit.New(&fakeScripter{allow: 99}))
	if err := reg.Upsert(context.Background(), domain.Connector{
		ID: "billing", Realm: "r1", Name: "账单连接器", Protocol: domain.ProtocolREST, BaseURL: up.URL,
		Auth: domain.Auth{Kind: domain.AuthNone}, Roles: []string{"operator"}, Enabled: true,
		// 上游是 httptest（明文 http + 环回地址），必须显式声明允许内网：
		// validate.go 的规则是「https，或 http 且连接器自己 opt-in 内网」。
		Egress: domain.Egress{AllowPrivateNetwork: true},
		Operations: map[string]domain.Operation{
			"refund": {Name: "refund", Method: "POST", Path: "/refund", Write: true, Sensitivity: "high"},
		},
	}); err != nil {
		t.Fatalf("注册连接器: %v", err)
	}

	request := `{"operation":"refund","body":{"invoice":"inv-1","amount":100}}`
	resp, body := post(t, ts, "/connectors/billing/invoke", request, idHeaders())
	if resp.StatusCode != http.StatusPreconditionRequired || !strings.Contains(body, "approval_required") {
		t.Fatalf("高敏感调用应创建审批并返回 428: %d %s", resp.StatusCode, body)
	}
	var pending struct {
		Approval struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"approval"`
	}
	if err := json.Unmarshal([]byte(body), &pending); err != nil || pending.Approval.ID == "" || pending.Approval.Status != "pending" {
		t.Fatalf("审批响应不正确: body=%s err=%v", body, err)
	}
	if upstreamCalls != 0 {
		t.Fatalf("批准前不得调用上游，calls=%d", upstreamCalls)
	}

	// 即使申请人同时拥有 admin 角色也不能自行批准。
	self := idHeaders()
	self["X-Lumo-Roles"] = "admin,operator"
	resp, body = post(t, ts, "/approvals/"+pending.Approval.ID+"/approve", `{}`, self)
	if resp.StatusCode != http.StatusConflict || !strings.Contains(body, "approval_invalid") {
		t.Fatalf("申请人不得自批: %d %s", resp.StatusCode, body)
	}

	approver := idHeaders()
	approver["X-Lumo-User"] = "admin-2"
	approver["X-Lumo-Roles"] = "admin"
	resp, body = post(t, ts, "/approvals/"+pending.Approval.ID+"/approve", `{}`, approver)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"status":"approved"`) {
		t.Fatalf("管理员批准失败: %d %s", resp.StatusCode, body)
	}

	// 变更金额后即使带同一个 approvalId 也不得执行。
	resp, body = post(t, ts, "/connectors/billing/invoke", `{"operation":"refund","body":{"invoice":"inv-1","amount":101},"approvalId":"`+pending.Approval.ID+`"}`, idHeaders())
	if resp.StatusCode != http.StatusConflict || !strings.Contains(body, "approval_invalid") {
		t.Fatalf("参数漂移应拒绝: %d %s", resp.StatusCode, body)
	}
	if upstreamCalls != 0 {
		t.Fatalf("漂移请求不得调用上游，calls=%d", upstreamCalls)
	}

	resp, body = post(t, ts, "/connectors/billing/invoke", `{"operation":"refund","body":{"invoice":"inv-1","amount":100},"approvalId":"`+pending.Approval.ID+`"}`, idHeaders())
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("批准后的精确请求应执行: %d %s", resp.StatusCode, body)
	}
	if upstreamCalls != 1 {
		t.Fatalf("应只调用一次上游，calls=%d", upstreamCalls)
	}

	resp, body = post(t, ts, "/connectors/billing/invoke", `{"operation":"refund","body":{"invoice":"inv-1","amount":100},"approvalId":"`+pending.Approval.ID+`"}`, idHeaders())
	if resp.StatusCode != http.StatusConflict || !strings.Contains(body, "approval_invalid") || upstreamCalls != 1 {
		t.Fatalf("已消费批准不得重放: status=%d calls=%d body=%s", resp.StatusCode, upstreamCalls, body)
	}
}

// ── URL 校验：scheme 白名单与长度上限 ────────────────────────────────────

func TestWebFetchURLValidation(t *testing.T) {
	ts, _, _ := setup(t, "http://unused.invalid", domain.WebEgress{AllowPrivateNetwork: true, RedactResponse: true}, ratelimit.New(&fakeScripter{allow: 99}))
	hdr := idHeaders()

	resp, body := post(t, ts, "/web/fetch", `{"url":"ftp://example.com/file"}`, hdr)
	if resp.StatusCode != http.StatusForbidden || !strings.Contains(body, "egress_denied") {
		t.Fatalf("非 http/https 应 403: %d %s", resp.StatusCode, body)
	}
	long := "http://example.com/" + strings.Repeat("a", 2048)
	resp2, body2 := post(t, ts, "/web/fetch", fmt.Sprintf(`{"url":%q}`, long), hdr)
	if resp2.StatusCode != http.StatusBadRequest || !strings.Contains(body2, "operation_invalid") {
		t.Fatalf("超长 URL 应 400: %d %s", resp2.StatusCode, body2)
	}
	resp3, body3 := post(t, ts, "/web/fetch", `{"url":"not a url"}`, hdr)
	if resp3.StatusCode != http.StatusBadRequest {
		t.Fatalf("非法 URL 应 400: %d %s", resp3.StatusCode, body3)
	}
}
