package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// 这组用例存在的唯一理由：**降级放置用错了锁时，两把锁各自的「能放行」用例仍然全绿。**
// 只有交叉的那几条会红。所以下面两个方向都写了。

// clusterLeaseNode 登记一个容量足够的节点。不用 placement_test 的 nodeN1：
// 那个容量是 4，而本组要连续放行若干次，贴着上限写会让用例在别处调整时莫名其妙地红。
func clusterLeaseNode(t *testing.T, st *store.Store) {
	t.Helper()
	if err := (&catalog.Pg{Pool: st.Pool()}).Upsert(context.Background(),
		domain.Node{NodeID: "N1", Realm: "r1", ClusterID: "c1", Capacity: 16, Capabilities: []string{"llm"}}); err != nil {
		t.Fatalf("登记节点失败: %v", err)
	}
}

func TestClusterLeasesAreScopedPerCluster(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	a, err := st.AcquireCluster(ctx, "cluster-a", "node-a", 5000)
	if err != nil {
		t.Fatalf("cluster-a 建租失败: %v", err)
	}
	// 作用域随租约带回：checkFencing 靠它选表，调用方不需要（也无法）另行声明。
	if a.Scope != "cluster-a" {
		t.Fatalf("租约未带回作用域: %q", a.Scope)
	}
	// 同一集群至多一个本地决策者——这一条就是「降级不是把锁拿掉」的落点。
	if _, err := st.AcquireCluster(ctx, "cluster-a", "node-b", 5000); !errors.Is(err, domain.ErrNotAcquired) {
		t.Fatalf("同集群第二个持有者应拿不到, got %v", err)
	}
	// 别的集群不受影响：不同集群的本地锁互不相干，那正是它们存在的意义。
	if _, err := st.AcquireCluster(ctx, "cluster-b", "node-b", 5000); err != nil {
		t.Fatalf("不同集群应互不阻塞: %v", err)
	}
}

func TestClusterLeaseTokenSemantics(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	a, err := st.AcquireCluster(ctx, "cluster-a", "node-a", 5000)
	if err != nil {
		t.Fatal(err)
	}
	// 续租不换 token：换则持有者自己的在途写会被自己的新 token 判为过期。
	again, err := st.AcquireCluster(ctx, "cluster-a", "node-a", 5000)
	if err != nil {
		t.Fatalf("续租失败: %v", err)
	}
	if again.FencingToken != a.FencingToken {
		t.Fatalf("续租应保持 token: got %d want %d", again.FencingToken, a.FencingToken)
	}
	// 易主才 +1。
	if err := st.ReleaseCluster(ctx, "cluster-a", "node-a"); err != nil {
		t.Fatal(err)
	}
	b, err := st.AcquireCluster(ctx, "cluster-a", "node-b", 5000)
	if err != nil {
		t.Fatalf("接管失败: %v", err)
	}
	if b.FencingToken != a.FencingToken+1 {
		t.Fatalf("易主 token 应 +1: got %d want %d", b.FencingToken, a.FencingToken+1)
	}
}

// 空 cluster_id 必须被拒。放它过去会造出一把「所有没有身份的实例」共用的锁，
// 而它们会互相认为自己是同一个集群的决策者——那正是围栏要防的事。
func TestClusterLeaseRefusesEmptyIdentity(t *testing.T) {
	st := newStore(t)
	if _, err := st.AcquireCluster(context.Background(), "", "node-a", 5000); !errors.Is(err, domain.ErrNotAcquired) {
		t.Fatalf("空集群身份应被拒, got %v", err)
	}
}

// **交叉反例**：两把锁落在两张表上，各自独立。
//
// 若 checkFencing 把表写死（无论写死成哪一张），下面四条里必然有一条红：
// 写死全局表 → 集群租约那两条红；写死集群表 → 全局租约那两条红。
func TestPlacementFencingUsesTheLeasesOwnTable(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	clusterLeaseNode(t, st)

	global, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("全局建租失败: %v", err)
	}
	cluster, err := st.AcquireCluster(ctx, "cluster-a", "node-a", 5000)
	if err != nil {
		t.Fatalf("集群建租失败: %v", err)
	}

	// 同一个持有者、同一个 token 值：两把锁在数值上完全一样，只有表不同。
	if global.FencingToken != cluster.FencingToken {
		t.Fatalf("本用例的前提是两把锁 token 相同: %d vs %d", global.FencingToken, cluster.FencingToken)
	}
	task := func(id string) domain.Task {
		return domain.Task{TaskID: id, Realm: "r1", ClusterID: "cluster-a",
			Requires: []domain.Requirement{{Key: "llm"}}}
	}
	var fo *domain.FencedOutError

	// 两把锁都在 → 两条路径都能放行。
	if _, err := st.PlaceTask(ctx, global, task("t1"), "N1"); err != nil {
		t.Fatalf("全局租约应能放置: %v", err)
	}
	if _, err := st.PlaceTask(ctx, cluster, task("t2"), "N1"); err != nil {
		t.Fatalf("集群租约应能放置: %v", err)
	}

	// 释放**集群**租约：集群租约被围栏拒，而全局租约不受影响。
	if err := st.ReleaseCluster(ctx, "cluster-a", "node-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PlaceTask(ctx, cluster, task("t3"), "N1"); !errors.As(err, &fo) {
		t.Fatalf("已释放的集群租约应被围栏拒, got %v", err)
	}
	if _, err := st.PlaceTask(ctx, global, task("t4"), "N1"); err != nil {
		t.Fatalf("集群租约的释放不该影响全局租约: %v", err)
	}

	// 反向：释放全局租约，全局被拒而集群仍可用（重新取回）。
	if err := st.Release(ctx, "node-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PlaceTask(ctx, global, task("t5"), "N1"); !errors.As(err, &fo) {
		t.Fatalf("已释放的全局租约应被围栏拒, got %v", err)
	}
	cluster2, err := st.AcquireCluster(ctx, "cluster-a", "node-a", 5000)
	if err != nil {
		t.Fatalf("重新取回集群租约失败: %v", err)
	}
	if _, err := st.PlaceTask(ctx, cluster2, task("t6"), "N1"); err != nil {
		t.Fatalf("全局租约的释放不该影响集群租约: %v", err)
	}
}
