package heartbeat

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// 边界的意义全在那两个点上：`[0,suspect)` / `[suspect,down)` / `[down,∞)` 是半开区间，
// off-by-one 会让「刚好 30 秒」的节点要么永远健康、要么提前被终止线程。
func TestEvaluateNodeBoundaries(t *testing.T) {
	suspect, down := 30*time.Second, 90*time.Second
	cases := []struct {
		name string
		age  time.Duration
		want NodeState
	}{
		{"刚自报过", 0, NodeHealthy},
		{"可疑阈值前 1ms", suspect - time.Millisecond, NodeHealthy},
		{"恰好等于可疑阈值", suspect, NodeSuspect},
		{"可疑与确认之间", 60 * time.Second, NodeSuspect},
		{"确认阈值前 1ms", down - time.Millisecond, NodeSuspect},
		{"恰好等于确认阈值", down, NodeDown},
		{"远超确认阈值", 10 * time.Minute, NodeDown},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := EvaluateNode("node-a", testCase.age, suspect, down)
			if got.State != testCase.want {
				t.Fatalf("age=%s 应为 %s，收到 %s（%s）", testCase.age, testCase.want, got.State, got.Reason)
			}
		})
	}
}

// 拿不到判定时**两处都不能去**：不能说健康（看板会说它还在），也不能说 down
// （会终止一条其实还在跑的线程）。suspect 是唯一安全的档——它只影响新放置。
func TestEvaluateNodeFailSafeOnUnusableInputs(t *testing.T) {
	suspect, down := DefaultSuspectAfter, DefaultDownAfter

	negative := EvaluateNode("node-a", -time.Second, suspect, down)
	if negative.State != NodeSuspect {
		t.Fatalf("年龄为负（库端时钟回拨/手工写入）应按可疑处理，收到 %s", negative.State)
	}
	if !strings.Contains(negative.Reason, "无法判定") {
		t.Fatalf("理由要能解释为什么没判 down，收到 %q", negative.Reason)
	}

	// 阈值反了（suspect >= down）会让**所有**节点同时满足 down 条件。一次配置错误不得
	// 终止全集群的线程。
	inverted := EvaluateNode("node-a", 10*time.Hour, 100*time.Second, 90*time.Second)
	if inverted.State == NodeDown {
		t.Fatalf("阈值不合法时不得判 down（配置错误会终止全集群线程），收到 %s", inverted.State)
	}
	if inverted.State != NodeSuspect {
		t.Fatalf("阈值不合法时应回落到可疑，收到 %s", inverted.State)
	}
}

func TestValidateNodeThresholds(t *testing.T) {
	if err := ValidateNodeThresholds(DefaultSuspectAfter, DefaultDownAfter); err != nil {
		t.Fatalf("默认阈值必须合法: %v", err)
	}
	// 铁律 19：严禁秒级切换。
	if err := ValidateNodeThresholds(500*time.Millisecond, time.Minute); err == nil {
		t.Fatal("亚秒级可疑阈值必须被拒（铁律 19）")
	}
	// 反了 = suspect 永远不可达，「没有可疑节点」与「一切健康」不再可区分。
	if err := ValidateNodeThresholds(2*time.Minute, time.Minute); err == nil {
		t.Fatal("可疑阈值 >= 确认阈值必须被拒")
	}
	// 相等也拒：区间 [suspect, down) 为空，同样让 suspect 不可达。
	if err := ValidateNodeThresholds(time.Minute, time.Minute); err == nil {
		t.Fatal("可疑阈值 == 确认阈值必须被拒")
	}
}

// service 过滤不是格式问题：控面服务的实例名会被当成节点名去上报，于是真正失联的节点
// 没人报，而一堆根本没有线程的「节点」被反复上报。
func TestEvaluateNodesFiltersByService(t *testing.T) {
	rows := []Heartbeat{
		{Service: "scheduler", Instance: "scheduler-0", Age: 10 * time.Minute},
		{Service: "dsh-node", Instance: "node-b", Age: 2 * time.Minute},
		{Service: "dsh-node", Instance: "node-a", Age: 5 * time.Second},
	}
	got := EvaluateNodes(rows, "", DefaultSuspectAfter, DefaultDownAfter)
	if len(got) != 2 {
		t.Fatalf("只应判节点行，收到 %+v", got)
	}
	// 按 node_id 排序：测试与日志比对要可复现（map 迭代顺序会让「谁先被上报」随机）。
	if got[0].NodeID != "node-a" || got[1].NodeID != "node-b" {
		t.Fatalf("结果应按 node_id 排序，收到 %+v", got)
	}
	if got[0].State != NodeHealthy || got[1].State != NodeDown {
		t.Fatalf("两个节点的档位判错: %+v", got)
	}

	// 空 service 走默认值（节点行的 service 名）。
	if again := EvaluateNodes(rows, "", DefaultSuspectAfter, DefaultDownAfter); len(again) != 2 {
		t.Fatalf("空 service 应取默认节点 service，收到 %d 条", len(again))
	}
	if none := EvaluateNodes(rows, "别的服务", DefaultSuspectAfter, DefaultDownAfter); len(none) != 0 {
		t.Fatalf("不匹配的 service 应为空集，收到 %+v", none)
	}
}

// 假 sink：记录每次上报，可注入失败。
type recordingSink struct {
	calls  []string
	failOn map[string]error
}

func (s *recordingSink) ReportNodeLoss(_ context.Context, nodeID, _ string) (NodeLossReceipt, error) {
	s.calls = append(s.calls, nodeID)
	if err := s.failOn[nodeID]; err != nil {
		return NodeLossReceipt{}, err
	}
	return NodeLossReceipt{Failed: 1, Ignored: 0}, nil
}

