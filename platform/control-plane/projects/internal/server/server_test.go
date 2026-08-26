package server_test

// server 层行为测试：httptest 全端点覆盖（不依赖 PG 的部分用真 store + 真 PG——
// 本包测试全部需要活库，schema 隔离；纯函数在 domain_test）。
//
// 断言的语义见设计说明 §4 端点表与 §6 判据：非成员 404（存在性不可泄露）、
// 无权 403、最后 owner 409、删除两层闸（archived 态 + X-Lumo-Confirm）、
// 归档后账照记（Usage 不受 status 影响）。

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

	"github.com/lumo-harness/platform/projects/internal/server"
	"github.com/lumo-harness/platform/projects/internal/store"
)

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过 projects server 测试（活库）")
	}
	return dsn
}

func schemaDSN(t *testing.T, base, schema string) string {
	t.Helper()
	admin, err := pgxpool.New(context.Background(), base)
	if err != nil {
		t.Fatalf("admin 连接失败: %v", err)
	}
	defer admin.Close()
	if _, err := admin.Exec(context.Background(), "CREATE SCHEMA IF NOT EXISTS "+schema); err != nil {
		t.Fatalf("建 schema: %v", err)
	}
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("DSN 解析: %v", err)
	}
	q := u.Query()
	q.Set("options", "-c search_path="+schema)
	u.RawQuery = q.Encode()
	return u.String()
}

// setupTS 惯例缩写冲突避开：返回（测试服、池清理）。
func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	schema := fmt.Sprintf("proj_srv_%d", time.Now().UnixNano())
	pool, err := pgxpool.New(context.Background(), schemaDSN(t, testDSN(t), schema))
	if err != nil {
		t.Fatalf("连接: %v", err)
	}
	t.Cleanup(pool.Close)
	st := store.New(pool, 1_000_000)
	if err := st.Init(context.Background()); err != nil {
		t.Fatalf("init: %v", err)
	}
	// usage_ledger/budget_trees 表不在本服务 DDL（真相源在 metering）——测试自建
	// 最小同构（列子集够用），漂移由 integration 包的完整断言逮。
	for _, ddl := range []string{
		`CREATE TABLE IF NOT EXISTS budget_trees (
		   kind TEXT NOT NULL, id TEXT NOT NULL, budget BIGINT NOT NULL,
		   budget_total BIGINT, soft_limit BIGINT, overdraft BIGINT,
		   PRIMARY KEY (kind, id))`,
		`CREATE TABLE IF NOT EXISTS usage_ledger (
		   id BIGSERIAL PRIMARY KEY, project_id TEXT, cost_type TEXT,
		   qty NUMERIC(20,6), cost_usd NUMERIC(20,6))`,
	} {
		if _, err := pool.Exec(context.Background(), ddl); err != nil {
			t.Fatalf("建依赖表: %v", err)
		}
	}
	mux := http.NewServeMux()
	server.New(st, nil).Register(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func do(t *testing.T, method, target, body string, headers map[string]string) (*http.Response, string) {
	t.Helper()
	var rd *strings.Reader
	if body != "" {
		rd = strings.NewReader(body)
	} else {
		rd = strings.NewReader("")
	}
	req, err := http.NewRequest(method, target, rd)
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

func auth(user, realm string) map[string]string {
	return map[string]string{"X-Lumo-User": user, "X-Lumo-Realm": realm}
}

func merge(m map[string]string, extra map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func createProject(t *testing.T, ts *httptest.Server, user, realm, name string) string {
	t.Helper()
	resp, body := do(t, "POST", ts.URL+"/v1/projects",
		fmt.Sprintf(`{"name":%q}`, name), auth(user, realm))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("创建项目失败: %d %s", resp.StatusCode, body)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("解析: %v", err)
	}
	return out.ID
}

// 判据 1：创建三件套——owner 成员行、预算种子行、realm 内重名拒绝。
func TestCreateTriple(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "u1", "r1", "apollo")
	if !strings.HasPrefix(id, "proj_") {
		t.Fatalf("ID 形态: %s", id)
	}
	// 成员行 + 预算行经 API 可见性验证（成员列表 + usage 的 budget）
	resp, body := do(t, "GET", ts.URL+"/v1/projects/"+id+"/members", "", auth("u1", "r1"))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"owner"`) {
		t.Fatalf("owner 成员行缺失: %d %s", resp.StatusCode, body)
	}
	resp, body = do(t, "GET", ts.URL+"/v1/projects/"+id+"/usage", "", auth("u1", "r1"))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"budget":1000000`) {
		t.Fatalf("预算种子缺失: %d %s", resp.StatusCode, body)
	}
	// 重名拒绝
	resp, _ = do(t, "POST", ts.URL+"/v1/projects", `{"name":"apollo"}`, auth("u1", "r1"))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("realm 内重名应 409, got %d", resp.StatusCode)
	}
	// 异 realm 同名放行（隔离边界是 realm）
	resp, _ = do(t, "POST", ts.URL+"/v1/projects", `{"name":"apollo"}`, auth("u9", "r2"))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("异 realm 同名应放行, got %d", resp.StatusCode)
	}
	// 缺身份头 401
	resp, _ = do(t, "POST", ts.URL+"/v1/projects", `{"name":"x"}`, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("缺身份头应 401, got %d", resp.StatusCode)
	}
}

