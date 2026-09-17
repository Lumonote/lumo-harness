package server

// provider 管理面的 handler 契约测试：不连数据库、不起真服务。
//
// 分工：**本文件只测 handler 的契约**——路由是否匹配、状态码、错误码、JSON 形状、
// 传给存储层的入参（路径取模型名、传下去的是规范化后的副本）。SQL 语义（ON CONFLICT
// / COALESCE / NOT NULL 翻译）由 store 的活库用例覆盖，此处不重复、也**不能**用假存储
// 去断言——用假存储断言 SQL 语义等于断言自己写的假实现。
//
// 之所以放在 package server（内部测试包）而不是 server_test：需要一个假 registry，
// 而那个字段是未导出的。与其为测试导出一个构造器，不如用同包测试直接装配。
//
// 本机没有 PostgreSQL 也不该成为「HTTP 面没测过」的理由，所以这些用例全部无外部依赖。

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/llm-gateway/internal/domain"
)

// fakeRegistry 假注册表：只做「记住被怎么调用了」+「按要求返回结果」两件事，
// 不含任何 SQL 语义。
type fakeRegistry struct {
	list      []domain.ProviderConfig
	listErr   error
	one       *domain.ProviderConfig
	oneErr    error
	upserted  *domain.ProviderConfig
	upsertErr error
	deleteErr error

	gotListModel   string
	gotUpsertModel string
	gotUpsert      domain.ProviderUpsert
	upsertCalls    int
}

func (f *fakeRegistry) Providers(context.Context) ([]domain.ProviderConfig, error) {
	return f.list, f.listErr
}

func (f *fakeRegistry) ProviderConfig(_ context.Context, model string) (*domain.ProviderConfig, error) {
	f.gotListModel = model
	return f.one, f.oneErr
}

func (f *fakeRegistry) UpsertProvider(_ context.Context, model string, up domain.ProviderUpsert) (*domain.ProviderConfig, error) {
	f.upsertCalls++
	f.gotUpsertModel = model
	f.gotUpsert = up
	return f.upserted, f.upsertErr
}

func (f *fakeRegistry) DeleteProvider(_ context.Context, model string) error {
	f.gotListModel = model
	return f.deleteErr
}

