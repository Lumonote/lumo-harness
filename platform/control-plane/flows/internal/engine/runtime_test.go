package engine

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/observability"
)

// 执行面测试：出站请求带什么（唤醒归因键、身份头、路径），以及缺配置时怎么失败。

func testIdentity() observability.Identity {
	return observability.Identity{Realm: "r1", UserID: "u1", Roles: []string{"editor"}, ProjectID: "p1", DeptID: "d1"}
}

// node 定义单节点流程，第二个参数进节点配置。
func node(operator string, config map[string]any) *domain.Definition {
	return &domain.Definition{Nodes: []domain.FlowNode{{ID: "n0", Operator: operator, Config: config}}}
}

// 判据 10 的写侧：唤醒键必须真的上路（网关只认这个头），且**没有唤醒源时不带头**。
//
// 两侧都测的理由不同：带了头才算可归因；不带（而不是带个空值或假值）才算 fail-closed——
// 一个空 X-Lumo-Trace 会让网关走「头存在但为空」的分支，而那条分支丢弃的是「这次调用
// 不可归因」这个事实。
func TestWakeTraceHeader(t *testing.T) {
	var gotTrace string
	var seen bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotTrace, seen = r.Header.Get("X-Lumo-Trace"), true
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(upstream.Close)

	eng := New(RuntimeConfig{LLMURL: upstream.URL, ControlToken: "token"})
	def := node("llm.chat", map[string]any{"model": "m1"})

	if _, err := eng.Run(WithIdentity(WithWakeTrace(context.Background(), domain.WakeTrace(9)), testIdentity()), def, "hi"); err != nil {
		t.Fatalf("被唤醒的执行失败: %v", err)
	}
	if !seen || gotTrace != "flow-trigger-9" {
		t.Fatalf("X-Lumo-Trace = %q（seen=%v），期望 flow-trigger-9", gotTrace, seen)
	}

	seen = false
	if _, err := eng.Run(WithIdentity(context.Background(), testIdentity()), def, "hi"); err != nil {
		t.Fatalf("手工执行失败: %v", err)
	}
	if !seen || gotTrace != "" {
		t.Fatalf("无唤醒源时不得带 X-Lumo-Trace，实际 %q（seen=%v）", gotTrace, seen)
	}

	// 空键与不调用 WithWakeTrace 必须等价：空串是「没有可归因的唤醒源」的表示，
	// 不能因为有人把 domain.WakeTrace(0) 的结果直接塞进来就变成一次「带空头的调用」。
	if _, err := eng.Run(WithIdentity(WithWakeTrace(context.Background(), domain.WakeTrace(0)), testIdentity()), def, "hi"); err != nil {
		t.Fatalf("空唤醒键的执行失败: %v", err)
	}
	if gotTrace != "" {
		t.Fatalf("空唤醒键不得写成头: %q", gotTrace)
	}
}

// 固化算子的形状：只读 GET、路径由节点配置决定、身份头照旧。
func TestConsolidateOperatorIsReadOnlyGet(t *testing.T) {
	var method, path, trace string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path, trace = r.Method, r.URL.Path, r.Header.Get("X-Lumo-Trace")
		if r.Header.Get("X-Lumo-Realm") != "r1" || r.Header.Get("X-Lumo-User") != "u1" {
			t.Errorf("缺身份头: realm=%q user=%q", r.Header.Get("X-Lumo-Realm"), r.Header.Get("X-Lumo-User"))
		}
		_, _ = w.Write([]byte(`{"policy":"flag-only","examined":0}`))
	}))
	t.Cleanup(upstream.Close)

	eng := New(RuntimeConfig{ProjectsURL: upstream.URL, ControlToken: "token"})
	ctx := WithWakeTrace(WithIdentity(context.Background(), testIdentity()), domain.WakeTrace(3))
	result, err := eng.Run(ctx, node("decisions.consolidate", map[string]any{"projectId": "p1"}), nil)
	if err != nil {
		t.Fatalf("固化算子执行失败: %v", err)
	}
	if method != http.MethodGet {
		t.Fatalf("固化任务必须是只读 GET，实际 %s", method)
	}
	if path != "/v1/projects/p1/decisions/consolidation-report" {
		t.Fatalf("路径 = %q", path)
	}
	if trace != "flow-trigger-3" {
		t.Fatalf("固化执行也带唤醒归因键，实际 %q", trace)
	}
	if result.Outputs["n0"].(map[string]any)["policy"] != "flag-only" {
		t.Fatalf("算子应把报告原样交给流程输出: %+v", result.Outputs)
	}
}

