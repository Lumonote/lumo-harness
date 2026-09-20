package integration_test

// 两件只有真库能一起证的事：
//
//  1. **固化任务接 TriggerBus 而不新建调度机制**（§24.4 第 5 条）——一条 cron 自动化
//     经「cron 生产者 → flow_trigger_outbox → 投递 worker → 进程内 Bus → 绑定 → 引擎」
//     真的把 `decisions.consolidate` 跑起来，并在 flow_runs 里留下一条成功记录。
//  2. **唤醒可归因**（§14 判据 10、§24.9 第 1 条）——那次执行出站时带的 X-Lumo-Trace
//     就是 `domain.WakeTrace(触发 id)`，且能从它反解回触发；「这个 Run 被谁唤醒」由
//     `flow_runs.trigger_id` → `flow_trigger_outbox` 的既有列回答。
//
// 上游用 httptest 假扮 projects 的固化读面：本用例要证的是**流程侧的接线与归因**，
// 不是那侧的报告内容（那些在 projects 的真库用例里，包括「跑完数据零变化」）。
// 身份来源也与 main.go 不同——生产走 AutomationIdentity（要 governance 表），
// 这里用固定身份，因为身份解析不是本用例的对象。
//
// 附带的一条覆盖：这是**唯一**在真库上执行 store.ClaimTriggers 的用例（其余投递测试
// 都用 fake outbox），所以它同时是那段 SQL 的回归网——2026-09-20 它就是这么抓出一条
// 「事件进得来、流程永远不被触发」的静默故障的（见该函数的注释）。

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/engine"
	"github.com/lumo-harness/platform/flows/internal/schedule"
	"github.com/lumo-harness/platform/flows/internal/store"
	"github.com/lumo-harness/platform/flows/internal/trigger"
	"github.com/lumo-harness/platform/observability"
)

// 固化流程的定义：单节点 + 节点配置指明要固化哪个项目。
func consolidationDefinition(t *testing.T, projectID string) json.RawMessage {
	t.Helper()
	def := domain.Definition{Nodes: []domain.FlowNode{{
		ID: "consolidate", Operator: "decisions.consolidate",
		Config: map[string]any{"projectId": projectID},
	}}}
	encoded, err := json.Marshal(def)
	if err != nil {
		t.Fatalf("序列化定义: %v", err)
	}
	return encoded
}

