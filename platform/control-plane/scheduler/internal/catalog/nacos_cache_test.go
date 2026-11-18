package catalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func nacosFake(t *testing.T, calls *atomic.Int64, fail *atomic.Bool) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if fail.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"hosts":[{"ip":"10.0.0.1","port":8080,"healthy":true,"enabled":true,"metadata":{"node_id":"n1","realm":"r1","capacity":"2"}}]}`))
	}))
	t.Cleanup(ts.Close)
	return ts
}

// 每次放置与每轮 drain 都要列节点；短缓存把突发的并发放置合并成一次目录查询。
func TestNacosListIsCachedBriefly(t *testing.T) {
	var calls atomic.Int64
	var fail atomic.Bool
	c := NewNacos(nacosFake(t, &calls, &fail).URL, "", "")
	for i := 0; i < 5; i++ {
		nodes, err := c.List(context.Background())
		if err != nil || len(nodes) != 1 || nodes[0].NodeID != "n1" {
			t.Fatalf("list: %+v %v", nodes, err)
		}
		// 调用方会就地改写节点（集群状态注解）；缓存不得被它污染。
		nodes[0].NodeID = "mutated"
	}
	if calls.Load() != 1 {
		t.Fatalf("缓存期内应只查询一次目录，实际 %d", calls.Load())
	}
}

func TestNacosCacheExpires(t *testing.T) {
	var calls atomic.Int64
	var fail atomic.Bool
	c := NewNacos(nacosFake(t, &calls, &fail).URL, "", "")
	c.cacheTTL = 10 * time.Millisecond
	_, _ = c.List(context.Background())
	time.Sleep(30 * time.Millisecond)
	_, _ = c.List(context.Background())
	if calls.Load() != 2 {
		t.Fatalf("过期后应重新查询，实际 %d", calls.Load())
	}
}

// 目录故障不得被缓存掩盖成「节点都还在」：过期后查询失败就是失败。
func TestNacosFailureIsNotServedFromExpiredCache(t *testing.T) {
	var calls atomic.Int64
	var fail atomic.Bool
	c := NewNacos(nacosFake(t, &calls, &fail).URL, "", "")
	c.cacheTTL = 10 * time.Millisecond
	_, _ = c.List(context.Background())
	fail.Store(true)
	time.Sleep(30 * time.Millisecond)
	if _, err := c.List(context.Background()); err == nil {
		t.Fatal("目录不可用时必须返回错误")
	}
}