func testServer(f *fakeRegistry) *httptest.Server {
	srv := &Server{
		providers: f,
		log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	mux := http.NewServeMux()
	srv.Register(mux)
	return httptest.NewServer(mux)
}

// do 发一个请求，回状态码 + 原始 body（原始 body 是必需的：断言「响应里不含密钥」
// 只能看字节）。
func do(t *testing.T, ts *httptest.Server, method, path, body string) (int, string) {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, ts.URL+path, rdr)
	if err != nil {
		t.Fatalf("构造请求: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	buf, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(buf)
}

// 模型名里的斜杠是 `{model...}` 存在的理由：单段通配符会把 openai/gpt-4 截成 404。
// 编码斜杠（%2F）与裸斜杠都要能到 handler，且 PathValue 拿到的是解码后的完整名字。
func TestProviderRoutesCarrySlashContainingModelNames(t *testing.T) {
	for _, tc := range []struct{ name, path string }{
		{"编码斜杠", "/v1/providers/openai%2Fgpt-4"},
		{"裸斜杠", "/v1/providers/openai/gpt-4"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeRegistry{one: &domain.ProviderConfig{Model: "openai/gpt-4"}}
			ts := testServer(f)
			defer ts.Close()

			code, _ := do(t, ts, http.MethodGet, tc.path, "")
			if code != http.StatusOK {
				t.Fatalf("状态码 %d", code)
			}
			if f.gotListModel != "openai/gpt-4" {
				t.Fatalf("路径参数应为 openai/gpt-4，实际 %q", f.gotListModel)
			}
		})
	}
}

// 空模型落到同一个 handler 上，得到的是「模型名不合法」而不是 mux 的 404——对配置面
// 来说，前者才是准确的原因。
//
// 两种写法都要覆盖：`/v1/providers/`（尾斜杠）与 `/v1/providers`（无尾斜杠）。
// 后者不是笔误——`{model...}` 的多段通配符**能匹配空**，所以只要该方法的字面量路由
// 不存在，`/v1/providers` 也会落到通配符 handler 上。GET 有字面量路由所以不受影响，
// PUT/DELETE 没有，于是「没点名模型」由 handler 报 400 而不是 mux 报 405。
// 这正是想要的结果：400 invalid_model 说的是「你少给了模型名」，比 405 有用。
func TestProviderRoutesRejectEmptyModelWith400(t *testing.T) {
	f := &fakeRegistry{}
	ts := testServer(f)
	defer ts.Close()

	for _, path := range []string{"/v1/providers/", "/v1/providers"} {
		for _, method := range []string{http.MethodPut, http.MethodDelete} {
			code, body := do(t, ts, method, path, "")
			if code != http.StatusBadRequest || !strings.Contains(body, "invalid_model") {
				t.Fatalf("%s %s 空模型应 400 invalid_model: %d %s", method, path, code, body)
			}
		}
	}
	if f.upsertCalls != 0 {
		t.Fatal("非法模型名不得触达存储层")
	}
}

// 列表与单个读取是两条不同路由：字面量比通配符更具体，mux 优先匹配它。
func TestProviderListAndSingleAreDistinctRoutes(t *testing.T) {
	f := &fakeRegistry{list: []domain.ProviderConfig{{Model: "a"}, {Model: "b"}}}
	ts := testServer(f)
	defer ts.Close()

	code, body := do(t, ts, http.MethodGet, "/v1/providers", "")
	if code != http.StatusOK {
		t.Fatalf("列表状态码 %d", code)
	}
	var got struct {
		Providers []domain.ProviderConfig `json:"providers"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("列表 JSON: %v (%s)", err, body)
	}
	if len(got.Providers) != 2 {
		t.Fatalf("应有 2 行: %s", body)
	}
	if f.gotListModel != "" {
		t.Fatalf("列表接口不该读单个模型，实际读了 %q", f.gotListModel)
	}
}

// 空列表必须是 `[]`，不能是 `null`——客户端 `providers.map` 会当场抛。
func TestProviderListSerialisesEmptyAsArrayNotNull(t *testing.T) {
	ts := testServer(&fakeRegistry{list: nil})
	defer ts.Close()

	code, body := do(t, ts, http.MethodGet, "/v1/providers", "")
	if code != http.StatusOK {
		t.Fatalf("状态码 %d", code)
	}
	if strings.Contains(body, "null") {
		t.Fatalf("空列表不得编成 null: %s", body)
	}
	if !strings.Contains(body, `"providers":[]`) {
		t.Fatalf("空列表应为 []: %s", body)
	}
}

// 密钥永不回传：连掩码都没有。原始字节里不得出现密钥的任何片段。
func TestProviderResponsesNeverCarryTheAPIKey(t *testing.T) {
	const secret = "sk-super-secret-value"
	f := &fakeRegistry{
		list: []domain.ProviderConfig{{Model: "a", APIKeySet: true}},
		one:  &domain.ProviderConfig{Model: "a", APIKeySet: true},
		upserted: &domain.ProviderConfig{
			Model: "a", APIKeySet: true,
		},
	}
	ts := testServer(f)
	defer ts.Close()

	for _, tc := range []struct{ name, method, path, body string }{
		{"列表", http.MethodGet, "/v1/providers", ""},
		{"单个", http.MethodGet, "/v1/providers/a", ""},
		{"写入", http.MethodPut, "/v1/providers/a", `{"upstreamBaseUrl":"http://u","apiKey":"` + secret + `"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, body := do(t, ts, tc.method, tc.path, tc.body)
			if code != http.StatusOK {
				t.Fatalf("状态码 %d: %s", code, body)
			}
			if strings.Contains(body, secret) || strings.Contains(body, "sk-") {
				t.Fatalf("响应泄露了密钥: %s", body)
			}
			// 反向确认：apiKeySet 这个「只报告存在性」的字段必须在
			if !strings.Contains(body, `"apiKeySet":true`) {
				t.Fatalf("应当只报告 apiKeySet: %s", body)
			}
		})
	}
}

