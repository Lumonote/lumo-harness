package server_test

// server 层行为测试（活库，schema 隔离）：判据 1-5 的 HTTP 面。判据 6（回滚）与
// 判据 3 的快照字节断言在 integration 包（直接查表更直观）。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/flows/internal/server"
	"github.com/lumo-harness/platform/flows/internal/store"
)

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过 flows server 测试（活库）")
	}
	return dsn
}

// newTestServer 返回（测试服，种子函数）。种子函数直插 projects/project_members
// 最小同构（表属 projects 服务 DDL 真相源——完整形状漂移由 integration 断言）。
func newTestServer(t *testing.T) (*httptest.Server, func(pid string, members map[string]string)) {
	t.Helper()
	schema := fmt.Sprintf("flows_srv_%d", time.Now().UnixNano())
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
		`CREATE TABLE IF NOT EXISTS projects (
		   id TEXT PRIMARY KEY, realm TEXT NOT NULL, name TEXT NOT NULL,
		   status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL,
		   created_at TIMESTAMPTZ NOT NULL DEFAULT now(), archived_at TIMESTAMPTZ)`,
		`CREATE TABLE IF NOT EXISTS project_members (
		   project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
		   added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		   PRIMARY KEY (project_id, user_id))`,
	} {
		if _, err := pool.Exec(context.Background(), ddl); err != nil {
			t.Fatalf("建依赖表: %v", err)
		}
	}
	st := store.New(pool)
	if err := st.Init(context.Background()); err != nil {
		t.Fatalf("init: %v", err)
	}
	mux := http.NewServeMux()
	server.New(st, nil).Register(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	seed := func(pid string, members map[string]string) {
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO projects (id, realm, name, created_by) VALUES ($1,'r1',$2,'u1')`,
			pid, "proj-"+pid); err != nil {
			t.Fatalf("种子项目: %v", err)
		}
		for u, role := range members {
			if _, err := pool.Exec(context.Background(),
				`INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3)`,
				pid, u, role); err != nil {
				t.Fatalf("种子成员: %v", err)
			}
		}
	}
	return ts, seed
}

func do(t *testing.T, method, target, body string, headers map[string]string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(method, target, strings.NewReader(body))
	if err != nil {
		t.Fatalf("构造请求: %v", err)
	}
	for k, v := range headers {
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

func auth(user, realm string, extra map[string]string) map[string]string {
	h := map[string]string{"X-Lumo-User": user, "X-Lumo-Realm": realm}
	for k, v := range extra {
		h[k] = v
	}
	return h
}

const goodDAG = `{"nodes":[{"id":"a","operator":"kb.query"},{"id":"b","operator":"llm.answer"}],"edges":[{"from":"a","to":"b"}]}`
const cyclicDAG = `{"nodes":[{"id":"a","operator":"x"},{"id":"b","operator":"y"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"a"}]}`

func createFlow(t *testing.T, ts *httptest.Server, user, realm, pid, name, def string) string {
	t.Helper()
	resp, body := do(t, "POST", ts.URL+"/v1/projects/"+pid+"/flows",
		fmt.Sprintf(`{"name":%q,"definition":%s}`, name, def), auth(user, realm, nil))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("建流程失败: %d %s", resp.StatusCode, body)
	}
	var out struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(body), &out)
	return out.ID
}

// 判据 1-5 全链（一个 schema 一个故事：建项目成员 → 草稿护栏 → 提审 → 审核 →
// 定向 → 面板过滤 → 弃用）。
func TestFullLifecycle(t *testing.T) {
	ts, seed := newTestServer(t)
	seed("p1", map[string]string{"u1": "owner", "u2": "editor", "u3": "viewer"})
	// m1 是 manager 但不是项目成员（审核人不必在项目内）

	// 判据 1a：含环 definition 400
	resp, body := do(t, "POST", ts.URL+"/v1/projects/p1/flows",
		`{"name":"cyc","definition":`+cyclicDAG+`}`, auth("u2", "r1", nil))
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(body, "环") {
		t.Fatalf("含环应 400: %d %s", resp.StatusCode, body)
	}
	// 判据 1b：非成员 404
	resp, _ = do(t, "POST", ts.URL+"/v1/projects/p1/flows",
		`{"name":"x","definition":`+goodDAG+`}`, auth("u9", "r1", nil))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("非成员建流程应 404: %d", resp.StatusCode)
	}
	// 判据 1c：viewer（成员但只读）403
	resp, _ = do(t, "POST", ts.URL+"/v1/projects/p1/flows",
		`{"name":"x","definition":`+goodDAG+`}`, auth("u3", "r1", nil))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer 建流程应 403: %d", resp.StatusCode)
	}
	// 建草稿（editor=作者）
	id := createFlow(t, ts, "u2", "r1", "p1", "kb-flow", goodDAG)
	// 判据 1d：项目内重名 409
	resp, _ = do(t, "POST", ts.URL+"/v1/projects/p1/flows",
		`{"name":"kb-flow","definition":`+goodDAG+`}`, auth("u2", "r1", nil))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("重名应 409: %d", resp.StatusCode)
	}
	// 草稿仅作者可见：viewer 查详情 404
	resp, _ = do(t, "GET", ts.URL+"/v1/flows/"+id, "", auth("u3", "r1", nil))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("草稿对非作者应 404: %d", resp.StatusCode)
	}
	// 作者改草稿 OK / 非作者 403
	resp, _ = do(t, "PUT", ts.URL+"/v1/flows/"+id+"/definition",
		`{"definition":`+goodDAG+`}`, auth("u2", "r1", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("作者改草稿应 200")
	}
	resp, _ = do(t, "PUT", ts.URL+"/v1/flows/"+id+"/definition",
		`{"definition":`+goodDAG+`}`, auth("u1", "r1", nil))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("非作者改草稿应 403: %d", resp.StatusCode)
	}

	// 判据 2/3：提审 → 审核
	resp, _ = do(t, "POST", ts.URL+"/v1/flows/"+id+"/submit", "", auth("u1", "r1", nil))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("非作者提交应 403: %d", resp.StatusCode)
	}
	resp, body = do(t, "POST", ts.URL+"/v1/flows/"+id+"/submit", "", auth("u2", "r1", nil))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"submitted"`) {
		t.Fatalf("提交失败: %d %s", resp.StatusCode, body)
	}
	resp, _ = do(t, "POST", ts.URL+"/v1/flows/"+id+"/submit", "", auth("u2", "r1", nil))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("重复提交应 409: %d", resp.StatusCode)
	}
	// 判据 3a：非 manager/admin 403
	resp, _ = do(t, "POST", ts.URL+"/v1/flows/"+id+"/review",
		`{"approve":true}`, auth("u1", "r1", nil))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("非 manager 审核应 403: %d", resp.StatusCode)
	}
	// 判据 3b：作者自审 403（职责分离）——作者带 manager 头走到自审分支
	resp, _ = do(t, "POST", ts.URL+"/v1/flows/"+id+"/review",
		`{"approve":true}`, auth("u2", "r1", map[string]string{"X-Lumo-Roles": "manager"}))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("作者自审应 403: %d", resp.StatusCode)
	}
	// 判据 3c：manager 非作者 → approve → published v1
	resp, body = do(t, "POST", ts.URL+"/v1/flows/"+id+"/review",
		`{"approve":true,"comment":"lgtm"}`, auth("m1", "r1", map[string]string{"X-Lumo-Roles": "manager"}))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"published"`) {
		t.Fatalf("审核通过失败: %d %s", resp.StatusCode, body)
	}
	if !strings.Contains(body, `"version":1`) {
		t.Fatalf("approve 应产生 v1: %s", body)
	}
	// 已发布不能再审（非法转移 409）
	resp, _ = do(t, "POST", ts.URL+"/v1/flows/"+id+"/review",
		`{"approve":true}`, auth("m1", "r1", map[string]string{"X-Lumo-Roles": "manager"}))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("已发布再审应 409: %d", resp.StatusCode)
	}

	// 判据 4：定向分发（owner 定向；editor 403）
	aud := `{"audience":{"roles":["analyst"],"depts":["d2"],"users":["u9"]},"visibility":"targeted"}`
	resp, _ = do(t, "POST", ts.URL+"/v1/flows/"+id+"/target", aud, auth("u2", "r1", nil))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("editor 定向应 403: %d", resp.StatusCode)
	}
	resp, body = do(t, "POST", ts.URL+"/v1/flows/"+id+"/target", aud, auth("u1", "r1", nil))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"targeted"`) {
		t.Fatalf("定向失败: %d %s", resp.StatusCode, body)
	}
	// targeted 重复 target 幂等重定（改 audience）
	resp, body = do(t, "POST", ts.URL+"/v1/flows/"+id+"/target",
		`{"audience":{"users":["vx"]},"visibility":"targeted"}`, auth("u1", "r1", nil))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"targeted"`) {
		t.Fatalf("重定 audience 应幂等: %d %s", resp.StatusCode, body)
	}
	// targeted 但空 audience 400（配置错误宁可不可见）
	resp, _ = do(t, "POST", ts.URL+"/v1/flows/"+id+"/target",
		`{"visibility":"targeted"}`, auth("u1", "r1", nil))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("空 audience 应 400: %d", resp.StatusCode)
	}
	// 回到原 audience（role/user 命中路径）
	resp, _ = do(t, "POST", ts.URL+"/v1/flows/"+id+"/target", aud, auth("u1", "r1", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("恢复 audience 失败: %d", resp.StatusCode)
	}

	// 判据 5：面板过滤
	resp, body = do(t, "GET", ts.URL+"/v1/flows", "", auth("va", "r1", map[string]string{"X-Lumo-Roles": "analyst"}))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, id) {
		t.Fatalf("命中 audience role 应可见: %d %s", resp.StatusCode, body)
	}
	resp, body = do(t, "GET", ts.URL+"/v1/flows", "", auth("u9", "r1", nil))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, id) {
		t.Fatalf("命中 audience user（非项目成员）应可见: %d %s", resp.StatusCode, body)
	}
	resp, body = do(t, "GET", ts.URL+"/v1/flows", "", auth("vx", "r1", map[string]string{"X-Lumo-Roles": "viewer", "X-Lumo-Dept": "d9"}))
	if resp.StatusCode != http.StatusOK || strings.Contains(body, id) {
		t.Fatalf("未命中不可见: %d %s", resp.StatusCode, body)
	}
	resp, body = do(t, "GET", ts.URL+"/v1/flows", "", auth("u3", "r1", nil))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, id) {
		t.Fatalf("项目成员应可见（private 路径）: %d %s", resp.StatusCode, body)
	}

	// deprecated 从面板剔除、详情仍可读（引用方需要知道它死了）
	resp, _ = do(t, "POST", ts.URL+"/v1/flows/"+id+"/deprecate", "", auth("u1", "r1", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("弃用失败: %d", resp.StatusCode)
	}
	resp, body = do(t, "GET", ts.URL+"/v1/flows", "", auth("u3", "r1", nil))
	if strings.Contains(body, id) {
		t.Fatalf("deprecated 应从面板剔除: %s", body)
	}
	resp, _ = do(t, "GET", ts.URL+"/v1/flows/"+id, "", auth("u3", "r1", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("deprecated 详情应可读: %d", resp.StatusCode)
	}
}
