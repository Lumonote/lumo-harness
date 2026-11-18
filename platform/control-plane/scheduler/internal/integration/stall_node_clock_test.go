package integration_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/server"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

func insertNodeSeen(t *testing.T, st *store.Store, nodeID string, lastSeenMS int64) {
	t.Helper()
	if _, err := st.Pool().Exec(context.Background(), `
		INSERT INTO scheduler_nodes (node_id, realm, cluster_id, capacity, capabilities, registered_at, last_seen_at)
		VALUES ($1, 'r1', 'cn-north', 4, '[]', $2, $2)`, nodeID, lastSeenMS); err != nil {
		t.Fatalf("插入节点失败: %v", err)
	}
}

func stalledOf(t *testing.T, st *store.Store, taskID string) int64 {
	t.Helper()
	rows, err := st.StalledActiveTasks(context.Background())
	if err != nil {
		t.Fatalf("查询活跃任务失败: %v", err)
	}
	for _, row := range rows {
		if row.TaskID == taskID {
			return row.StalledMS
		}
	}
	t.Fatalf("没有找到任务 %s", taskID)
	return 0
}

// 一个放置了 9 小时、状态一直没跃迁的长任务，只要它的节点刚刚还在目录里，
// 就不是「停滞 9 小时」。attempt 行只在状态跃迁时前进，没有任何周期性刷新，
// 单看它会把「跑了 9 小时」读成「卡了 9 小时」——节点在一次快照里缺席
// （排空、Nacos 抖动）就足以让它被不可逆地判死。
func TestStallClockFollowsNodeLastSeenForLongRunningTask(t *testing.T) {
	st := newStore(t)
	now := time.Now().UnixMilli()
	insertActive(t, st, "long-run", "RUNNING", "n1", 1, now-9*3600_000, now-9*3600_000)
	insertNodeSeen(t, st, "n1", now-3_000)

	if ms := stalledOf(t, st, "long-run"); ms < 0 || ms > 30_000 {
		t.Fatalf("节点 3s 前还在目录里，停滞时长应约 3s，实际 %d ms", ms)
	}
}

// 节点真的消失了很久：时钟从「最后一次在目录里见到它」起算。
func TestStallClockGrowsOnceNodeStopsBeingSeen(t *testing.T) {
	st := newStore(t)
	now := time.Now().UnixMilli()
	insertActive(t, st, "orphan", "RUNNING", "gone", 1, now-12*3600_000, now-12*3600_000)
	insertNodeSeen(t, st, "gone", now-9*3600_000)

	ms := stalledOf(t, st, "orphan")
	if ms < 9*3600_000-60_000 || ms > 9*3600_000+60_000 {
		t.Fatalf("停滞时长应约 9h（自节点最后一次被见到起），实际 %d ms", ms)
	}
}

// 刚放置到一个早已消失的节点上的任务：最近一次状态跃迁同样是生命迹象，取两者较晚者。
func TestStallClockUsesLaterOfNodeSeenAndAttemptWrite(t *testing.T) {
	st := newStore(t)
	now := time.Now().UnixMilli()
	insertActive(t, st, "fresh", "PLACED", "gone", 1, now-2_000, now-2_000)
	insertNodeSeen(t, st, "gone", now-9*3600_000)

	if ms := stalledOf(t, st, "fresh"); ms < 0 || ms > 30_000 {
		t.Fatalf("2s 前才写过 attempt，停滞时长应约 2s，实际 %d ms", ms)
	}
}

// 升级前留下的节点行没有 last_seen_at（0）：退回 attempt 时钟，行为与升级前一致。
func TestStallClockFallsBackToAttemptWithoutNodeSighting(t *testing.T) {
	st := newStore(t)
	now := time.Now().UnixMilli()
	insertActive(t, st, "legacy", "RUNNING", "old", 1, now-10*3600_000, now-9*3600_000)
	insertNodeSeen(t, st, "old", 0)
	insertActive(t, st, "norow", "RUNNING", "none", 1, now-10*3600_000, now-9*3600_000)

	for _, id := range []string{"legacy", "norow"} {
		ms := stalledOf(t, st, id)
		if ms < 9*3600_000-60_000 || ms > 9*3600_000+60_000 {
			t.Fatalf("%s 应退回 attempt 时钟（约 9h），实际 %d ms", id, ms)
		}
	}
}

// 快照刷新是「见到节点」的唯一周期性来源：目录里有的节点被打上库端时刻，
// 目录里没有的节点不动。
func TestSnapshotRefreshRecordsNodeSightings(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	insertNodeSeen(t, st, "listed", 1)
	insertNodeSeen(t, st, "absent", 1)
	api := server.New(st, &election.State{}, staticCatalog{{NodeID: "listed", Realm: "r1", ClusterID: "cn-north", Capacity: 4}}, discardLogger())

	api.RefreshNodeSnapshot(ctx)

	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_nodes WHERE node_id='listed' AND last_seen_at > 1000`); n != 1 {
		t.Fatalf("目录里的节点应被打上最近见到的时刻")
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_nodes WHERE node_id='absent' AND last_seen_at = 1`); n != 1 {
		t.Fatalf("不在目录里的节点不得被刷新")
	}
}

type staticCatalog []domain.Node

func (c staticCatalog) List(context.Context) ([]domain.Node, error) { return c, nil }
func (c staticCatalog) Upsert(context.Context, domain.Node) error   { return nil }

var _ catalog.Catalog = staticCatalog{}

// aliveCatalog 一个区分「可放置」与「还活着」的目录：List 给放置候选，
// ListAlive 给存活集合（含排空中的节点）。
type aliveCatalog struct {
	staticCatalog
	alive    []string
	aliveErr error
}

func (c aliveCatalog) ListAlive(context.Context) ([]string, error) { return c.alive, c.aliveErr }

