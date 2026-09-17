package server_test

// provider 管理面的**活库**用例：验的是 SQL 语义，不是 handler 契约
// （后者在 internal/server/providers_test.go，无外部依赖、本机也跑）。
//
// 这里只保留假存储**不可能**验证的两件事：
//   1. ON CONFLICT DO UPDATE 与 COALESCE($n, 现有列) 真的做到了「省略即保持」；
//   2. 新建行省略 upstreamBaseUrl 撞 NOT NULL（23502）并被翻译成 400 而不是 500。
// 其余（状态码、错误码、JSON 形状、路径参数）都在无库用例里，不在这里重复。
//
// 按项目惯例，LUMO_TEST_PG_DSN 未设置即 SKIP（本机没有 PostgreSQL 时不该变红）。
// 复用 server_test.go 的 setup()：它建独立 schema + 同构依赖表 + 网关测试服。

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lumo-harness/platform/llm-gateway/internal/domain"
)

// mgmt 发一个管理面请求。
func mgmt(t *testing.T, ts *httptest.Server, method, path, body string) (int, string) {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = bytes.NewReader([]byte(body))
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

func decodeProvider(t *testing.T, body string) domain.ProviderConfig {
	t.Helper()
	var c domain.ProviderConfig
	if err := json.Unmarshal([]byte(body), &c); err != nil {
		t.Fatalf("解析 provider: %v (%s)", err, body)
	}
	return c
}

// 建 → 读 → 部分改 → 列表 → 删 → 404。一条用例走完管理面的完整生命周期，
// 顺带把「改行省略的字段被 COALESCE 保住」钉住。
func TestProviderManagementRoundTrip(t *testing.T) {
	up := newFakeUpstream(t, true)
	ts, _ := setup(t, up.ts.URL)

	// ① 建
	code, body := mgmt(t, ts, http.MethodPut, "/v1/providers/new-model",
		`{"upstreamBaseUrl":"http://upstream:9000/v1","apiKey":"sk-abc","priceInPerMtok":3,"priceOutPerMtok":15}`)
	if code != http.StatusOK {
		t.Fatalf("建 provider 应 200: %d %s", code, body)
	}
	created := decodeProvider(t, body)
	if created.Model != "new-model" || created.UpstreamBaseURL != "http://upstream:9000/v1" ||
		!created.APIKeySet || !created.Enabled || created.PriceInPerMtok != 3 || created.PriceOutPerMtok != 15 {
		t.Fatalf("建库结果不符: %+v", created)
	}
	if created.CreatedAt.IsZero() || created.UpdatedAt.IsZero() {
		t.Fatalf("时间戳不应为空: %+v", created)
	}
	if bytes.Contains([]byte(body), []byte("sk-abc")) {
		t.Fatalf("响应泄露了密钥: %s", body)
	}

	// ② 读
	code, body = mgmt(t, ts, http.MethodGet, "/v1/providers/new-model", "")
	if code != http.StatusOK {
		t.Fatalf("读 provider 应 200: %d %s", code, body)
	}
	if got := decodeProvider(t, body); got.UpstreamBaseURL != "http://upstream:9000/v1" || !got.APIKeySet {
		t.Fatalf("读回结果不符: %+v", got)
	}

	// ③ 部分改：只给 enabled。省略的 URL / 密钥 / 费率必须原样保留
	code, body = mgmt(t, ts, http.MethodPut, "/v1/providers/new-model", `{"enabled":false}`)
	if code != http.StatusOK {
		t.Fatalf("部分改应 200: %d %s", code, body)
	}
	updated := decodeProvider(t, body)
	if updated.Enabled {
		t.Fatalf("enabled 应被改成 false: %+v", updated)
	}
	if updated.UpstreamBaseURL != "http://upstream:9000/v1" {
		t.Fatalf("省略的 upstreamBaseUrl 被清掉了: %q", updated.UpstreamBaseURL)
	}
	if !updated.APIKeySet {
		t.Fatal("省略的 apiKey 被清掉了——这是「读改写客户端」的经典事故")
	}
	if updated.PriceInPerMtok != 3 || updated.PriceOutPerMtok != 15 {
		t.Fatalf("省略的费率被清掉了: %+v", updated)
	}
	if updated.CreatedAt != created.CreatedAt {
		t.Fatalf("createdAt 不该被改: %v → %v", created.CreatedAt, updated.CreatedAt)
	}
	if !updated.UpdatedAt.After(created.UpdatedAt) && !updated.UpdatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("updatedAt 不该倒退: %v → %v", created.UpdatedAt, updated.UpdatedAt)
	}

	// ④ 停用行必须在列表里可见（否则没人能把它重新启用），且列表按 model 有序
	code, body = mgmt(t, ts, http.MethodGet, "/v1/providers", "")
	if code != http.StatusOK {
		t.Fatalf("列表应 200: %d %s", code, body)
	}
	var listed struct {
		Providers []domain.ProviderConfig `json:"providers"`
	}
	if err := json.Unmarshal([]byte(body), &listed); err != nil {
		t.Fatalf("列表解析: %v (%s)", err, body)
	}
	seen := false
	for i, p := range listed.Providers {
		if i > 0 && listed.Providers[i-1].Model >= p.Model {
			t.Fatalf("列表未按 model 升序: %v", listed.Providers)
		}
		if p.Model == "new-model" {
			seen = true
			if p.Enabled {
				t.Fatal("停用行在列表里应显示 enabled=false（看得见才能重新启用）")
			}
		}
	}
	if !seen {
		t.Fatalf("停用行不在列表里: %s", body)
	}

	// ⑤ 删 → ⑥ 再删 404
	if code, body := mgmt(t, ts, http.MethodDelete, "/v1/providers/new-model", ""); code != http.StatusNoContent {
		t.Fatalf("删除应 204: %d %s", code, body)
	}
	if code, body := mgmt(t, ts, http.MethodDelete, "/v1/providers/new-model", ""); code != http.StatusNotFound {
		t.Fatalf("重复删除应 404: %d %s", code, body)
	}
	if code, _ := mgmt(t, ts, http.MethodGet, "/v1/providers/new-model", ""); code != http.StatusNotFound {
		t.Fatalf("删除后读取应 404: %d", code)
	}
}