// 判据 2：角色执法（API 层）——editor 加成员被拒、viewer 改配置类读 usage 可但
// 管理被拒、owner 全通；非成员 404（存在性不可泄露）。
func TestRoleEnforcement(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "owner1", "r1", "p")
	add := func(user, role string) {
		resp, body := do(t, "POST", ts.URL+"/v1/projects/"+id+"/members",
			fmt.Sprintf(`{"userId":%q,"role":%q}`, user, role), auth("owner1", "r1"))
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("加成员 %s 失败: %d %s", user, resp.StatusCode, body)
		}
	}
	add("ed1", "editor")
	add("vw1", "viewer")

	// editor 加成员被拒（members.manage=false）
	resp, _ := do(t, "POST", ts.URL+"/v1/projects/"+id+"/members",
		`{"userId":"x1","role":"viewer"}`, auth("ed1", "r1"))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("editor 加成员应 403, got %d", resp.StatusCode)
	}
	// viewer 读取 usage 可（project.read）
	resp, _ = do(t, "GET", ts.URL+"/v1/projects/"+id+"/usage", "", auth("vw1", "r1"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("viewer 读 usage 应 200, got %d", resp.StatusCode)
	}
	// viewer archive 被拒
	resp, _ = do(t, "POST", ts.URL+"/v1/projects/"+id+"/archive", "", auth("vw1", "r1"))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer archive 应 403, got %d", resp.StatusCode)
	}
	// 非成员 404（不是 403——存在性不可泄露）
	resp, _ = do(t, "GET", ts.URL+"/v1/projects/"+id, "", auth("stranger", "r1"))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("非成员应 404, got %d", resp.StatusCode)
	}
	// 异 realm 成员也 404（realm 是首要边界）
	resp, _ = do(t, "GET", ts.URL+"/v1/projects/"+id, "", auth("owner1", "other-realm"))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("异 realm 应 404, got %d", resp.StatusCode)
	}
	// 成员列表：本人成员视角
	resp, body := do(t, "GET", ts.URL+"/v1/projects", "", auth("ed1", "r1"))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, "p") {
		t.Fatalf("成员列表应含项目: %d %s", resp.StatusCode, body)
	}
	resp, body = do(t, "GET", ts.URL+"/v1/projects", "", auth("stranger", "r1"))
	if resp.StatusCode != http.StatusOK || strings.Contains(body, `"id":"proj_`) {
		t.Fatalf("非成员列表应为空: %s", body)
	}
}