// handler 必须把**规范化后**的副本交给存储层：否则「校验接受的形态」与「落库的形态」
// 分叉，读回来的 URL 与写进去的不一样。
func TestProviderUpsertPassesNormalisedCopyToStore(t *testing.T) {
	f := &fakeRegistry{upserted: &domain.ProviderConfig{Model: "gpt-4o"}}
	ts := testServer(f)
	defer ts.Close()

	code, body := do(t, ts, http.MethodPut, "/v1/providers/gpt-4o",
		`{"upstreamBaseUrl":"  http://llm:8000/v1  ","priceInPerMtok":3,"enabled":false}`)
	if code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", code, body)
	}
	if f.gotUpsertModel != "gpt-4o" {
		t.Fatalf("模型名应取自路径，实际 %q", f.gotUpsertModel)
	}
	if f.gotUpsert.UpstreamBaseURL == nil || *f.gotUpsert.UpstreamBaseURL != "http://llm:8000/v1" {
		t.Fatalf("应传规范化后的 URL，实际 %v", f.gotUpsert.UpstreamBaseURL)
	}
	if f.gotUpsert.PriceInPerMtok == nil || *f.gotUpsert.PriceInPerMtok != 3 {
		t.Fatalf("价格应带下去: %v", f.gotUpsert.PriceInPerMtok)
	}
	if f.gotUpsert.Enabled == nil || *f.gotUpsert.Enabled {
		t.Fatalf("显式 false 必须被保留（不能被当成「省略」）: %v", f.gotUpsert.Enabled)
	}
}

// 省略的字段传下去必须是 nil（= 保持原值），不能被补成零值——补零会静默清掉密钥。
func TestProviderUpsertKeepsOmittedFieldsAsNil(t *testing.T) {
	f := &fakeRegistry{upserted: &domain.ProviderConfig{Model: "gpt-4o"}}
	ts := testServer(f)
	defer ts.Close()

	code, body := do(t, ts, http.MethodPut, "/v1/providers/gpt-4o", `{"enabled":false}`)
	if code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", code, body)
	}
	if f.gotUpsert.APIKey != nil {
		t.Fatal("省略的 apiKey 必须是 nil，否则会把密钥清掉")
	}
	if f.gotUpsert.UpstreamBaseURL != nil {
		t.Fatal("省略的 upstreamBaseUrl 必须是 nil，否则会把地址清掉")
	}
	if f.gotUpsert.PriceInPerMtok != nil || f.gotUpsert.PriceOutPerMtok != nil {
		t.Fatal("省略的价格必须是 nil")
	}
}

// 空体等价于 `{}`：一个「什么都不改」的 PUT 是合法请求，该由存储层报出真正的原因
// （新建行缺地址），而不是先报一个含糊的 JSON 语法错。
func TestProviderPutAcceptsEmptyBody(t *testing.T) {
	f := &fakeRegistry{upsertErr: domain.ErrInvalidProvider}
	ts := testServer(f)
	defer ts.Close()

	code, body := do(t, ts, http.MethodPut, "/v1/providers/gpt-4o", "")
	if f.upsertCalls != 1 {
		t.Fatalf("空体应触达存储层一次，实际 %d 次", f.upsertCalls)
	}
	// 存储层报「新建行必须给地址」→ 400（不是 500）
	if code != http.StatusBadRequest || !strings.Contains(body, "invalid_provider") {
		t.Fatalf("应 400 invalid_provider: %d %s", code, body)
	}
}

func TestProviderPutRejectsBadInput(t *testing.T) {
	for _, tc := range []struct{ name, path, body, wantCode string }{
		{"body 与路径 model 不一致", "/v1/providers/gpt-4o", `{"model":"claude-3","upstreamBaseUrl":"http://u"}`, "invalid_provider"},
		{"坏 upstreamBaseUrl", "/v1/providers/gpt-4o", `{"upstreamBaseUrl":"localhost:11434"}`, "invalid_provider"},
		{"负价格", "/v1/providers/gpt-4o", `{"upstreamBaseUrl":"http://u","priceInPerMtok":-1}`, "invalid_provider"},
		{"非法模型名", "/v1/providers/" + "%20", `{"upstreamBaseUrl":"http://u"}`, "invalid_model"},
		{"JSON 语法错", "/v1/providers/gpt-4o", `{"upstreamBaseUrl":`, "invalid_body"},
		{"类型错", "/v1/providers/gpt-4o", `{"priceInPerMtok":"三块钱"}`, "invalid_body"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeRegistry{}
			ts := testServer(f)
			defer ts.Close()

			code, body := do(t, ts, http.MethodPut, tc.path, tc.body)
			if code != http.StatusBadRequest || !strings.Contains(body, tc.wantCode) {
				t.Fatalf("应 400 %s: %d %s", tc.wantCode, code, body)
			}
			if f.upsertCalls != 0 {
				t.Fatal("非法输入不得触达存储层")
			}
		})
	}
}

