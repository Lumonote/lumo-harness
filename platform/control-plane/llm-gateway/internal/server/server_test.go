package server_test

// server 层行为测试（活库 + 假 OpenAI 上游）：判据 1-5。
// 判据 6（四态矩阵）在 domain 包；判据 7（全链联测）在 compose 冒烟。
//
// 假上游是被测面的合法替身——被测的是网关截面（归因/执法/计量），不是上游模型。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/llm-gateway/internal/gateway"
	"github.com/lumo-harness/platform/llm-gateway/internal/server"
	"github.com/lumo-harness/platform/llm-gateway/internal/store"
)

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过 llm-gateway server 测试（活库）")
	}
	return dsn
}

// fakeUpstream 假 OpenAI 兼容上游：记录收到的请求（断言网关注入了 stream_options），
// 流式回三个 chunk + usage，非流式回全量 JSON。withUsage=false 时吞掉 usage。
type fakeUpstream struct {
	ts         *httptest.Server
	gotStream  bool
	gotOptions bool // 网关是否注入了 stream_options.include_usage
	withUsage  bool
}

func newFakeUpstream(t *testing.T, withUsage bool) *fakeUpstream {
	t.Helper()
	f := &fakeUpstream{withUsage: withUsage}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Stream         bool           `json:"stream"`
			StreamOptions  map[string]any `json:"stream_options"`
		}
		_ = json.Unmarshal(body, &req)
		f.gotStream = req.Stream
		if req.Stream {
			f.gotOptions = req.StreamOptions != nil && req.StreamOptions["include_usage"] == true
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if !req.Stream {
			w.Header().Set("Content-Type", "application/json")
		}
		w.WriteHeader(200)
		flusher := w.(http.Flusher)
		if req.Stream {
			chunks := []string{
				`data: {"model":"test-model","choices":[{"delta":{"content":"你"}}]}`,
				`data: {"model":"test-model","choices":[{"delta":{"content":"好"}}]}`,
			}
			if f.withUsage {
				chunks = append(chunks, `data: {"model":"test-model","choices":[],"usage":{"prompt_tokens":30,"completion_tokens":12,"total_tokens":42}}`)
			}
			chunks = append(chunks, `data: [DONE]`)
			for _, c := range chunks {
				_, _ = w.Write([]byte(c + "\n\n"))
				flusher.Flush()
			}
			return
		}
		resp := map[string]any{
			"model": "test-model",
			"choices": []map[string]any{{"message": map[string]any{"role": "assistant", "content": "好的"}}},
		}
		if f.withUsage {
			resp["usage"] = map[string]any{"prompt_tokens": 30, "completion_tokens": 12, "total_tokens": 42}
		}
		_ = json.NewEncoder(w).Encode(resp)
	})
	f.ts = httptest.NewServer(mux)
	t.Cleanup(f.ts.Close)
	return f
}

// setup：独立 schema + metering 依赖表同构（budget_trees/usage_event_outbox——DDL
// 真相源在 TS pg-meter.ts，此处列子集够用）+ 网关测试服。
func setup(t *testing.T, upstreamURL string) (*httptest.Server, *pgxpool.Pool) {
	t.Helper()
	schema := fmt.Sprintf("gw_srv_%d", time.Now().UnixNano())
	base := testDSN(t)
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
	for _, ddl := range []string{
		`CREATE TABLE IF NOT EXISTS budget_trees (
		   kind TEXT NOT NULL, id TEXT NOT NULL, budget BIGINT NOT NULL,
		   budget_total BIGINT, soft_limit BIGINT, overdraft BIGINT,
		   PRIMARY KEY (kind, id))`,
		`CREATE TABLE IF NOT EXISTS usage_event_outbox (
		   seq BIGSERIAL PRIMARY KEY, event_key TEXT NOT NULL UNIQUE,
		   payload JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT now(),
		   projected_at TIMESTAMPTZ, published_at TIMESTAMPTZ)`,
	} {
		if _, err := pool.Exec(context.Background(), ddl); err != nil {
			t.Fatalf("建依赖表: %v", err)
		}
	}
	st := store.New(pool)
	if err := st.Init(context.Background()); err != nil {
		t.Fatalf("init: %v", err)
	}
	// provider：费率 in=3$/Mtok out=15$/Mtok（好算：42 tokens = 30in+12out → 30*3/1e6 + 12*15/1e6 = 0.00027）
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO llm_providers (model, upstream_base_url, price_in_per_mtok, price_out_per_mtok)
		VALUES ('test-model', $1, 3, 15)`, upstreamURL); err != nil {
		t.Fatalf("种子 provider: %v", err)
	}
	mux := http.NewServeMux()
	server.New(st, gateway.New(http.DefaultClient, func(string, ...any) {}), nil).Register(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, pool
}

func seedBudgets(t *testing.T, pool *pgxpool.Pool, userBudget, userTotal, projBudget, projTotal int64) {
	t.Helper()
	for _, row := range []struct{ kind, id string; budget, total int64 }{
		{"user", "u1", userBudget, userTotal},
		{"project", "p1", projBudget, projTotal},
	} {
		if _, err := pool.Exec(context.Background(), `
			INSERT INTO budget_trees (kind, id, budget, budget_total, soft_limit, overdraft)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			row.kind, row.id, row.budget, row.total, row.total*8/10, row.total/10); err != nil {
			t.Fatalf("种子预算: %v", err)
		}
	}
}

