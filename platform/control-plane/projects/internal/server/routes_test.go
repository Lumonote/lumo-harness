package server_test

// 路由表判据（不依赖 PG，因此**永远跑得住**——本包其余用例缺 DSN 时会整组跳过，
// 而路由冲突是注册期 panic：一条被跳过的用例会把 panic 一起藏起来）。
//
// 决策记忆那张读面有两处容易写错的形状，都在这里钉住：
//  1. `/decisions/consolidation-report`（固定字面量段）与 `/decisions/{decisionID}`
//     并存——Go 1.22 的 mux 认为字面量更具体，不会 panic；但若哪天有人把字面量段改成
//     `{report}` 形状，两条通配就会冲突，注册期直接 panic。
//  2. 决策只有「追加」一个写动作：DELETE / PATCH 必须**没有**路由。

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lumo-harness/platform/projects/internal/server"
)

func TestDecisionRoutesRegistered(t *testing.T) {
	mux := http.NewServeMux()
	// nil store 是刻意的：Register 只登记 handler，不碰存储。路由冲突会在这里 panic。
	server.New(nil, nil).Register(mux)

	cases := []struct {
		method, path, want string
	}{
		{"POST", "/v1/projects/proj_1/decisions", "POST /v1/projects/{id}/decisions"},
		{"GET", "/v1/projects/proj_1/decisions", "GET /v1/projects/{id}/decisions"},
		// 字面量段优先于通配：固化报告不能被当成一个 decisionID
		{"GET", "/v1/projects/proj_1/decisions/consolidation-report",
			"GET /v1/projects/{id}/decisions/consolidation-report"},
		{"GET", "/v1/projects/proj_1/decisions/dec_abc123", "GET /v1/projects/{id}/decisions/{decisionID}"},
	}
	for _, c := range cases {
		_, pattern := mux.Handler(httptest.NewRequest(c.method, c.path, nil))
		if pattern != c.want {
			t.Fatalf("%s %s 命中 %q, want %q", c.method, c.path, pattern, c.want)
		}
	}

	// append-only：决策没有删除与原地修改。多一个动词就是多一条绕过取代关系的路径。
	for _, c := range []struct{ method, path string }{
		{"DELETE", "/v1/projects/proj_1/decisions/dec_1"},
		{"PATCH", "/v1/projects/proj_1/decisions/dec_1"},
		{"PUT", "/v1/projects/proj_1/decisions"},
	} {
		if _, pattern := mux.Handler(httptest.NewRequest(c.method, c.path, nil)); pattern != "" {
			t.Fatalf("%s %s 不该有路由（append-only：改走取代），命中 %q", c.method, c.path, pattern)
		}
	}
}
