package lineage

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func sampleEdge() Edge {
	return Edge{
		FlowID: "f1", Version: 2, Realm: "acme",
		FromNode: "a", ToNode: "b", EdgeType: EdgeTypeData,
		FromOperator: "llm", ToOperator: "tool",
	}
}

// TestHTTPAdapterRequestShape 钉住与图引擎的线协议形状。契约漂了必须在这里炸，
// 而不是等到生产上「血缘写不进去、只看到一堆 400」。
func TestHTTPAdapterRequestShape(t *testing.T) {
	var (
		gotPath, gotMethod, gotAuth, gotCT string
		gotBody                            edgesUpsertBody
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		gotAuth, gotCT = r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := NewHTTPAdapter(srv.URL, "secret-key").UpsertLineageEdge(context.Background(), sampleEdge()); err != nil {
		t.Fatalf("正常路径不应报错: %v", err)
	}
	if gotPath != "/v1/graph/edges:upsert" {
		t.Fatalf("路径应为图适配器约定，实际 %q", gotPath)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("方法应为 POST，实际 %q", gotMethod)
	}
	if gotCT != "application/json" {
		t.Fatalf("Content-Type 应为 application/json，实际 %q", gotCT)
	}
	if gotAuth != "Bearer secret-key" {
		t.Fatalf("配了 apiKey 时必须带 Bearer 头，实际 %q", gotAuth)
	}
	if len(gotBody.Edges) != 1 {
		t.Fatalf("body 应含恰好一条边，实际 %d", len(gotBody.Edges))
	}
	e := gotBody.Edges[0]
	if e.From != "flow:f1:v2:a" || e.To != "flow:f1:v2:b" {
		t.Fatalf("图节点 id 必须带 flow/version 前缀（跨版本不能混为一节点），实际 %q→%q", e.From, e.To)
	}
	if e.Kind != EdgeTypeData || e.Realm != "acme" {
		t.Fatalf("kind/realm 应随边携带，实际 kind=%q realm=%q", e.Kind, e.Realm)
	}
	for k, want := range map[string]string{
		"flow_id": "f1", "version": "2", "from_operator": "llm",
		"to_operator": "tool", "edge_type": EdgeTypeData,
	} {
		if e.Properties[k] != want {
			t.Fatalf("properties[%q] 应为 %q，实际 %q", k, want, e.Properties[k])
		}
	}
}

// TestHTTPAdapterNoKeyOmitsAuthHeader 空 apiKey 不该发出一个空的 Authorization 头：
// 一个空头会让某些网关直接 401，而「本地部署不校验」时又显得莫名其妙。
func TestHTTPAdapterNoKeyOmitsAuthHeader(t *testing.T) {
	var auth string
	var seen bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, seen = r.Header["Authorization"]
		auth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := NewHTTPAdapter(srv.URL, "").UpsertLineageEdge(context.Background(), sampleEdge()); err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if seen || auth != "" {
		t.Fatalf("未配 apiKey 时不应带 Authorization 头，实际存在=%v 值=%q", seen, auth)
	}
}

// TestHTTPAdapterNon2xxIsAnError 非 2xx 必须变成错误交给投影器退避。
// 这里返回 200 是「静默失败」，投影器会误标 projected_at 而边其实从未入图。
func TestHTTPAdapterNon2xxIsAnError(t *testing.T) {
	for _, code := range []int{http.StatusBadRequest, http.StatusInternalServerError, http.StatusServiceUnavailable} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(code)
		}))
		err := NewHTTPAdapter(srv.URL, "").UpsertLineageEdge(context.Background(), sampleEdge())
		srv.Close()
		if err == nil {
			t.Fatalf("HTTP %d 应报错，实际通过", code)
		}
		if !strings.Contains(err.Error(), strconv.Itoa(code)) {
			t.Fatalf("错误必须含状态码 %d 以便巡检定位，实际 %q", code, err.Error())
		}
	}
}

// TestHTTPAdapterUnreachable 目标不可达时要返回带上下文的错误，而不是 panic 或 nil。
func TestHTTPAdapterUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // 关掉后再打：模拟 Nebula 没起来

	err := NewHTTPAdapter(url, "").UpsertLineageEdge(context.Background(), sampleEdge())
	if err == nil {
		t.Fatal("不可达应报错")
	}
	if !strings.Contains(err.Error(), "血缘投影请求失败") {
		t.Fatalf("错误应点明是投影请求失败，实际 %q", err.Error())
	}
}