func call(t *testing.T, ts *httptest.Server, stream bool, extraHeaders map[string]string) (*http.Response, string) {
	t.Helper()
	body := map[string]any{
		"model":    "test-model",
		"messages": []map[string]string{{"role": "user", "content": "hi"}},
	}
	if stream {
		body["stream"] = true
	}
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", ts.URL+"/v1/chat/completions", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lumo-Realm", "r1")
	for k, v := range map[string]string{
		"X-Lumo-User": "u1", "X-Lumo-Dept": "d1", "X-Lumo-Role": "viewer",
		"X-Lumo-Project": "p1",
	} {
		req.Header.Set(k, v)
	}
	for k, v := range extraHeaders {
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

type outboxEvent struct {
	CostType string `json:"costType"`
	Qty      float64 `json:"qty"`
	Unit     string `json:"unit"`
	TraceID  string `json:"traceId"`
	Emitter  string `json:"emitter"`
	CostUSD  float64 `json:"costUsd"`
	Tokens   *int64 `json:"tokens"`
	Model    string `json:"model"`
	Context  struct {
		UserID, DeptID, Role, ProjectID, AgentID, ComponentID, Feature, SessionRef string
	} `json:"context"`
}

func readOutbox(t *testing.T, pool *pgxpool.Pool) []outboxEvent {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT payload FROM usage_event_outbox ORDER BY seq`)
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

func treeBudget(t *testing.T, pool *pgxpool.Pool, kind, id string) int64 {
	t.Helper()
	var v int64
	if err := pool.QueryRow(context.Background(),
		`SELECT budget FROM budget_trees WHERE kind=$1 AND id=$2`, kind, id).Scan(&v); err != nil {
		t.Fatalf("读树: %v", err)
	}
	return v
}

// 判据 1：非流式——恰好 1 事件（归因全维度/qty=tokens/costUsd=费率算出/emitter）+ 双树扣减。
func TestChatNonStreamMeters(t *testing.T) {
	up := newFakeUpstream(t, true)
	ts, pool := setup(t, up.ts.URL)
	seedBudgets(t, pool, 1000, 1000, 1000, 1000)

	resp, body := call(t, ts, false, map[string]string{"X-Lumo-Feature": "kb:qa", "X-Lumo-Session": "s9"})
	if resp.StatusCode != 200 || !strings.Contains(body, "好的") {
		t.Fatalf("非流式响应异常: %d %s", resp.StatusCode, body)
	}
	events := readOutbox(t, pool)
	if len(events) != 1 {
		t.Fatalf("应恰好 1 条事件, got %d", len(events))
	}
	e := events[0]
	if e.Emitter != "llm-gateway" || e.CostType != "llm.tokens" || e.Unit != "tokens" {
		t.Fatalf("截面标识: %+v", e)
	}
	if e.Qty != 42 || e.Tokens == nil || *e.Tokens != 42 {
		t.Fatalf("token 截面: %+v", e)
	}
	// costUsd = 30*3/1e6 + 12*15/1e6 = 0.00027
	if e.CostUSD < 0.000269 || e.CostUSD > 0.000271 {
		t.Fatalf("费率算出 costUsd: %v", e.CostUSD)
	}
	if e.Context.UserID != "u1" || e.Context.ProjectID != "p1" || e.Context.Feature != "kb:qa" ||
		e.Context.SessionRef != "s9" || e.Context.ComponentID != "llm-gateway" || e.Context.AgentID != "system" {
		t.Fatalf("归因: %+v", e.Context)
	}
	if !strings.HasPrefix(e.TraceID, "gw-") {
		t.Fatalf("网关应铸 trace: %s", e.TraceID)
	}
	if bu, bp := treeBudget(t, pool, "user", "u1"), treeBudget(t, pool, "project", "p1"); bu != 1000-42 || bp != 1000-42 {
		t.Fatalf("双树扣减: user=%d project=%d", bu, bp)
	}
}

// 判据 2：流式——chunk 顺序透传 + usage 提取 + 网关注入 stream_options。
func TestChatStreamMeters(t *testing.T) {
	up := newFakeUpstream(t, true)
	ts, pool := setup(t, up.ts.URL)
	seedBudgets(t, pool, 1000, 1000, 1000, 1000)

	resp, body := call(t, ts, true, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("流式状态: %d", resp.StatusCode)
	}
	if got := strings.Count(body, "\"content\""); got != 2 {
		t.Fatalf("两个内容 chunk 应透传: %s", body)
	}
	if !strings.Contains(body, "\"usage\":{\"prompt_tokens\":30") {
		t.Fatalf("usage chunk 应透传给客户端: %s", body)
	}
	if !up.gotOptions {
		t.Fatalf("网关应给上游注入 stream_options.include_usage（客户端没带时）")
	}
	events := readOutbox(t, pool)
	if len(events) != 1 || events[0].Qty != 42 {
		t.Fatalf("流式计量: %+v", events)
	}
	if bu := treeBudget(t, pool, "user", "u1"); bu != 1000-42 {
		t.Fatalf("流式扣减: %d", bu)
	}
}

// 判据 3：reserve——任一树 hard → 402 且 reason 区分树。
func TestReserveRejects(t *testing.T) {
	up := newFakeUpstream(t, true)
	ts, pool := setup(t, up.ts.URL)
	// user hard（budget=-2000, total=1000, od=100 → used=3000+ ≥ 1100）；project 健康
	seedBudgets(t, pool, -2000, 1000, 1000, 1000)
	resp, body := call(t, ts, false, nil)
	if resp.StatusCode != 402 || !strings.Contains(body, "denied-user-budget") {
		t.Fatalf("user 树 hard 应 402 denied-user-budget: %d %s", resp.StatusCode, body)
	}
	if n := len(readOutbox(t, pool)); n != 0 {
		t.Fatalf("拒绝不得计事件: %d", n)
	}
	// user 健康；project hard
	seedBudgetsUpdate(t, pool, "user", "u1", 1000)
	seedBudgetsUpdate(t, pool, "project", "p1", -2000)
	resp, body = call(t, ts, false, nil)
	if resp.StatusCode != 402 || !strings.Contains(body, "denied-project-budget") {
		t.Fatalf("project 树 hard 应 402 denied-project-budget: %d %s", resp.StatusCode, body)
	}
}

func seedBudgetsUpdate(t *testing.T, pool *pgxpool.Pool, kind, id string, budget int64) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE budget_trees SET budget=$3 WHERE kind=$1 AND id=$2`, kind, id, budget); err != nil {
		t.Fatalf("改树: %v", err)
	}
}

