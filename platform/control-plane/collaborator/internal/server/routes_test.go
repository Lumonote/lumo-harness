package server

// 路由表的形状自证（§24.2 的线程面）。
//
// 这里不验业务（判据在 domain 的纯函数里、真库在 integration 里），只钉三件**只有路由表
// 才知道**的事：
//
//  1. `POST /threads/node-loss`（按节点上报）与 `POST /threads/{threadID}/node-loss`
//     （单条上报）**同时存在**且互不遮蔽 —— 少了前者的症状是上报方拿到 404，而错误信息
//     看起来像「协作服务没部署这个版本」；
//  2. `GET /threads/node-loss-notices` 不被 `GET /threads/{threadID}` 抢走。Go 1.22 的
//     mux 按「更具体的模式优先」解析，字面量段比通配段更具体——但这条规则值得钉住：
//     一旦有人把字面量改成通配（或反过来），通知的读面会静默退化成「读一条 id 是
//     node-loss-notices 的线程」并返回 404，而协调者只会看到「没有通知」；
//  3. 注册路由不 panic。两条模式若有歧义，Go 在**注册时**就 panic —— 那会让整个服务
//     起不来，而单元测试是唯一能在部署前发现它的地方。

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lumo-harness/platform/collaborator/internal/ownership"
)

// newNodeServer 只装路由表需要的东西：hub/store 为 nil（本用例不发请求，只看匹配结果）。
func newNodeServer() *Server {
	return New(nil, nil, ownership.NewRing("collaborator-0"), nil,
		slog.New(slog.NewTextHandler(discard{}, nil)))
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

func TestThreadRoutesAreRegistered(t *testing.T) {
	mux := newNodeServer().Routes()
	cases := []struct {
		method, path, wantPattern string
	}{
		{"POST", "/threads", "POST /threads"},
		{"GET", "/threads", "GET /threads"},
		{"GET", "/threads/t-1", "GET /threads/{threadID}"},
		{"POST", "/threads/t-1/state", "POST /threads/{threadID}/state"},
		{"POST", "/threads/t-1/node-loss", "POST /threads/{threadID}/node-loss"},
		// 按节点上报：字面量段，且与上面那条**段数不同**（集合上的动作 vs 单条上的动作）。
		{"POST", "/threads/node-loss", "POST /threads/node-loss"},
		// 通知读面：必须由字面量模式接住，不能被 GET /threads/{threadID} 抢走。
		{"GET", "/threads/node-loss-notices", "GET /threads/node-loss-notices"},
	}
	for _, testCase := range cases {
		request := httptest.NewRequest(testCase.method, testCase.path, nil)
		_, pattern := mux.Handler(request)
		if pattern != testCase.wantPattern {
			t.Errorf("%s %s 应匹配 %q，实际匹配 %q", testCase.method, testCase.path, testCase.wantPattern, pattern)
		}
	}
}

// 未注册的路径必须落空（不是被某个通配模式顺手接住）。
func TestThreadRoutesRejectUnknownPaths(t *testing.T) {
	mux := newNodeServer().Routes()
	for _, path := range []string{"/threads/t-1/nodes", "/threads/node-loss-notices/x", "/threadx"} {
		request := httptest.NewRequest("GET", path, nil)
		if _, pattern := mux.Handler(request); pattern != "" {
			t.Errorf("%s 不该被任何模式接住，实际匹配 %q", path, pattern)
		}
	}
	// 方法不符时落到**读**的那条模式上，而不是上报入口：`GET /threads/node-loss` 是一次
	// 「读 id 为 node-loss 的线程」（查无此行 → 404），它永远触发不了上报动作。
	// 这正是方法闸门要保证的形状——「只接受显式上报」的第一道防线。
	request := httptest.NewRequest(http.MethodGet, "/threads/node-loss", nil)
	if _, pattern := mux.Handler(request); pattern != "GET /threads/{threadID}" {
		t.Errorf("GET /threads/node-loss 应落到线程读面，实际匹配 %q", pattern)
	}
}