func TestConsolidationViaTriggerBusAndWakeAttribution(t *testing.T) {
	st, pool := newScheduleStore(t)
	ctx := context.Background()

	// 假 projects：记录出站请求的方法/路径/trace，回答一份最小报告。
	var mu sync.Mutex
	var method, path, trace string
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		method, path, trace, calls = r.Method, r.URL.Path, r.Header.Get("X-Lumo-Trace"), calls+1
		mu.Unlock()
		_, _ = w.Write([]byte(`{"policy":"flag-only","examined":0,"frequency_note":"默认关闭"}`))
	}))
	t.Cleanup(upstream.Close)

	// --- 一条 cron 自动化 + 一个已发布流程：这就是「接 TriggerBus」的全部配置 ---
	flow, err := st.CreateFlow(ctx, "flow_consolidate", "p1", "r1", "固化", "author1",
		consolidationDefinition(t, "p1"))
	if err != nil {
		t.Fatalf("建流程: %v", err)
	}
	if _, err := st.Transition(ctx, flow.ID, domain.EventSubmit); err != nil {
		t.Fatalf("提审: %v", err)
	}
	if _, err := st.Review(ctx, flow.ID, "reviewer", true, ""); err != nil {
		t.Fatalf("发布: %v", err)
	}
	seedAutomation(t, pool, "auto-consolidate", "cron", "0 * * * *", flow.ID, true)

	now := time.Date(2026, 9, 20, 9, 0, 30, 0, time.UTC)
	producer := schedule.NewProducer(st, time.UTC)
	producer.SetClock(func() time.Time { return now })
	// 两个后台组件都会上报错误，而它们的错误不设回调就是**静默**的（promise 的经典
	// 形状：worker 不 ack、不 panic，只是什么都不做）。用例必须把它们收集起来，
	// 否则「什么都没发生」会表现成「等终态超时」。
	var errMu sync.Mutex
	failures := []error{}
	collect := func(err error) {
		if err == nil {
			return
		}
		errMu.Lock()
		defer errMu.Unlock()
		failures = append(failures, err)
	}
	producer.SetErrorHandler(collect)
	if first := producer.Cycle(ctx); first.Reconciled != 1 || first.Fired != 0 {
		t.Fatalf("第一轮 = %+v，期望只建游标", first)
	}
	now = now.Add(time.Hour)
	if second := producer.Cycle(ctx); second.Fired != 1 {
		t.Fatalf("第二轮 = %+v，期望触发一次 (errs=%v)", second, failures)
	}

	var triggerID uint64
	if err := pool.QueryRow(ctx, `
		SELECT id FROM flow_trigger_outbox WHERE source='cron' AND cron_automation_id='auto-consolidate'`).
		Scan(&triggerID); err != nil {
		t.Fatalf("读触发: %v", err)
	}

	// --- 与 main.go 同形的投递链（只差身份来源）---
	flowEngine := engine.New(engine.RuntimeConfig{ProjectsURL: upstream.URL, ControlToken: "token"})
	bus := trigger.New()
	bus.Subscribe("*", func(runCtx context.Context, event trigger.Event) error {
		bindings, err := st.PrepareTriggerBindings(runCtx, event.ID, event.Realm)
		if err != nil {
			return err
		}
		for _, binding := range bindings {
			definition, _, err := st.GetVersion(runCtx, binding.FlowID, binding.FlowVersion)
			if err != nil {
				return err
			}
			var def domain.Definition
			if err := json.Unmarshal(definition, &def); err != nil {
				return err
			}
			started, err := st.StartTriggerRun(runCtx, event.ID, binding.AutomationID, binding.FlowID, binding.FlowVersion)
			if err != nil {
				return err
			}
			if !started {
				continue
			}
			identity := observability.Identity{Realm: event.Realm, UserID: "author1", Roles: []string{"editor"}, ProjectID: "p1"}
			executionCtx, cancel := context.WithTimeout(runCtx, store.RunTimeout)
			// main.go 的同一行：被事件叫醒的执行带上唤醒源的键。
			result, runErr := flowEngine.Run(
				engine.WithWakeTrace(engine.WithIdentity(executionCtx, identity), domain.WakeTrace(event.ID)),
				&def, event.Payload)
			cancel()
			if runErr != nil {
				return st.FinishTriggerRun(runCtx, event.ID, binding.AutomationID, "failed", nil, runErr)
			}
			output, err := json.Marshal(result)
			if err != nil {
				return err
			}
			if err := st.FinishTriggerRun(runCtx, event.ID, binding.AutomationID, "succeeded", output, nil); err != nil {
				return err
			}
		}
		return nil
	})
	worker := trigger.NewWorker(st, bus, "wake-test")
	worker.SetTiming(10*time.Millisecond, store.RunExpiry, 5)
	worker.SetErrorHandler(collect)
	workerCtx, stopWorker := context.WithCancel(ctx)
	defer stopWorker()
	go worker.Run(workerCtx)

	// 等那条 run 走到终态（真库 + 异步 worker，不能用固定 sleep）。
	var status string
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := pool.QueryRow(ctx,
			`SELECT status FROM flow_runs WHERE trigger_id = $1`, triggerID).Scan(&status); err == nil && status != "running" {
			break
		}
		if time.Now().After(deadline) {
			errMu.Lock()
			defer errMu.Unlock()
			t.Fatalf("等 run 终态超时，当前 status=%q (errs=%v)", status, failures)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if status != "succeeded" {
		t.Fatalf("run 终态 = %q，期望 succeeded", status)
	}

	// --- 断言一：唤醒源可查，且用的是既有列（没有为归因新增任何列）---
	var runFlowID, source, eventName, cronAutomationID string
	if err := pool.QueryRow(ctx, `
		SELECT r.flow_id, o.source, o.event_name, o.cron_automation_id
		FROM flow_runs r JOIN flow_trigger_outbox o ON o.id = r.trigger_id
		WHERE r.trigger_id = $1`, triggerID).Scan(&runFlowID, &source, &eventName, &cronAutomationID); err != nil {
		t.Fatalf("按 run 查唤醒源: %v", err)
	}
	if runFlowID != flow.ID || source != "cron" || eventName != "auto-consolidate" || cronAutomationID != "auto-consolidate" {
		t.Fatalf("唤醒源 = flow=%s source=%s event=%s automation=%s", runFlowID, source, eventName, cronAutomationID)
	}

	// --- 断言二：出站请求的 trace 就是这次唤醒的归因键，且能反解回来 ---
	mu.Lock()
	gotMethod, gotPath, gotTrace, gotCalls := method, path, trace, calls
	mu.Unlock()
	if gotCalls != 1 {
		t.Fatalf("固化算子出站次数 = %d，期望 1", gotCalls)
	}
	if gotMethod != http.MethodGet || gotPath != "/v1/projects/p1/decisions/consolidation-report" {
		t.Fatalf("固化调用 = %s %s", gotMethod, gotPath)
	}
	want := domain.WakeTrace(triggerID)
	if gotTrace != want {
		t.Fatalf("X-Lumo-Trace = %q，期望 %q（网关按此写 usage_ledger.trace_id）", gotTrace, want)
	}
	if id, ok := domain.ParseWakeTrace(gotTrace); !ok || id != triggerID {
		t.Fatalf("台账里的 trace 反解不出唤醒事件: %q → %d %v", gotTrace, id, ok)
	}

	// --- 断言三：报告落进 run 的输出（定时固化不是「算了但没人看见」）---
	var output []byte
	if err := pool.QueryRow(ctx, `SELECT output FROM flow_runs WHERE trigger_id = $1`, triggerID).Scan(&output); err != nil {
		t.Fatalf("读 run 输出: %v", err)
	}
	var result struct {
		Outputs map[string]map[string]any `json:"outputs"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("解析 run 输出: %v (%s)", err, output)
	}
	report := result.Outputs["consolidate"]
	// flag-only 是 §24.4 的铁律：报告的形状由 projects 决定，流程侧只许原样转发，
	// 不得改写策略——所以这里按字面钉住，而不是断言「某个非空字符串」。
	if report["policy"] != "flag-only" {
		t.Fatalf("报告未按 flag-only 落到 run 输出: %+v", report)
	}
	errMu.Lock()
	defer errMu.Unlock()
	if len(failures) != 0 {
		t.Fatalf("投递链不应上报错误: %v", failures)
	}
}
