package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// stubClusters 假注册表：这些用例要验证的是**响应形状与状态码**，不是 SQL。
type stubClusters struct {
	clusters []domain.Cluster
	byID     map[string]domain.Cluster
	regErr   error
	listErr  error
	lastReg  domain.Cluster
	regCalls int
}

func (s *stubClusters) RegisterCluster(_ context.Context, c domain.Cluster) (domain.Cluster, error) {
	s.regCalls++
	s.lastReg = c
	if s.regErr != nil {
		return domain.Cluster{}, s.regErr
	}
	// 真实实现刚写完这一刻 age 必然是 0（写语句里取的库端 now()）。
	out := c
	out.RegisteredAt, out.LastSeenAt, out.AgeMS = 1700000000000, 1700000000000, 0
	return out, nil
}

func (s *stubClusters) ClusterAges(context.Context) ([]domain.Cluster, error) {
	return s.clusters, s.listErr
}

func (s *stubClusters) ClusterByID(_ context.Context, id string) (domain.Cluster, error) {
	c, ok := s.byID[id]
	if !ok {
		return domain.Cluster{}, fmt.Errorf("%w: cluster_id=%s", store.ErrClusterNotRegistered, id)
	}
	return c, nil
}

// clusterServer 装配一个只带注册表的服务（不带 PG）。版本闸门默认关。
func clusterServer(t *testing.T, dir clusterDirectory, enforce bool) *httptest.Server {
	t.Helper()
	srv := &Server{log: slog.New(slog.DiscardHandler)}
	srv.SetClusterRegistry(dir, domain.ClusterThresholds{SuspectMS: 30000, DownMS: 90000}, enforce, false)
	ts := httptest.NewServer(srv.Routes())
	t.Cleanup(ts.Close)
	return ts
}

func do(t *testing.T, ts *httptest.Server, method, path, realm, body string) (int, string) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, ts.URL+path, reader)
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
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out)
}

// TestReportClusterTakesRealmFromIdentityNotBody realm 必须来自网关注入的身份。
//
// 与 E7 的同一条判据（隔离维度只信身份）：让请求体声明 realm 等于让调用方自选
// 隔离域，而这条端点整体在控制面令牌之后，身份是唯一可信的那一侧。
func TestReportClusterTakesRealmFromIdentityNotBody(t *testing.T) {
	dir := &stubClusters{}
	ts := clusterServer(t, dir, true)

	code, body := do(t, ts, http.MethodPut, "/v1/clusters/c1", "r1",
		`{"realm":"evil","namespace":"ns1","version":"1.2.3","capabilities":["gpu=a100"]}`)
	if code != http.StatusOK {
		t.Fatalf("注册应 200: %d %s", code, body)
	}
	if dir.lastReg.Realm != "r1" {
		t.Fatalf("realm 应取自 X-Lumo-Realm, got %q", dir.lastReg.Realm)
	}
	if dir.lastReg.ClusterID != "c1" || dir.lastReg.Namespace != "ns1" || dir.lastReg.Version != "1.2.3" {
		t.Fatalf("自报内容不符: %+v", dir.lastReg)
	}
	if len(dir.lastReg.Capabilities) != 1 || dir.lastReg.Capabilities[0] != "gpu=a100" {
		t.Fatalf("capabilities 不符: %+v", dir.lastReg.Capabilities)
	}
	var got domain.Cluster
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if got.State != domain.ClusterHealthy {
		t.Fatalf("刚自报的集群应为 healthy, got %q", got.State)
	}
}

// TestReportClusterAcceptsEmptyBodyAsHeartbeat 纯心跳必须是合法的。
func TestReportClusterAcceptsEmptyBodyAsHeartbeat(t *testing.T) {
	dir := &stubClusters{}
	ts := clusterServer(t, dir, true)
	code, body := do(t, ts, http.MethodPut, "/v1/clusters/c1", "r1", "")
	if code != http.StatusOK {
		t.Fatalf("空体自报应 200: %d %s", code, body)
	}
	if dir.regCalls != 1 || dir.lastReg.ClusterID != "c1" {
		t.Fatalf("空体自报也应写入: %+v", dir.lastReg)
	}
}

// TestReportClusterRejectsMalformedBody 坏请求不能被当成心跳放过去。
func TestReportClusterRejectsMalformedBody(t *testing.T) {
	dir := &stubClusters{}
	ts := clusterServer(t, dir, true)
	code, body := do(t, ts, http.MethodPut, "/v1/clusters/c1", "r1", `{"namespace":`)
	if code != http.StatusBadRequest || !strings.Contains(body, "bad-request") {
		t.Fatalf("坏请求体应 400: %d %s", code, body)
	}
	if dir.regCalls != 0 {
		t.Fatalf("坏请求不应写库, calls=%d", dir.regCalls)
	}
}

// TestReportClusterRequiresRealm 缺身份头时不得落库。
func TestReportClusterRequiresRealm(t *testing.T) {
	dir := &stubClusters{}
	ts := clusterServer(t, dir, true)
	code, body := do(t, ts, http.MethodPut, "/v1/clusters/c1", "", `{}`)
	if code != http.StatusBadRequest || !strings.Contains(body, "missing-realm") {
		t.Fatalf("缺 realm 应 400: %d %s", code, body)
	}
	if dir.regCalls != 0 {
		t.Fatalf("缺身份不应写库, calls=%d", dir.regCalls)
	}
}