func rowsFor(ages map[string]time.Duration) []Heartbeat {
	rows := make([]Heartbeat, 0, len(ages))
	for node, age := range ages {
		rows = append(rows, Heartbeat{Service: DefaultNodeService, Instance: node, Age: age})
	}
	return rows
}

// 「绝不无限重投」：节点持续 down 的每一轮都上报一次，等于拿同一件事反复敲协作服务。
func TestNodeLossReporterReportsOncePerTransition(t *testing.T) {
	sink := &recordingSink{failOn: map[string]error{}}
	reporter, err := NewNodeLossReporter(NodeLossReporterOptions{Sink: sink})
	if err != nil {
		t.Fatalf("构造上报器失败: %v", err)
	}
	down := rowsFor(map[string]time.Duration{"node-a": 5 * time.Minute, "node-b": time.Second})

	first := reporter.ReportOnce(context.Background(), down)
	if len(first.Reported) != 1 || first.Reported[0] != "node-a" {
		t.Fatalf("第一轮应只上报 node-a，收到 %+v", first)
	}
	if len(first.Down) != 1 {
		t.Fatalf("本轮 down 的节点应只有 node-a，收到 %+v", first.Down)
	}

	second := reporter.ReportOnce(context.Background(), down)
	if len(second.Reported) != 0 {
		t.Fatalf("连续 down 的节点不得重复上报，收到 %+v", second.Reported)
	}
	if len(second.Down) != 1 {
		t.Fatalf("down 的判定仍要报给调用方（看板要看见），收到 %+v", second.Down)
	}
	if len(sink.calls) != 1 {
		t.Fatalf("sink 只该被调用一次，收到 %v", sink.calls)
	}

	// 节点回来了 → 清标记；再掉线要能再报一次（真实世界里机器会掉第二次）。
	recovered := reporter.ReportOnce(context.Background(), rowsFor(map[string]time.Duration{"node-a": time.Second}))
	if len(recovered.Recovered) != 1 || recovered.Recovered[0] != "node-a" {
		t.Fatalf("恢复的节点应被记账，收到 %+v", recovered)
	}
	again := reporter.ReportOnce(context.Background(), down)
	if len(again.Reported) != 1 {
		t.Fatalf("恢复后再次掉线必须能再上报，收到 %+v", again)
	}
}

// 上报失败必须留待重试：一次抖动不该让线程永远停在 running（而系统看起来一切正常）。
func TestNodeLossReporterRetriesAfterFailure(t *testing.T) {
	sink := &recordingSink{failOn: map[string]error{"node-a": errors.New("协作服务不可达")}}
	reporter, err := NewNodeLossReporter(NodeLossReporterOptions{Sink: sink})
	if err != nil {
		t.Fatalf("构造上报器失败: %v", err)
	}
	rows := rowsFor(map[string]time.Duration{"node-a": 5 * time.Minute})

	failed := reporter.ReportOnce(context.Background(), rows)
	if len(failed.Retried) != 1 || len(failed.Reported) != 0 {
		t.Fatalf("失败应进 Retried 且不计入 Reported，收到 %+v", failed)
	}

	delete(sink.failOn, "node-a")
	retried := reporter.ReportOnce(context.Background(), rows)
	if len(retried.Reported) != 1 {
		t.Fatalf("下一轮必须重试并成功，收到 %+v", retried)
	}
}

// suspect 只是「停止新放置」的档：此时上报会把一次网络抖动变成全集群线程终止（铁律 19）。
func TestNodeLossReporterNeverReportsSuspect(t *testing.T) {
	sink := &recordingSink{failOn: map[string]error{}}
	reporter, err := NewNodeLossReporter(NodeLossReporterOptions{Sink: sink})
	if err != nil {
		t.Fatalf("构造上报器失败: %v", err)
	}
	report := reporter.ReportOnce(context.Background(),
		rowsFor(map[string]time.Duration{"node-a": DefaultSuspectAfter + time.Second}))
	if len(report.Reported) != 0 || len(sink.calls) != 0 {
		t.Fatalf("可疑档不得上报（§7.4.1：跨节点迁移的代价远高于等待），收到 %+v", report)
	}
}

// 从心跳表里消失的节点（行被清理）不产生上报，也不在内存里留下永久条目。
func TestNodeLossReporterForgetsPrunedNodes(t *testing.T) {
	sink := &recordingSink{failOn: map[string]error{}}
	reporter, err := NewNodeLossReporter(NodeLossReporterOptions{Sink: sink})
	if err != nil {
		t.Fatalf("构造上报器失败: %v", err)
	}
	rows := rowsFor(map[string]time.Duration{"node-a": 5 * time.Minute})
	reporter.ReportOnce(context.Background(), rows)
	reporter.ReportOnce(context.Background(), nil)
	if len(reporter.reported) != 0 {
		t.Fatalf("消失的节点不应留在去重表里: %v", reporter.reported)
	}
	if len(sink.calls) != 1 {
		t.Fatalf("清理不产生新的上报，收到 %v", sink.calls)
	}
}

func TestNewNodeLossReporterRequiresSinkAndValidThresholds(t *testing.T) {
	if _, err := NewNodeLossReporter(NodeLossReporterOptions{}); err == nil {
		t.Fatal("缺 sink 必须被拒：不接出口的判定器只会安静地什么都不做")
	}
	if _, err := NewNodeLossReporter(NodeLossReporterOptions{
		Sink: &recordingSink{}, SuspectAfter: 200 * time.Millisecond, DownAfter: time.Minute,
	}); err == nil {
		t.Fatal("亚秒级阈值必须被拒（铁律 19）")
	}
}