// 项目 id 只认节点配置：触发负载里塞一个 projectId 不得改目标。
//
// 这是越权面而不是洁癖：事件入口送什么由外部决定，若输入能挑项目，一次伪造的负载就能
// 让流程去读另一个项目的决策记忆（还会以流程作者的身份被鉴权）。
func TestConsolidateIgnoresProjectFromPayload(t *testing.T) {
	var path string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_, _ = w.Write([]byte(`{"policy":"flag-only"}`))
	}))
	t.Cleanup(upstream.Close)

	eng := New(RuntimeConfig{ProjectsURL: upstream.URL, ControlToken: "token"})
	payload := map[string]any{"projectId": "victim", "project_id": "victim"}
	if _, err := eng.Run(WithIdentity(context.Background(), testIdentity()),
		node("decisions.consolidate", map[string]any{"projectId": "p1"}), payload); err != nil {
		t.Fatalf("执行失败: %v", err)
	}
	if path != "/v1/projects/p1/decisions/consolidation-report" {
		t.Fatalf("目标项目必须来自节点配置，实际路径 %q", path)
	}
}

// fail-closed：缺 projectId 时**一次请求都不发**，直接失败。
func TestConsolidateRequiresProjectID(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(upstream.Close)

	eng := New(RuntimeConfig{ProjectsURL: upstream.URL, ControlToken: "token"})
	for _, config := range []map[string]any{nil, {"projectId": "   "}, {"projectId": 7}} {
		_, err := eng.Run(WithIdentity(context.Background(), testIdentity()), node("decisions.consolidate", config), nil)
		if err == nil || !strings.Contains(err.Error(), "projectId") {
			t.Fatalf("配置 %v 应报缺 projectId，实际 %v", config, err)
		}
	}
	if calls != 0 {
		t.Fatalf("缺配置时不得发请求（未知目标不构成一次尝试），实际发了 %d 次", calls)
	}
}

// 默认关闭的判据落在配置上：未配 LUMO_PROJECTS_URL 时算子 unavailable，
// 用它的流程连发布都过不去（ValidateDefinition 这一关）。
func TestConsolidateUnavailableWithoutProjectsURL(t *testing.T) {
	eng := New(RuntimeConfig{ControlToken: "token"})
	def := node("decisions.consolidate", map[string]any{"projectId": "p1"})
	err := eng.Validate(def)
	if err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("未配置上游时校验应拒绝，实际 %v", err)
	}
	var found bool
	for _, info := range eng.Catalog() {
		if info.Name == "decisions.consolidate" {
			found = true
			if info.Available || info.Reason == "" {
				t.Fatalf("算子目录应显式说明不可用原因: %+v", info)
			}
		}
	}
	if !found {
		t.Fatal("固化算子必须出现在算子目录里——否则没人知道这条触发路径存在")
	}
	// 只传项目 id 不足以开工：没有控制面令牌同样不可用（与其余算子同训）。
	half := New(RuntimeConfig{ProjectsURL: "http://projects.test"})
	if err := half.Validate(def); err == nil {
		t.Fatal("缺控制面令牌时应拒绝")
	}
}

// 报告的形状不归本包管，但「只读」这条要能一眼看出来：出站方法只有 GET 一种，
// 载荷为空——固化任务没有任何写通道可走。
func TestConsolidateSendsNoBody(t *testing.T) {
	var body []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
			t.Errorf("固化算子不该发请求体: %s", body)
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(upstream.Close)

	eng := New(RuntimeConfig{ProjectsURL: upstream.URL, ControlToken: "token"})
	if _, err := eng.Run(WithIdentity(context.Background(), testIdentity()),
		node("decisions.consolidate", map[string]any{"projectId": "p1"}), "ignored"); err != nil {
		t.Fatalf("执行失败: %v", err)
	}
}
