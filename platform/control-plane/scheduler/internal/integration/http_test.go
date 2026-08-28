package integration_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/server"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestHTTPNoLeaderFastFailAndFullFlow spec §7 场景 6 + 全流程：
// 无 leader 503 快速失败 → 选举就位 → 注册/放置/查询/终态/对账。
func TestHTTPNoLeaderFastFailAndFullFlow(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	elec := &election.State{}
	ts := httptest.NewServer(server.New(st, elec, &catalog.Pg{Pool: st.Pool()}, discardLogger()).Routes())
	defer ts.Close()

	post := func(path, realm, body string) (*http.Response, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatalf("构造请求失败: %v", err)
		}
		if realm != "" {
			req.Header.Set("X-Lumo-Realm", realm)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(b)
	}

	get := func(path, realm string) (*http.Response, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, ts.URL+path, nil)
		if err != nil {
			t.Fatalf("构造请求失败: %v", err)
		}
		if realm != "" {
			req.Header.Set("X-Lumo-Realm", realm)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(b)
	}

	// 无 leader：放置与对账都 503 快速失败
	resp, body := post("/v1/placements", "r1", `{"task_id":"t1","cluster_id":"c1"}`)
	if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, "no-leader") {
		t.Fatalf("无 leader 应 503 no-leader: %d %s", resp.StatusCode, body)
	}
	resp, body = post("/v1/reconcile", "r1", `{"entries":[{"entry_id":"e1","task_id":"t9","cluster_id":"c1","state":"RUNNING"}]}`)
	if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, "no-leader") {
		t.Fatalf("无 leader 对账应 503 no-leader: %d %s", resp.StatusCode, body)
	}

	// 选举就位：Run 循环首轮立即 acquire，轮询等待
	eCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go election.Run(eCtx, elec, st, "node-test", 5*time.Second, func(bool) {})
	waitFor(t, 2*time.Second, elec.IsLeader)

	// 全流程：注册节点 → 放置 → 查询 → 回报终态
	resp, body = post("/v1/nodes", "r1", `{"node_id":"N1","cluster_id":"c1","capacity":2,"capabilities":["llm"]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("注册节点失败: %d %s", resp.StatusCode, body)
	}
	resp, body = post("/v1/placements", "r1", `{"task_id":"t1","cluster_id":"c1","requires":[{"key":"llm"}],"priority":5}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("放置失败: %d %s", resp.StatusCode, body)
	}
	var p domain.Placement
	if err := json.Unmarshal([]byte(body), &p); err != nil {
		t.Fatalf("解析放置响应失败: %v", err)
	}
	if p.Attempt != 1 || p.NodeID != "N1" || p.State != domain.StatePlaced {
		t.Fatalf("放置响应不符: %+v", p)
	}

	resp, body = get("/v1/placements/t1", "r1")
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, "PLACED") {
		t.Fatalf("查询放置失败: %d %s", resp.StatusCode, body)
	}

	// 回报终态（幂等：二次回报同样成功）
	for i := 0; i < 2; i++ {
		resp, body = post("/v1/tasks/t1/result", "r1", `{"state":"COMPLETED"}`)
		if resp.StatusCode != http.StatusOK || !strings.Contains(body, "COMPLETED") {
			t.Fatalf("回报终态失败: %d %s", resp.StatusCode, body)
		}
	}

	// leader 观测
	resp, body = get("/v1/leader", "")
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, "node-test") {
		t.Fatalf("leader 应为本测试节点: %d %s", resp.StatusCode, body)
	}

	// 对账：leader 就位后入库 + 幂等去重
	resp, body = post("/v1/reconcile", "r1", `{"entries":[{"entry_id":"e1","task_id":"t9","cluster_id":"c1","state":"RUNNING"}]}`)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"recorded":1`) {
		t.Fatalf("对账应记录 1 条: %d %s", resp.StatusCode, body)
	}
	resp, body = post("/v1/reconcile", "r1", `{"entries":[{"entry_id":"e1","task_id":"t9","cluster_id":"c1","state":"RUNNING"}]}`)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"recorded":0`) {
		t.Fatalf("重复对账应去重记录 0 条: %d %s", resp.StatusCode, body)
	}
}