// 假存储测不出来的两条库侧判据：
//   - 新建行省略 upstreamBaseUrl → 撞 NOT NULL，翻译成 400（不是 500，也不是静默建出空地址的行）；
//   - 显式给空串 → 真的清掉密钥（COALESCE 只兜 NULL，不兜空串——清除必须有出口）。
func TestProviderUpsertLibraryLevelJudgements(t *testing.T) {
	up := newFakeUpstream(t, true)
	ts, _ := setup(t, up.ts.URL)

	// 新建行省略 upstreamBaseUrl：列是 NOT NULL，一条语句原子判定（不另发存在性查询，
	// 所以不存在「查完被删」的竞态）
	code, body := mgmt(t, ts, http.MethodPut, "/v1/providers/no-url", `{"priceInPerMtok":1}`)
	if code != http.StatusBadRequest {
		t.Fatalf("新建行缺 upstreamBaseUrl 应 400（不是 500）: %d %s", code, body)
	}
	if code, _ := mgmt(t, ts, http.MethodGet, "/v1/providers/no-url", ""); code != http.StatusNotFound {
		t.Fatalf("失败的写入不得留下半行: %d", code)
	}

	// 改已有行则可以省略（走 COALESCE 保原值）
	if code, body := mgmt(t, ts, http.MethodPut, "/v1/providers/test-model", `{"priceInPerMtok":7}`); code != http.StatusOK {
		t.Fatalf("改已有行省略 URL 应 200: %d %s", code, body)
	}

	// 显式空串 = 清除密钥
	if code, body := mgmt(t, ts, http.MethodPut, "/v1/providers/test-model", `{"apiKey":"sk-xyz"}`); code != http.StatusOK {
		t.Fatalf("设密钥应 200: %d %s", code, body)
	} else if !decodeProvider(t, body).APIKeySet {
		t.Fatal("设过密钥后 apiKeySet 应为 true")
	}
	code, body = mgmt(t, ts, http.MethodPut, "/v1/providers/test-model", `{"apiKey":""}`)
	if code != http.StatusOK {
		t.Fatalf("清密钥应 200: %d %s", code, body)
	}
	if decodeProvider(t, body).APIKeySet {
		t.Fatal("显式空串应清掉密钥（清除必须有出口）")
	}
}