// 判据 4：上游缺 usage → 事件计 0（仍恰好 1 条——完整性优先于数值）。
func TestUpstreamNoUsageMetersZero(t *testing.T) {
	up := newFakeUpstream(t, false)
	ts, pool := setup(t, up.ts.URL)
	seedBudgets(t, pool, 1000, 1000, 1000, 1000)
	resp, _ := call(t, ts, false, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("无 usage 上游不应失败: %d", resp.StatusCode)
	}
	events := readOutbox(t, pool)
	if len(events) != 1 || events[0].Qty != 0 {
		t.Fatalf("缺 usage 应计 0 且仍 1 条事件: %+v", events)
	}
	if bu := treeBudget(t, pool, "user", "u1"); bu != 1000 {
		t.Fatalf("计 0 不扣减: %d", bu)
	}
}

// 判据 5：缺归因头 400（报缺哪个）；未知模型 404。
func TestGuards(t *testing.T) {
	up := newFakeUpstream(t, true)
	ts, pool := setup(t, up.ts.URL)
	seedBudgets(t, pool, 1000, 1000, 1000, 1000)

	// 缺 X-Lumo-Dept
	req, _ := http.NewRequest("POST", ts.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"test-model","messages":[]}`))
	req.Header.Set("X-Lumo-Realm", "r1")
	req.Header.Set("X-Lumo-User", "u1")
	req.Header.Set("X-Lumo-Role", "viewer")
	req.Header.Set("X-Lumo-Project", "p1")
	resp, body := call0(req)
	if resp.StatusCode != 400 || !strings.Contains(body, "X-Lumo-Dept") {
		t.Fatalf("缺 Dept 应 400 并报头名: %d %s", resp.StatusCode, body)
	}
	// 未知模型
	req2, _ := http.NewRequest("POST", ts.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"no-such","messages":[]}`))
	for k, v := range map[string]string{
		"X-Lumo-Realm": "r1", "X-Lumo-User": "u1", "X-Lumo-Dept": "d1",
		"X-Lumo-Role": "viewer", "X-Lumo-Project": "p1",
	} {
		req2.Header.Set(k, v)
	}
	resp2, body2 := call0(req2)
	if resp2.StatusCode != 404 || !strings.Contains(body2, "unknown_model") {
		t.Fatalf("未知模型应 404: %d %s", resp2.StatusCode, body2)
	}
}

func call0(req *http.Request) (*http.Response, string) {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err.Error()
	}
	buf := new(bytes.Buffer)
	_, _ = buf.ReadFrom(resp.Body)
	resp.Body.Close()
	return resp, buf.String()
}