var _ catalog.AliveLister = aliveCatalog{}

// 健康但 enabled=false 的节点（就绪检查未过，或排空刚开始）不在放置候选里，但它
// 还活着、还在跑已有任务。停滞时钟问的是「节点消失多久了」，所以它的目击时刻必须
// 照常前进——否则一个长时间未就绪的节点会让它上面所有任务被判死，而节点事后回报的
// 真实结果会被状态机丢掉。
func TestSnapshotRefreshRecordsSightingsForDrainingNodes(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	insertNodeSeen(t, st, "listed", 1)
	insertNodeSeen(t, st, "draining", 1)
	insertNodeSeen(t, st, "gone", 1)
	cat := aliveCatalog{
		staticCatalog: staticCatalog{{NodeID: "listed", Realm: "r1", ClusterID: "cn-north", Capacity: 4}},
		alive:         []string{"listed", "draining"},
	}
	api := server.New(st, &election.State{}, cat, discardLogger())

	api.RefreshNodeSnapshot(ctx)

	for _, id := range []string{"listed", "draining"} {
		if n := rowCount(t, st, `SELECT count(*) FROM scheduler_nodes WHERE node_id='`+id+`' AND last_seen_at > 1000`); n != 1 {
			t.Fatalf("存活节点 %s 应被打上最近见到的时刻", id)
		}
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_nodes WHERE node_id='gone' AND last_seen_at = 1`); n != 1 {
		t.Fatalf("既不在候选里也不在存活集合里的节点不得被刷新")
	}
}

// 存活集合读不到时退回「只认放置候选」，而不是整轮不记目击：候选集合是已经
// 成功读到的事实，丢掉它会让所有节点的时钟一起往前走。
func TestSnapshotRefreshFallsBackToListedWhenAliveFails(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	insertNodeSeen(t, st, "listed", 1)
	insertNodeSeen(t, st, "draining", 1)
	cat := aliveCatalog{
		staticCatalog: staticCatalog{{NodeID: "listed", Realm: "r1", ClusterID: "cn-north", Capacity: 4}},
		aliveErr:      context.DeadlineExceeded,
	}
	api := server.New(st, &election.State{}, cat, discardLogger())

	api.RefreshNodeSnapshot(ctx)

	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_nodes WHERE node_id='listed' AND last_seen_at > 1000`); n != 1 {
		t.Fatalf("存活集合读取失败时，放置候选仍应被记为见到")
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_nodes WHERE node_id='draining' AND last_seen_at = 1`); n != 1 {
		t.Fatalf("没有证据表明它活着的节点不得被刷新")
	}
}

// lostNodeHarness 一个当上 leader 的调度器，目录是空的（所有节点都「不在目录中」）；
// 节点 gone 20 分钟前最后一次被见到，上面有一个跑了 3 小时的任务。
func lostNodeHarness(t *testing.T, controlURL string) (*store.Store, *server.Server) {
	t.Helper()
	st := newStore(t)
	ctx := context.Background()
	now := time.Now().UnixMilli()
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO scheduler_nodes (node_id, realm, cluster_id, capacity, capabilities, control_url, registered_at, last_seen_at)
		VALUES ('gone', 'r1', 'cn-north', 4, '[]', $1, $2, $2)`, controlURL, now-20*60_000); err != nil {
		t.Fatal(err)
	}
	insertActive(t, st, "victim", "RUNNING", "gone", 1, now-3*3600_000, now-3*3600_000)

	elec := &election.State{}
	eCtx, cancel := context.WithCancel(ctx)
	t.Cleanup(cancel)
	go election.Run(eCtx, elec, st, "reaper-test", 60*time.Second, func(bool) {})
	waitFor(t, 5*time.Second, elec.IsLeader)

	api := server.New(st, elec, staticCatalog{}, discardLogger())
	api.SetNodeLostAfter(10 * time.Minute)
	api.RefreshNodeSnapshot(ctx)
	return st, api
}

// 节点永久消失不该让它上面的任务挂满 max_stall（8h）：目录里消失够久、直连也不通，
// 两个独立证据都说它没了，就转死信，让提交方可以重试。
func TestReaperDeadLettersTasksOnLostNode(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	st, api := lostNodeHarness(t, deadURL)

	api.ReapStalledOnce(context.Background(), 8*time.Hour)

	if s := stateOf(t, st, "victim"); s != domain.StateFailed {
		t.Fatalf("失联节点上的任务应转死信（FAILED），实际 %s", s)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_dead_letters WHERE task_id='victim' AND reason LIKE 'node_lost%'`); n != 1 {
		t.Fatal("死信台账应记下 node_lost 这个原因")
	}
}

// 节点只是从目录里消失（与 Nacos 之间断连），自己还活着、直连得通：它还在跑，
// 事后会回报真实结果，不能判死。
func TestReaperSparesNodeThatStillAnswersDirectly(t *testing.T) {
	alive := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer alive.Close()
	st, api := lostNodeHarness(t, alive.URL)

	api.ReapStalledOnce(context.Background(), 8*time.Hour)

	if s := stateOf(t, st, "victim"); s != domain.StateRunning {
		t.Fatalf("直连可达的节点上的任务不得被收割，实际 %s", s)
	}
}

// 快速通道关着时行为与此前一致：只有 max_stall 那一条路径。
func TestReaperWithoutFastPathWaitsForMaxStall(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	st, api := lostNodeHarness(t, deadURL)
	api.SetNodeLostAfter(0)

	api.ReapStalledOnce(context.Background(), 8*time.Hour)

	if s := stateOf(t, st, "victim"); s != domain.StateRunning {
		t.Fatalf("快速通道关闭时 20 分钟的缺席不足以收割，实际 %s", s)
	}
}
