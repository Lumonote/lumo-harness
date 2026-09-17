package catalog

import (
	"context"
	"errors"
	"log/slog"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

type stubNodes struct {
	nodes   []domain.Node
	err     error
	upserts int
}

func (s *stubNodes) List(context.Context) ([]domain.Node, error) {
	if s.err != nil {
		return nil, s.err
	}
	return append([]domain.Node(nil), s.nodes...), nil
}

func (s *stubNodes) Upsert(context.Context, domain.Node) error {
	s.upserts++
	return nil
}

type stubRegistry struct {
	clusters []domain.Cluster
	err      error
	calls    int
}

func (s *stubRegistry) ClusterAges(context.Context) ([]domain.Cluster, error) {
	s.calls++
	return s.clusters, s.err
}

func discard() *slog.Logger { return slog.New(slog.DiscardHandler) }

// thresholds 默认注解开关：存活闸门开、版本闸门关。
//
// 版本闸门默认**关**在这里是刻意的：这些用例钉的是存活判定与失败放行，
// 版本闸门的用例单独写在下面（TestWithClusterStatesVersionGate*），
// 混在一起会让「存活用例失败」与「版本用例失败」分不开。
func thresholds() domain.ClusterAnnotation {
	return domain.ClusterAnnotation{
		Thresholds: domain.ClusterThresholds{SuspectMS: 30000, DownMS: 90000},
		HealthGate: true,
	}
}

// versionGateAnnotation 存活闸门关、版本闸门开——验证两个开关真的独立。
func versionGateAnnotation() domain.ClusterAnnotation {
	return domain.ClusterAnnotation{
		Thresholds:  domain.ClusterThresholds{SuspectMS: 30000, DownMS: 90000},
		VersionGate: true,
	}
}

// TestWithClusterStatesAnnotates 四个取值都要能落到节点上。
func TestWithClusterStatesAnnotates(t *testing.T) {
	nodes := &stubNodes{nodes: []domain.Node{
		{NodeID: "n1", ClusterID: "c-healthy"},
		{NodeID: "n2", ClusterID: "c-suspect"},
		{NodeID: "n3", ClusterID: "c-down"},
		{NodeID: "n4", ClusterID: "c-missing"},
	}}
	registry := &stubRegistry{clusters: []domain.Cluster{
		{ClusterID: "c-healthy", AgeMS: 500},
		{ClusterID: "c-suspect", AgeMS: 45000},
		{ClusterID: "c-down", AgeMS: 100000},
	}}
	cat := WithClusterStates(nodes, registry, thresholds(), discard())

	got, err := cat.List(context.Background())
	if err != nil {
		t.Fatalf("List 失败: %v", err)
	}
	want := map[string]domain.ClusterState{
		"n1": domain.ClusterHealthy,
		"n2": domain.ClusterSuspect,
		"n3": domain.ClusterDown,
		"n4": domain.ClusterUnregistered,
	}
	for _, n := range got {
		if n.ClusterState != want[n.NodeID] {
			t.Fatalf("节点 %s: want %s, got %s", n.NodeID, want[n.NodeID], n.ClusterState)
		}
	}
}

// TestWithClusterStatesFailsOpen 注册表读不到时必须放行，且不是「静默放行」。
//
// 方向是安全属性：读不到注册表多半意味着 PG 有问题，那时 PlaceTask 也写不进去，
// 放行不会造成任何实际放置；反过来「读不到就全拦」会把一次读取抖动升级成整个
// 调度停摆。另一半是「不能静默」——闸门本轮不生效这件事必须在日志里有痕迹，
// 否则「没有拒绝任何放置」会被读成「所有集群都健康」。
func TestWithClusterStatesFailsOpen(t *testing.T) {
	nodes := &stubNodes{nodes: []domain.Node{
		{NodeID: "n1", ClusterID: "c1"},
		{NodeID: "n2", ClusterID: "c2"},
	}}
	registry := &stubRegistry{err: errors.New("pg 不可用")}
	cat := WithClusterStates(nodes, registry, thresholds(), discard())

	got, err := cat.List(context.Background())
	if err != nil {
		t.Fatalf("注册表读失败不应让目录整体失败: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("节点应原样返回, got %+v", got)
	}
	for _, n := range got {
		if n.ClusterState != domain.ClusterUnjudged {
			t.Fatalf("读不到注册表时节点不应带集群状态, got %q", n.ClusterState)
		}
		if n.ClusterState.BlocksPlacement() {
			t.Fatal("读不到注册表时闸门必须放行")
		}
	}
}

// TestWithClusterStatesPropagatesDirectoryFailure 目录本身失败时原样上抛，且不再去读注册表。
func TestWithClusterStatesPropagatesDirectoryFailure(t *testing.T) {
	wantErr := errors.New("nacos 不可用")
	nodes := &stubNodes{err: wantErr}
	registry := &stubRegistry{}
	cat := WithClusterStates(nodes, registry, thresholds(), discard())

	if _, err := cat.List(context.Background()); !errors.Is(err, wantErr) {
		t.Fatalf("目录失败应原样上抛, got %v", err)
	}
	if registry.calls != 0 {
		t.Fatalf("目录已经失败，不该再去读注册表（白跑一次查询）, calls=%d", registry.calls)
	}
}

// TestWithClusterStatesPassesThroughUpsert 包装层不得吞掉写路径，也不得给它加判定。
func TestWithClusterStatesPassesThroughUpsert(t *testing.T) {
	nodes := &stubNodes{}
	cat := WithClusterStates(nodes, &stubRegistry{}, thresholds(), discard())
	if err := cat.Upsert(context.Background(), domain.Node{NodeID: "n1", ClusterID: "c1"}); err != nil {
		t.Fatalf("Upsert 失败: %v", err)
	}
	if nodes.upserts != 1 {
		t.Fatalf("Upsert 应转发到内层, got %d", nodes.upserts)
	}
}

// TestWithClusterStatesNilLogger 未传 logger 时用默认 logger，不得 panic。
func TestWithClusterStatesNilLogger(t *testing.T) {
	nodes := &stubNodes{nodes: []domain.Node{{NodeID: "n1", ClusterID: "c1"}}}
	cat := WithClusterStates(nodes, &stubRegistry{clusters: []domain.Cluster{{ClusterID: "c1"}}}, thresholds(), nil)
	if _, err := cat.List(context.Background()); err != nil {
		t.Fatalf("List 失败: %v", err)
	}
}