// TestReportClusterRealmConflictIs409 跨 realm 覆盖是 409 而不是 500。
func TestReportClusterRealmConflictIs409(t *testing.T) {
	dir := &stubClusters{regErr: fmt.Errorf("%w: cluster_id=c1", store.ErrClusterRealmConflict)}
	ts := clusterServer(t, dir, true)
	code, body := do(t, ts, http.MethodPut, "/v1/clusters/c1", "r2", `{}`)
	if code != http.StatusConflict || !strings.Contains(body, "cluster-realm-conflict") {
		t.Fatalf("跨域覆盖应 409: %d %s", code, body)
	}
}

// TestGetClusterDistinguishesUnregisteredFromDown 是本组的核心判据（设计 §3.6）。
//
// 「不在注册表里」是配置事实（重试无用，去补上报方），「已注册但失联」是故障
// （去查那个集群）。两者报成同一个码会让人去改配置而真问题是服务挂了——
// 同 E4/D6 的 403/503 之分。
func TestGetClusterDistinguishesUnregisteredFromDown(t *testing.T) {
	dir := &stubClusters{byID: map[string]domain.Cluster{
		"c-down": {ClusterID: "c-down", Realm: "r1", AgeMS: 120000},
	}}
	ts := clusterServer(t, dir, true)

	code, body := do(t, ts, http.MethodGet, "/v1/clusters/c-missing", "r1", "")
	if code != http.StatusNotFound || !strings.Contains(body, "cluster-not-registered") {
		t.Fatalf("未注册集群应 404 cluster-not-registered: %d %s", code, body)
	}
	code, body = do(t, ts, http.MethodGet, "/v1/clusters/c-down", "r1", "")
	if code != http.StatusOK {
		t.Fatalf("已注册但失联应 200: %d %s", code, body)
	}
	var got domain.Cluster
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if got.State != domain.ClusterDown {
		t.Fatalf("应报 down, got %q", got.State)
	}
}

// TestListClustersReportsThresholdsAndEnforcement 列表要能读出「按什么阈值、有没有在拦」。
func TestListClustersReportsThresholdsAndEnforcement(t *testing.T) {
	dir := &stubClusters{clusters: []domain.Cluster{
		{ClusterID: "c-healthy", AgeMS: 1000},
		{ClusterID: "c-suspect", AgeMS: 40000},
		{ClusterID: "c-down", AgeMS: 120000},
	}}
	ts := clusterServer(t, dir, true)
	code, body := do(t, ts, http.MethodGet, "/v1/clusters", "r1", "")
	if code != http.StatusOK {
		t.Fatalf("列表应 200: %d %s", code, body)
	}
	var got struct {
		Clusters []domain.Cluster `json:"clusters"`
		Enforced bool             `json:"enforced"`
		Suspect  int64            `json:"suspect_ms"`
		Down     int64            `json:"down_ms"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if !got.Enforced || got.Suspect != 30000 || got.Down != 90000 {
		t.Fatalf("enforced/阈值不符: %+v", got)
	}
	want := map[string]domain.ClusterState{"c-healthy": domain.ClusterHealthy, "c-suspect": domain.ClusterSuspect, "c-down": domain.ClusterDown}
	if len(got.Clusters) != len(want) {
		t.Fatalf("集群数不符: %+v", got.Clusters)
	}
	for _, c := range got.Clusters {
		if c.State != want[c.ClusterID] {
			t.Fatalf("集群 %s: want %s, got %s", c.ClusterID, want[c.ClusterID], c.State)
		}
	}
}

// TestListClustersEmptyIsArrayNotNull 空注册表必须是 []，不是 null。
//
// `null` 会被下游反序列化成「字段缺失」，而字段缺失看起来像「这个端点坏了」——
// 库里确实一个集群都没有这件事反而说不出来。
func TestListClustersEmptyIsArrayNotNull(t *testing.T) {
	ts := clusterServer(t, &stubClusters{clusters: nil}, false)
	code, body := do(t, ts, http.MethodGet, "/v1/clusters", "r1", "")
	if code != http.StatusOK {
		t.Fatalf("列表应 200: %d %s", code, body)
	}
	if !strings.Contains(body, `"clusters":[]`) {
		t.Fatalf("空注册表应输出空数组: %s", body)
	}
	if !strings.Contains(body, `"enforced":false`) {
		t.Fatalf("未参与判定时应如实报 enforced=false: %s", body)
	}
}

// TestClusterEndpointsWithoutRegistry 未装配注册表时快速失败，不 panic。
//
// 端点始终存在（它们是别的集群上报的入口），所以「没装配」必须是一个明确的 503，
// 而不是 404（那会让人以为路径写错了）也不是 panic。
func TestClusterEndpointsWithoutRegistry(t *testing.T) {
	srv := &Server{log: slog.New(slog.DiscardHandler)}
	ts := httptest.NewServer(srv.Routes())
	defer ts.Close()
	for _, tc := range []struct{ method, path string }{
		{http.MethodPut, "/v1/clusters/c1"},
		{http.MethodGet, "/v1/clusters"},
		{http.MethodGet, "/v1/clusters/c1"},
	} {
		code, body := do(t, ts, tc.method, tc.path, "r1", "{}")
		if code != http.StatusServiceUnavailable || !strings.Contains(body, "cluster-registry-unavailable") {
			t.Fatalf("%s %s 应 503: %d %s", tc.method, tc.path, code, body)
		}
	}
}

// TestListClustersSurfacesStoreFailure 读失败是 500，不能静默变成空列表。
func TestListClustersSurfacesStoreFailure(t *testing.T) {
	ts := clusterServer(t, &stubClusters{listErr: errors.New("pg 挂了")}, true)
	code, body := do(t, ts, http.MethodGet, "/v1/clusters", "r1", "")
	if code != http.StatusInternalServerError {
		t.Fatalf("读失败应 500: %d %s", code, body)
	}
}
