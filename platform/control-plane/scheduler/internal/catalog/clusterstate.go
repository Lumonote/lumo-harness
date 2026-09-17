package catalog

// 集群状态与版本一致性注解：把联邦注册表的判定结果挂到目录的每个节点上。
//
// 放在目录这一层而不是各个调用点：List 在放置路径、节点列表、控制面寻址与指标
// 快照四处被调用，逐个加注解必然漏掉一处，而漏掉的那处就是「闸门在这条路上不生效」。
// 一次包装，四处同时成立。

import (
	"context"
	"log/slog"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// ClusterDirectory 联邦注册表的只读视图。生产实现是 store.Store。
type ClusterDirectory interface {
	ClusterAges(ctx context.Context) ([]domain.Cluster, error)
}

// clusterAnnotated 给目录里的每个节点填上它所属集群的状态与版本闸门裁决。
type clusterAnnotated struct {
	inner      Catalog
	clusters   ClusterDirectory
	annotation domain.ClusterAnnotation
	log        *slog.Logger
}

// WithClusterStates 包装目录，使每次 List 的结果都带上集群状态与版本闸门裁决
// （放置闸门的输入）。
//
// 两个闸门是**独立**的开关（见 domain.ClusterAnnotation）：只开版本闸门时
// HealthGate 为 false，节点不会被存活判定挡住，也不带状态——否则「只想拦版本不一致」
// 的部署会顺手把存活闸门也打开，而那是另一个部署决策。
//
// 读取注册表失败时**放行**（节点不带状态 → 闸门不拦），方向是刻意的：闸门是
// 「不要往可疑集群放新任务」的软闸，而读不到注册表多半意味着 PG 本身有问题——
// 那时连 PlaceTask 都写不进去，放行不会造成任何实际放置。反过来「读不到就全拦」
// 会把一次注册表读取抖动升级成整个调度停摆，而那正是本设计要避免的自伤。
func WithClusterStates(inner Catalog, clusters ClusterDirectory, annotation domain.ClusterAnnotation, log *slog.Logger) Catalog {
	if log == nil {
		log = slog.Default()
	}
	return clusterAnnotated{inner: inner, clusters: clusters, annotation: annotation, log: log}
}

func (c clusterAnnotated) List(ctx context.Context) ([]domain.Node, error) {
	nodes, err := c.inner.List(ctx)
	if err != nil {
		return nil, err
	}
	clusters, err := c.clusters.ClusterAges(ctx)
	if err != nil {
		// 留日志而不是静默：闸门在这一轮里不生效，这件事必须能从日志里看出来，
		// 否则「没有拒绝任何放置」会被读成「所有集群都健康」。
		c.log.Warn("读取集群注册表失败，本轮节点不带集群状态（放置闸门不生效）", "err", err)
		return nodes, nil
	}
	domain.AnnotateClusterStates(nodes, clusters, c.annotation)
	return nodes, nil
}

func (c clusterAnnotated) Upsert(ctx context.Context, n domain.Node) error {
	return c.inner.Upsert(ctx, n)
}
