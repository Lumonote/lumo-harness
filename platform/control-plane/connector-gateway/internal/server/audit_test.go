package server_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/connector-gateway/internal/audit"
	"github.com/lumo-harness/platform/connector-gateway/internal/server"
)

// 审计查询面的 handler 契约测试。纯内存、无需数据库 —— SQL 语义由
// audit/query_pg_test.go 的单个 PG 用例承担。
//
// fakeAuditReader 靠**导出方法** Query 在结构上满足 server 包内未导出的
// auditReader：未导出的是接口名，不是方法名，所以外部测试包可以自行实现，
// 不必为测试往生产代码里加导出构造器。

type fakeAuditReader struct {
	calls []audit.QueryFilter
	page  audit.Page
	err   error
}

func (f *fakeAuditReader) Query(_ context.Context, filter audit.QueryFilter) (audit.Page, error) {
	f.calls = append(f.calls, filter)
	if f.err != nil {
		return audit.Page{Entries: []audit.Entry{}}, f.err
	}
	if f.page.Entries == nil {
		f.page.Entries = []audit.Entry{}
	}
	return f.page, nil
}

func auditServer(t *testing.T, reader *fakeAuditReader) http.Handler {
	t.Helper()
	return server.New(server.Options{
		Auth:       testAuth{},
		Audit:      reader,
		AdminRoles: []string{"admin"},
	}).Routes()
}

func auditGet(t *testing.T, h http.Handler, target, roles string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, target, nil)
	r.Header.Set("X-Lumo-User", "u1")
	r.Header.Set("X-Lumo-Realm", "r1")
	r.Header.Set("X-Lumo-Roles", roles)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// realm 决定能看见哪些调用，只能来自已认证身份。查询参数里的 realm 必须被忽略，
// 且这一点要被测试钉住 —— 否则日后有人「顺手支持」?realm= 就是一次越权。
func TestAuditQueryTakesRealmFromIdentityNotFromQuery(t *testing.T) {
	reader := &fakeAuditReader{}
	w := auditGet(t, auditServer(t, reader), "/audit?realm=r2", "operator")

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if len(reader.calls) != 1 || reader.calls[0].Realm != "r1" {
		t.Fatalf("realm 必须来自身份头 r1，不得被查询参数覆盖: %+v", reader.calls)
	}
}

// 缺省只看自己的调用：审计行含 target_host 与 operation，跨用户可见性是管理能力。
func TestAuditQueryDefaultsToOwnCallsOnly(t *testing.T) {
	reader := &fakeAuditReader{}
	w := auditGet(t, auditServer(t, reader), "/audit", "operator")

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if len(reader.calls) != 1 || reader.calls[0].UserID != "u1" {
		t.Fatalf("缺省应限定为调用者本人 u1: %+v", reader.calls)
	}
}

// 越权请求必须在触达数据层之前被拒 —— 断言 reader 一次都没被调用。
func TestAuditQueryAllRequiresAdminRole(t *testing.T) {
	reader := &fakeAuditReader{}
	w := auditGet(t, auditServer(t, reader), "/audit?all=true", "operator")

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	if len(reader.calls) != 0 {
		t.Fatalf("被拒的请求不得触达数据层: %+v", reader.calls)
	}
}

func TestAuditQueryAllWidensToWholeRealmForAdmin(t *testing.T) {
	reader := &fakeAuditReader{}
	w := auditGet(t, auditServer(t, reader), "/audit?all=1", "admin")

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if len(reader.calls) != 1 || reader.calls[0].UserID != "" {
		t.Fatalf("管理员 all=1 应去掉用户过滤（UserID 为空串）: %+v", reader.calls)
	}
	if reader.calls[0].Realm != "r1" {
		t.Fatalf("放宽的是用户维度，realm 仍须锁定: %+v", reader.calls[0])
	}
}

// 未知 decision 一律 400 且不查库：静默退化成「不过滤」会把一次「只看被拒绝的
// 调用」变成「全部调用」，合规查询不能这样被放宽。
func TestAuditQueryRejectsUnknownDecisionWithoutQuerying(t *testing.T) {
	reader := &fakeAuditReader{}
	w := auditGet(t, auditServer(t, reader), "/audit?decision=denyed", "operator")

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", w.Code, w.Body.String())
	}
	if len(reader.calls) != 0 {
		t.Fatalf("参数不合法时不得查库: %+v", reader.calls)
	}
}