// 判据 3+4：状态机（跳归档直接删被拒）+ 最后 owner 保护。
func TestLifecycleAndLastOwner(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "owner1", "r1", "p")

	// active 直接删被拒（两层闸第一层）
	resp, body := do(t, "DELETE", ts.URL+"/v1/projects/"+id, "", merge(auth("owner1", "r1"), map[string]string{"X-Lumo-Confirm": id}))
	if resp.StatusCode != http.StatusConflict || !strings.Contains(body, "archived") {
		t.Fatalf("active 直接删应 409, got %d %s", resp.StatusCode, body)
	}
	// 归档（owner）
	resp, body = do(t, "POST", ts.URL+"/v1/projects/"+id+"/archive", "", auth("owner1", "r1"))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"archived"`) {
		t.Fatalf("归档失败: %d %s", resp.StatusCode, body)
	}
	// 归档后删除：无确认头被拒（两层闸第二层）
	resp, _ = do(t, "DELETE", ts.URL+"/v1/projects/"+id, "", auth("owner1", "r1"))
	if resp.StatusCode != http.StatusPreconditionRequired {
		t.Fatalf("无确认头删除应 428, got %d", resp.StatusCode)
	}
	// 确认头不等于项目 ID 被拒
	resp, _ = do(t, "DELETE", ts.URL+"/v1/projects/"+id, "", merge(auth("owner1", "r1"), map[string]string{"X-Lumo-Confirm": "wrong"}))
	if resp.StatusCode != http.StatusPreconditionRequired {
		t.Fatalf("错误确认头应 428, got %d", resp.StatusCode)
	}
	// 正确删除
	resp, _ = do(t, "DELETE", ts.URL+"/v1/projects/"+id, "", merge(auth("owner1", "r1"), map[string]string{"X-Lumo-Confirm": id}))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("删除应 200, got %d", resp.StatusCode)
	}
	// 删除后不可见
	resp, _ = do(t, "GET", ts.URL+"/v1/projects/"+id, "", auth("owner1", "r1"))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("删除后应 404, got %d", resp.StatusCode)
	}

	// 最后 owner 保护：新项目 + 移除唯一 owner 被拒
	id2 := createProject(t, ts, "owner2", "r1", "q")
	resp, _ = do(t, "DELETE", ts.URL+"/v1/projects/"+id2+"/members/owner2", "", auth("owner2", "r1"))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("移除最后 owner 应 409, got %d", resp.StatusCode)
	}
	resp, _ = do(t, "PATCH", ts.URL+"/v1/projects/"+id2+"/members/owner2",
		`{"role":"viewer"}`, auth("owner2", "r1"))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("降级最后 owner 应 409, got %d", resp.StatusCode)
	}
	// 加第二 owner 后，第一个可降级
	if resp, _ := do(t, "POST", ts.URL+"/v1/projects/"+id2+"/members",
		`{"userId":"owner3","role":"owner"}`, auth("owner2", "r1")); resp.StatusCode != http.StatusCreated {
		t.Fatalf("加第二 owner 失败")
	}
	resp, _ = do(t, "PATCH", ts.URL+"/v1/projects/"+id2+"/members/owner2",
		`{"role":"viewer"}`, auth("owner3", "r1"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("双 owner 后降级应 200, got %d", resp.StatusCode)
	}
	// 非法角色闭集拒绝
	resp, _ = do(t, "POST", ts.URL+"/v1/projects/"+id2+"/members",
		`{"userId":"x","role":"admin"}`, auth("owner3", "r1"))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("闭集外角色应 400, got %d", resp.StatusCode)
	}
	// 已是成员重复加 409
	do(t, "POST", ts.URL+"/v1/projects/"+id2+"/members",
		`{"userId":"owner3","role":"viewer"}`, auth("owner3", "r1"))
	resp, _ = do(t, "POST", ts.URL+"/v1/projects/"+id2+"/members",
		`{"userId":"owner3","role":"viewer"}`, auth("owner3", "r1"))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("重复加成员应 409, got %d", resp.StatusCode)
	}
}
