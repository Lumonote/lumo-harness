package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// MigratableStates 允许被漂移的状态——活跃态里的一个**真子集**。
//
// 从 ActiveStates 里刻意去掉 CANCELLING：取消是用户意图，原节点收到停止请求后
// 可能正在走向 ABORTED；把它漂到别的集群等于**丢掉那次取消**——新 attempt 上的
// 节点并不知道有人要求它停，于是任务会在别处正常跑完，而调用方以为它被取消了。
// 卡死的 CANCELLING 有另一条兜底（stall reaper 的 max_stall 死信），不需要漂移管。
//
// 与 ActiveStates 一样从 domain 常量拼出来，不在 SQL 里写字符串字面量：字面量
// 与状态机脱节时，改状态名会静默漏掉一态，而漏掉的那一态会变成「永远不会被漂移」
// ——又一条看起来对、实际不工作的规则。
func MigratableStates() []string {
	return []string{string(domain.StatePlaced), string(domain.StateRunning)}
}

// MigratableActive 一个待在失联集群上、可能被漂移的活跃任务。
type MigratableActive struct {
	TaskID    string
	Realm     string
	ClusterID string
	NodeID    string
	Attempt   int
	State     string
	// AvoidNodes 当前反亲和名单（JSON 数组文本）。漂移要把原节点追加进去，
	// 所以必须**读出来再写回**，不能在 SQL 里拼 JSON——列是 TEXT，拼接等于把
	// 一个字符串结构当字节串改，一旦存量内容不是规范形式就会写出坏 JSON。
	AvoidNodes string
}