func TestAuditQueryRejectsMalformedCursorAndLimit(t *testing.T) {
	for _, target := range []string{
		"/audit?beforeId=-1",
		"/audit?beforeId=abc",
		"/audit?beforeId=1.5",
		"/audit?limit=0",
		"/audit?limit=-3",
		"/audit?limit=abc",
	} {
		reader := &fakeAuditReader{}
		w := auditGet(t, auditServer(t, reader), target, "operator")
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", target, w.Code)
		}
		if len(reader.calls) != 0 {
			t.Fatalf("%s: 参数不合法时不得查库", target)
		}
	}
}

// 过滤条件必须原样下发。超过上限的 limit 由 Reader 收敛（见 NormalizeLimit），
// handler 只拒绝解析不了的值，所以这里断言的是「透传」而非「截断」。
func TestAuditQueryForwardsFiltersVerbatim(t *testing.T) {
	reader := &fakeAuditReader{}
	w := auditGet(t, auditServer(t, reader),
		"/audit?sessionId=s1&connectorId=c1&decision=denied&beforeId=42&limit=7", "operator")

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	want := audit.QueryFilter{
		Realm: "r1", UserID: "u1", SessionID: "s1", ConnectorID: "c1",
		Decision: audit.Denied, BeforeID: 42, Limit: 7,
	}
	if len(reader.calls) != 1 || reader.calls[0] != want {
		t.Fatalf("过滤条件透传不符: got %+v want %+v", reader.calls, want)
	}
}

// 「查不到」与「没配」必须能分开：未配置时是 503，不是空列表。
func TestAuditQueryIsUnavailableRatherThanEmptyWhenNotConfigured(t *testing.T) {
	h := server.New(server.Options{Auth: testAuth{}}).Routes()
	w := auditGet(t, h, "/audit", "operator")

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
	if strings.Contains(w.Body.String(), `"entries"`) {
		t.Fatalf("未配置不得返回看起来像「没有记录」的空列表: %s", w.Body.String())
	}
}

func TestAuditQueryRequiresIdentity(t *testing.T) {
	reader := &fakeAuditReader{}
	h := auditServer(t, reader)
	r := httptest.NewRequest(http.MethodGet, "/audit", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if len(reader.calls) != 0 {
		t.Fatalf("未认证请求不得触达数据层")
	}
}

// 空页必须序列化成 []，不是 null —— null 会让客户端 .map 直接抛。
// Reader 侧的非 nil 保证见 audit/query.go；这里钉住 handler 不把它改回去。
func TestAuditQuerySerialisesEmptyPageAsArrayNotNull(t *testing.T) {
	reader := &fakeAuditReader{page: audit.Page{Entries: []audit.Entry{}}}
	w := auditGet(t, auditServer(t, reader), "/audit", "operator")

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"entries":[]`) {
		t.Fatalf("空结果应为 []; got %s", w.Body.String())
	}
}

func TestAuditQuerySetsNoStore(t *testing.T) {
	reader := &fakeAuditReader{}
	w := auditGet(t, auditServer(t, reader), "/audit", "operator")

	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store（审计是敏感数据）", got)
	}
}

// 数据层错误不得回显：SQL 错误里可能带 realm 与查询条件。
func TestAuditQueryHidesStoreErrors(t *testing.T) {
	reader := &fakeAuditReader{err: errors.New(`ERROR: relation "connector_audit" does not exist (SQLSTATE 42P01)`)}
	w := auditGet(t, auditServer(t, reader), "/audit", "operator")

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", w.Code)
	}
	if strings.Contains(w.Body.String(), "connector_audit") || strings.Contains(w.Body.String(), "SQLSTATE") {
		t.Fatalf("错误细节不得回显: %s", w.Body.String())
	}
}

func TestAuditQueryRejectsNonGetMethods(t *testing.T) {
	reader := &fakeAuditReader{}
	h := auditServer(t, reader)
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		r := httptest.NewRequest(method, "/audit", nil)
		r.Header.Set("X-Lumo-User", "u1")
		r.Header.Set("X-Lumo-Realm", "r1")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s /audit: status = %d, want 405", method, w.Code)
		}
	}
}
