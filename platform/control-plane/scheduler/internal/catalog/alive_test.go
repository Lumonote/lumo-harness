package catalog

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"sync/atomic"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// 四种实例各一个：可放置、排空中（健康但 enabled=false）、不健康、不健康且已禁用。
const nacosMixedHosts = `{"hosts":[
 {"ip":"10.0.0.1","port":8080,"healthy":true,"enabled":true,"metadata":{"node_id":"active","realm":"r1"}},
 {"ip":"10.0.0.2","port":8080,"healthy":true,"enabled":false,"metadata":{"node_id":"draining","realm":"r1"}},
 {"ip":"10.0.0.3","port":8080,"healthy":false,"enabled":true,"metadata":{"node_id":"unhealthy","realm":"r1"}},
 {"ip":"10.0.0.4","port":8080,"healthy":false,"enabled":false,"metadata":{"node_id":"dead-and-disabled","realm":"r1"}}
]}`

func nacosMixed(t *testing.T, calls *atomic.Int64) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(nacosMixedHosts))
	}))
	t.Cleanup(ts.Close)
	return ts
}

// 「能不能往上放新任务」与「它还活着吗」是两个问题。
//
// 排空中的节点 enabled=false：不该再接新放置（List 不含它），但它还在跑已有任务、
// 事后会回报真实结果。停滞收割问的是后一个问题，所以存活集合必须包含它——
// 与 heartbeat 包对协作服务的判据一致（健康即存活，不看 enabled）。
func TestNacosAliveIncludesDrainingButListDoesNot(t *testing.T) {
	var calls atomic.Int64
	c := NewNacos(nacosMixed(t, &calls).URL, "", "")

	nodes, err := c.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(nodes) != 1 || nodes[0].NodeID != "active" {
		t.Fatalf("放置候选只应有 active，got %+v", nodes)
	}

	alive, err := c.ListAlive(context.Background())
	if err != nil {
		t.Fatalf("ListAlive: %v", err)
	}
	sort.Strings(alive)
	if want := []string{"active", "draining"}; !reflect.DeepEqual(alive, want) {
		t.Fatalf("存活集合应为 %v（含排空节点、不含不健康节点），got %v", want, alive)
	}
}

// 快照刷新每轮先 List 再 ListAlive；两者必须出自同一次目录查询，
// 否则存活集合会让目录请求量翻倍，还可能与候选集合来自两个不同时刻。
func TestNacosAliveSharesCacheWithList(t *testing.T) {
	var calls atomic.Int64
	c := NewNacos(nacosMixed(t, &calls).URL, "", "")
	if _, err := c.List(context.Background()); err != nil {
		t.Fatalf("List: %v", err)
	}
	alive, err := c.ListAlive(context.Background())
	if err != nil {
		t.Fatalf("ListAlive: %v", err)
	}
	// 调用方改写返回值不得污染缓存。
	alive[0] = "mutated"
	again, _ := c.ListAlive(context.Background())
	for _, id := range again {
		if id == "mutated" {
			t.Fatal("缓存被调用方改写")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("缓存期内 List 与 ListAlive 应共用一次目录查询，实际 %d", calls.Load())
	}
}

// 目录不可用时存活集合必须报错，而不是返回空集：空集会被读成「没有节点活着」。
func TestNacosAliveFailsWhenCatalogFails(t *testing.T) {
	var calls atomic.Int64
	var fail atomic.Bool
	fail.Store(true)
	c := NewNacos(nacosFake(t, &calls, &fail).URL, "", "")
	if _, err := c.ListAlive(context.Background()); err == nil {
		t.Fatal("目录不可用时 ListAlive 必须返回错误")
	}
}

type aliveStub struct {
	alive []string
	err   error
}

func (aliveStub) List(context.Context) ([]domain.Node, error) { return nil, nil }
func (aliveStub) Upsert(context.Context, domain.Node) error   { return nil }
func (a aliveStub) ListAlive(context.Context) ([]string, error) {
	return a.alive, a.err
}

type plainStub struct{}

func (plainStub) List(context.Context) ([]domain.Node, error) { return nil, nil }
func (plainStub) Upsert(context.Context, domain.Node) error   { return nil }

type noClusters struct{}

func (noClusters) ClusterAges(context.Context) ([]domain.Cluster, error) { return nil, nil }

// 生产里目录总是被 WithClusterStates 包一层（判定开着时）。装饰器吞掉存活能力的话，
// 这个功能会在「判定开着」的部署里静默失效——恰好是最需要它的部署。
func TestClusterStateDecoratorPassesAliveThrough(t *testing.T) {
	wrapped := WithClusterStates(aliveStub{alive: []string{"draining"}}, noClusters{}, domain.ClusterAnnotation{}, nil)
	lister, ok := wrapped.(AliveLister)
	if !ok {
		t.Fatal("装饰后的目录必须仍然暴露 AliveLister")
	}
	alive, err := lister.ListAlive(context.Background())
	if err != nil || !reflect.DeepEqual(alive, []string{"draining"}) {
		t.Fatalf("应透传内层的存活集合，got %v %v", alive, err)
	}

	boom := errors.New("boom")
	wrapped = WithClusterStates(aliveStub{err: boom}, noClusters{}, domain.ClusterAnnotation{}, nil)
	if _, err := wrapped.(AliveLister).ListAlive(context.Background()); !errors.Is(err, boom) {
		t.Fatalf("内层错误必须透传，got %v", err)
	}
}

// 内层目录没有「存活」这个概念（PG 本地目录：没有 enabled 位）时，装饰器给出空集。
// 调用方把存活集合与候选集合取并集，所以空集等价于「没有额外信息」。
func TestClusterStateDecoratorWithoutAliveSupport(t *testing.T) {
	wrapped := WithClusterStates(plainStub{}, noClusters{}, domain.ClusterAnnotation{}, nil)
	alive, err := wrapped.(AliveLister).ListAlive(context.Background())
	if err != nil || len(alive) != 0 {
		t.Fatalf("内层不支持时应返回空集且不报错，got %v %v", alive, err)
	}
}
