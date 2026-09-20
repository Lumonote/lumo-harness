package integration_test

import (
	"context"
	"testing"
)

// lumoGovernedDDL 是 `lumo_governed_executions` 的最小形状——**手抄**自
// `dsh-plugins/subagent-host/src/governed-dispatch.ts` 的 `GOVERNED_EXECUTION_DDL`。
//
// 跨语言没法共用一份声明，所以这里有一条真实的漂移风险：插件改了列名而这里没跟。
// 缓解它的不是注释而是本文件第二条用例——它建表、插入、查询，列名对不上就会红。
// 而**第一条用例（表不存在时报错）反而是不依赖这份 DDL 的**，它才是重点。
const lumoGovernedDDL = `
CREATE TABLE IF NOT EXISTS lumo_governed_executions (
  run_id TEXT PRIMARY KEY, realm TEXT NOT NULL, node_id TEXT NOT NULL,
  worker_id TEXT NOT NULL, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
  attempt INTEGER NOT NULL, execution JSONB NOT NULL, result JSONB,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_delivery_at TIMESTAMPTZ NOT NULL DEFAULT now(), delivered_at TIMESTAMPTZ,
  delivery_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT ''
)`

func dropGovernedTable(t *testing.T) {
	t.Helper()
	if _, err := newStore(t).Pool().Exec(context.Background(), `DROP TABLE IF EXISTS lumo_governed_executions`); err != nil {
		t.Fatalf("清理 lumo_governed_executions 失败: %v", err)
	}
}

// 表不存在时必须**报错**，绝不能悄悄返回空 map。
//
// 这是本项指标唯一真正危险的分支：`governedWorker` 默认关闭，所以「这个部署根本不跑
// 受治理执行」是**常态**而不是异常。如果查询把「表不存在」吞成空结果，指标就会发布
// 一个 0——而 0 说的是「跑了，一个孤儿都没有」。两者在图上不同形，处置也不同
// （前者没事，后者要去看台账），所以调用方必须能区分，也就必须拿到 error。
func TestUnsettledExecutionsByNodeFailsWhenTableMissing(t *testing.T) {
	st := newStore(t)
	dropGovernedTable(t)

	out, err := st.UnsettledExecutionsByNode(context.Background())
	if err == nil {
		t.Fatalf("表不存在时必须报错，实得 %v（空 map 会被发布成 0，即「跑了但没有孤儿」）", out)
	}
	if out != nil {
		t.Fatalf("报错时不该同时返回结果，实得 %v", out)
	}
}

// 分组计数只数**没有结果**的行。已有结果的行留在表里做台账（`save()` 的可变条件就靠
// `result IS NULL OR result = $4`），把它们算进孤儿会让指标随历史单调增长。
func TestUnsettledExecutionsByNodeCountsOnlyUnsettled(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	dropGovernedTable(t)
	if _, err := st.Pool().Exec(ctx, lumoGovernedDDL); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	t.Cleanup(func() { dropGovernedTable(t) })

	insert := func(runID, nodeID string, settled bool) {
		result := "NULL"
		if settled {
			result = `'{"state":"COMPLETED"}'::jsonb`
		}
		if _, err := st.Pool().Exec(ctx, `
			INSERT INTO lumo_governed_executions (run_id, realm, node_id, worker_id, project_id, instance_id, attempt, execution, result)
			VALUES ($1, 'r1', $2, 'w1', 'p1', 'i1', 1, '{}'::jsonb, `+result+`)`, runID, nodeID); err != nil {
			t.Fatalf("插入执行行失败: %v", err)
		}
	}
	insert("run-1", "node-a", false)
	insert("run-2", "node-a", false)
	insert("run-3", "node-b", false)
	insert("run-4", "node-b", true) // 已结算，不该计入
	insert("run-5", "node-c", true) // 同上

	got, err := st.UnsettledExecutionsByNode(ctx)
	if err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if got["node-a"] != 2 || got["node-b"] != 1 {
		t.Fatalf("分组计数不对：%v（期望 node-a=2 node-b=1）", got)
	}
	if _, exists := got["node-c"]; exists {
		t.Fatalf("全部已结算的节点不该出现在结果里：%v", got)
	}
}