func TestProviderGetNotFound(t *testing.T) {
	f := &fakeRegistry{oneErr: domain.ErrProviderNotFound}
	ts := testServer(f)
	defer ts.Close()

	code, body := do(t, ts, http.MethodGet, "/v1/providers/nope", "")
	if code != http.StatusNotFound || !strings.Contains(body, "provider_not_found") {
		t.Fatalf("应 404 provider_not_found: %d %s", code, body)
	}
}

func TestProviderDelete(t *testing.T) {
	t.Run("成功回 204 且无 body", func(t *testing.T) {
		f := &fakeRegistry{}
		ts := testServer(f)
		defer ts.Close()

		code, body := do(t, ts, http.MethodDelete, "/v1/providers/gpt-4o", "")
		if code != http.StatusNoContent {
			t.Fatalf("应 204: %d %s", code, body)
		}
		if body != "" {
			t.Fatalf("204 不应带 body: %s", body)
		}
		if f.gotListModel != "gpt-4o" {
			t.Fatalf("模型名应取自路径: %q", f.gotListModel)
		}
	})
	// 删一个不存在的行不当成功：拼错的模型名会静默通过，而运维以为已经摘掉了
	t.Run("不存在回 404", func(t *testing.T) {
		f := &fakeRegistry{deleteErr: domain.ErrProviderNotFound}
		ts := testServer(f)
		defer ts.Close()

		code, body := do(t, ts, http.MethodDelete, "/v1/providers/nope", "")
		if code != http.StatusNotFound || !strings.Contains(body, "provider_not_found") {
			t.Fatalf("应 404: %d %s", code, body)
		}
	})
}

// 存储层的真实故障必须是 500 而不是被吞成 400/404：把「数据库连不上」报成「你的配置
// 不合法」会让运维去改一个根本没问题的配置。
func TestProviderStoreFailureIs500(t *testing.T) {
	boom := errors.New("connection refused")
	for _, tc := range []struct{ name, method, path, body string }{
		{"列表", http.MethodGet, "/v1/providers", ""},
		{"单个", http.MethodGet, "/v1/providers/a", ""},
		{"写入", http.MethodPut, "/v1/providers/a", `{"upstreamBaseUrl":"http://u"}`},
		{"删除", http.MethodDelete, "/v1/providers/a", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeRegistry{listErr: boom, oneErr: boom, upsertErr: boom, deleteErr: boom}
			ts := testServer(f)
			defer ts.Close()

			code, body := do(t, ts, tc.method, tc.path, tc.body)
			if code != http.StatusInternalServerError || !strings.Contains(body, "internal") {
				t.Fatalf("应 500 internal: %d %s", code, body)
			}
			if strings.Contains(body, "connection refused") {
				t.Fatalf("内部错误细节不应回给客户端: %s", body)
			}
		})
	}
}

// 未声明的方法由 mux 回 405（带 Allow）——这条钉住「管理面没有被 POST 意外打开」。
// 管理面是只读+定点写入：能 POST 到集合路径就等于开了一个批量写入口，那是另一件事，
// 要单独设计（鉴权粒度、并发语义、回滚），不能靠通配符顺手得到。
func TestProviderRoutesRejectWrongMethods(t *testing.T) {
	ts := testServer(&fakeRegistry{})
	defer ts.Close()

	// POST 完全没有对应路由 → mux 的 405
	for _, path := range []string{"/v1/providers", "/v1/providers/a"} {
		code, _ := do(t, ts, http.MethodPost, path, `{}`)
		if code != http.StatusMethodNotAllowed {
			t.Fatalf("POST %s 应 405，实际 %d", path, code)
		}
	}
	// PATCH 同理
	code, _ := do(t, ts, http.MethodPatch, "/v1/providers/a", `{}`)
	if code != http.StatusMethodNotAllowed {
		t.Fatalf("PATCH 应 405，实际 %d", code)
	}
}