// MigratableActiveTasks 取指定集群上的可漂移任务。
//
// 按 cluster_id 过滤而不是「取全部活跃任务再在 Go 侧筛」：判定输入是
// 「**本集群**已确认 down」，不属于该集群的任务不在本判据的射程内——它们是
// 别的集群（或全局任务）的事，顺手把没失联集群的任务也搬走是另一件事。
//
// 结果按 task_id 排序：确定性便于测试与日志比对（同一个库状态下两轮循环看到的
// 顺序一致），扫描顺序本身没有语义。
func (s *Store) MigratableActiveTasks(ctx context.Context, clusterIDs []string) ([]MigratableActive, error) {
	if len(clusterIDs) == 0 {
		// 空集合直接短路：`= ANY('{}')` 恒假，跑一趟库只会白费一次往返。
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT task_id, realm, cluster_id, COALESCE(node_id, ''), attempt, state, avoid_nodes
		FROM scheduler_tasks
		WHERE state = ANY($1) AND cluster_id = ANY($2)
		ORDER BY task_id`, MigratableStates(), clusterIDs)
	if err != nil {
		return nil, fmt.Errorf("scheduler: 查询可漂移任务失败: %w", err)
	}
	defer rows.Close()
	var out []MigratableActive
	for rows.Next() {
		var row MigratableActive
		if err := rows.Scan(&row.TaskID, &row.Realm, &row.ClusterID, &row.NodeID,
			&row.Attempt, &row.State, &row.AvoidNodes); err != nil {
			return nil, fmt.Errorf("scheduler: 扫描可漂移任务失败: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// MigrationRecord 一条漂移台账记录。判据的四个量（来自哪个集群/节点、该集群自报
// 年龄、决策当时的目录快照年龄）全部落库，这样事后能复核这个决定当时依据了什么
// ——它是**在证据不充分时**做出的（集群没自报 ≠ 原节点已停止执行）。
type MigrationRecord struct {
	TaskID        string
	Attempt       int
	Realm         string
	FromClusterID string
	FromNodeID    string
	Reason        string
	ClusterAgeMS  int64
	SnapshotMS    int64
}

// MigrationResult 一次漂移的落地结果。
type MigrationResult struct {
	// Applied 条件写是否生效。false 表示期间任务被推进了（节点回报了终态、
	// 被重新放置、被取消），**不是错误**。
	Applied bool
	// VoidedDispatches 被作废的「未认领」派发行数。>0 说明原节点的执行请求还
	// 躺在 outbox 里等人认领——不删它，它就会在漂移之后被投给原节点。
	VoidedDispatches int64
}

// MigrateTask 把一个已确认属于失联集群的活跃任务漂回全局队列（§7.4.1
// 「任务漂回全局 Task Bus 重放置」）。
//
// # 为什么是「置回 PENDING」而不是「直接指定目标集群」
//
// 漂移只负责**解除旧的绑定**，不负责**挑新位置**：
//
//   - `state='PENDING'` + `node_id=NULL` → drain loop 下一轮把它当作新任务放置；
//   - `cluster_id=”` → `EligibleNodes` 不再按集群过滤（`planner.go:42` 的过滤以
//     非空为前提），而失联集群的节点已被放置闸门挡住（`BlocksPlacement`），于是
//     它自然落到健康集群。**选哪个集群是放置的事，不是漂移的事**——偏好打分
//     （clusterTag/region 亲和）不在本轮范围，在这里塞一个「目标集群」参数
//     等于把打分逻辑偷偷长在漂移里。
//   - `avoid_nodes` 追加原节点（理由见下）。
//   - `attempt` **保持不动**：下一次 PlaceTask 在 PENDING 上开 attempt+1（既有
//     逻辑，`store.go` 的 `attempt = prevAttempt + 1`）。
//
// # fencing 靠的是什么
//
// 就是上面那条 attempt 不动。原节点用旧 attempt 回报终态时，
// `CompleteTaskAttempt` 要求「仍处于活跃态 **且** attempt 相等」
// （`state IN ('PLACED','RUNNING','CANCELLING') AND attempt = $3`），漂移之后两条
// 都不成立 → 回报不生效、不释放新 attempt 的槽位、不把任务误判成终态。
// 这与 §7.4.1「跨集群重放置产生新 attempt 而非并行执行」是同一件事：**记录层面**
// 只有一个有效 attempt。
//
// # 为什么还要追加 avoid_nodes
//
// 因为上面的 fencing 只在**回报**层面成立，它阻止不了原节点在物理上仍在执行
// ——判据只能确认「目录里没有它」，那不等于「它已经停了」（集群可能只是自报中断，
// 任务其实在正常跑）。此时若原集群随后恢复、而任务又被放回**同一个节点**，
// 就是实打实的双执行。反亲和是现成机制（`planner.EligibleNodes` 里的
// `contains(task.AvoidNodes, n.NodeID)`），一行就能堵掉这条路。
// 这是承认「fencing 无法被完全确认」之后的诚实补偿，不是锦上添花。
//
// # 为什么必须顺手作废「未认领」的派发
//
// `scheduler_dispatch_outbox` 是派发的唯一真相，`ClaimDispatch` 只看
// `node_id + claimed_by IS NULL + delivered_at IS NULL`——**它不看任务状态**。
// 于是漂移之后，一条还没被认领的旧 attempt 派发行仍会被投给原节点，把 fencing
// 从后门绕过去。`RequeueStaleDispatch` 那边有 `EXISTS (state IN ('PLACED','RUNNING'))`
// 守卫，只挡住了**已认领**那半边的**回收**；未认领这半边没人管，只能由漂移自己删。
//
// 已认领的行**不删**：那条 RPC 可能已经发出或正在发，删行只会让本地账目与实际
// 不符；而它的回收路径已被上面那条 EXISTS 守卫挡死（漂移后 state=PENDING），
// 留着是安全的、也是诚实的。
//
// # 条件写
//
// 两个条件缺一不可：状态仍可漂移、attempt 仍是调用方观测到的那一代。任一不成立
// 都说明期间有人推进了它——那时**什么都不做**才是对的。判定与落库之间隔着一次
// 数据库往返和一轮目录刷新，把「刚才观察到的事实」当成「现在仍然成立」是这类
// 收割逻辑最常见的错法。返回 `Applied=false` 不是错误。
//
// 台账与状态在同一事务内落库：分开写会出现「任务已经被搬走但没人知道为什么」的
// 窗口，而台账的全部价值就在于解释那次搬家。
func (s *Store) MigrateTask(ctx context.Context, rec MigrationRecord) (MigrationResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MigrationResult{}, fmt.Errorf("scheduler: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 先取当前行并加锁。反亲和名单必须读出来再改（列是 TEXT，SQL 侧拼 JSON
	// 会在存量内容不是规范形式时写出坏 JSON）。
	var (
		state      string
		attempt    int
		fromClus   string
		avoidNodes string
	)
	err = tx.QueryRow(ctx, `
		SELECT state, attempt, cluster_id, avoid_nodes FROM scheduler_tasks
		WHERE task_id = $1 FOR UPDATE`, rec.TaskID).
		Scan(&state, &attempt, &fromClus, &avoidNodes)
	if errors.Is(err, pgx.ErrNoRows) {
		return MigrationResult{}, nil
	}
	if err != nil {
		return MigrationResult{}, fmt.Errorf("scheduler: 查询待漂移任务失败: %w", err)
	}
	// 条件①：仍处于可漂移的状态（既挡住「已经被漂走（PENDING）」，也挡住
	// 「节点回报了终态」与「已被重新放置（新 attempt 但仍是 PLACED）」）。
	if !containsString(MigratableStates(), state) {
		return MigrationResult{}, nil
	}
	// 条件②：仍是调用方观测到的那一代。
	if attempt != rec.Attempt {
		return MigrationResult{}, nil
	}
	// 条件③：任务仍属于调用方判定为失联的那个集群。
	//
	// rec.FromClusterID 本身就是判据的一部分（「它确实在被我判为失联的那个集群上」），
	// 而判定与落库之间隔着一次数据库往返：期间任务可能被取消、重排队并被放到
	// **另一个**集群（`QueueTask` 会重写 cluster_id，全局任务更是不受集群约束）。
	// 那时它是一个健康集群上的正常任务，按旧观测把它搬走是错的。
	// 这一条同时让整个函数对**重复提交同一份观测**是幂等的。
	if fromClus != rec.FromClusterID {
		return MigrationResult{}, nil
	}

	updated, err := appendAvoidNode(avoidNodes, rec.FromNodeID)
	if err != nil {
		return MigrationResult{}, fmt.Errorf("scheduler: 任务 %s 的反亲和名单非法，拒绝漂移: %w", rec.TaskID, err)
	}

	tag, err := tx.Exec(ctx, `
		UPDATE scheduler_tasks
		SET state = 'PENDING', node_id = NULL, cluster_id = '', avoid_nodes = $3,
		    updated_at = `+nowMS+`
		WHERE task_id = $1 AND attempt = $2 AND state = ANY($4)`,
		rec.TaskID, rec.Attempt, updated, MigratableStates())
	if err != nil {
		return MigrationResult{}, fmt.Errorf("scheduler: 写漂移状态失败: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return MigrationResult{}, nil
	}

	voided, err := tx.Exec(ctx, `
		DELETE FROM scheduler_dispatch_outbox
		WHERE task_id = $1 AND attempt = $2 AND claimed_by IS NULL AND delivered_at IS NULL`,
		rec.TaskID, rec.Attempt)
	if err != nil {
		return MigrationResult{}, fmt.Errorf("scheduler: 作废未认领派发失败: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO scheduler_task_migrations
			(task_id, attempt, realm, from_cluster_id, from_node_id, reason,
			 cluster_age_ms, snapshot_ms, recorded_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,`+nowMS+`)
		ON CONFLICT (task_id, attempt) DO NOTHING`,
		rec.TaskID, rec.Attempt, rec.Realm, rec.FromClusterID, rec.FromNodeID,
		rec.Reason, rec.ClusterAgeMS, rec.SnapshotMS); err != nil {
		return MigrationResult{}, fmt.Errorf("scheduler: 写漂移台账失败: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return MigrationResult{}, fmt.Errorf("scheduler: 提交漂移失败: %w", err)
	}
	return MigrationResult{Applied: true, VoidedDispatches: voided.RowsAffected()}, nil
}

// MigrationRecorded 查询一个 (task_id, attempt) 是否已进漂移台账。
// 供测试与运维核对：台账是事后唯一能回答「这个任务为什么换了集群」的地方。
func (s *Store) MigrationRecorded(ctx context.Context, taskID string, attempt int) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM scheduler_task_migrations WHERE task_id = $1 AND attempt = $2)`,
		taskID, attempt).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("scheduler: 查询漂移台账失败: %w", err)
	}
	return exists, nil
}

// appendAvoidNode 把节点追进 JSON 数组文本，已存在则不重复追加。
//
// 解析失败**返回错误而不是当成空数组**：后者会静默丢掉已有的整份反亲和名单，
// 而那正是这个字段存在的意义。坏行会让该任务的漂移中止并留下错误日志——
// 响亮地停住，好过安静地放宽约束。
func appendAvoidNode(existing, nodeID string) (string, error) {
	var nodes []string
	if existing != "" {
		if err := json.Unmarshal([]byte(existing), &nodes); err != nil {
			return "", err
		}
	}
	if nodeID != "" && !containsString(nodes, nodeID) {
		nodes = append(nodes, nodeID)
	}
	if nodes == nil {
		// nil slice 会序列化成 `null` 而不是 `[]`。两者在下游等价（Unmarshal 都不
		// 报错），所以它不会出错——只会与本列 DDL 默认值（`'[]'`）不一致，
		// 让「这行是谁写的」变得难查。统一成 `[]`。
		nodes = []string{}
	}
	out, err := json.Marshal(nodes)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func containsString(items []string, wanted string) bool {
	for _, item := range items {
		if item == wanted {
			return true
		}
	}
	return false
}
