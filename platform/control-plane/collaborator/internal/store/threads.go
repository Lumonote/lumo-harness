package store

// 线程档位的读写（§24.2；表结构见 store.go 的 DDL，那里逐字照抄设计说明 §11）。
//
// 本包是 `threads` 的**唯一建表方与唯一写入方**，而这里的每一条语句都在守同一个不变量：
// **线程亲和到承载节点，不迁移**（§24.2.1 + architecture.md §7.1 评审 R2）。
// 三条具体做法：
//
//  1. 任何 UPDATE 的列清单里**没有 node_id / session_ref**。不是「约定不许改」，而是
//     「语句里根本没有改它们的写法」——一个想迁移的实现必须先把列加回 SET 里，那是一次
//     看得见的改动，而不是一次悄悄的参数替换。
//  2. 状态转移在事务里 `SELECT ... FOR UPDATE` 预读 + 带前置状态的 CAS 更新：0 行受影响
//     就报冲突，不重试。重试等于替调用方决定哪次转移生效（与 projects 的决策取代同训）。
//  3. 跨 realm 的读写一律按「不存在」处理（WHERE 里 realm 是首要条件）：跨租户的正确答案
//     是空集/未找到，不是错误——报错会逼出「先探测再查询」的写法，而那正是越权读取的形状。

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

// 线程读写的领域错误（server 层映射 HTTP 状态）。
var (
	// ErrThreadNotFound 不存在，或不在本 realm 内——两者不区分（见文件头第 3 条）。
	ErrThreadNotFound = errors.New("线程不存在（或不属于本 realm）")
	// ErrThreadSessionTaken 该 session_ref 已被另一条线程行占用。
	//
	// 这是 `threads_session` 唯一索引的语义化：同一个会话出现两行、各自写着不同 node_id，
	// 就是「一个线程同时活在两个节点上」。此时**不能**覆盖旧行——覆盖等于把线程从一个
	// 节点搬到另一个节点，正是 §24.2.1 禁止的迁移。
	ErrThreadSessionTaken = errors.New("该 session_ref 已属于另一条线程（一个会话只能挂一条线程行）")
	// ErrThreadIDTaken 该 id 已被占用（主键冲突）。
	//
	// 与上一条分开：改个 id 就能继续，而 session_ref 冲突改 id 也救不了。
	ErrThreadIDTaken = errors.New("该线程 id 已被占用")
	// ErrThreadConflict 并发状态变更：预读到写入之间，状态被另一个写者改了。
	ErrThreadConflict = errors.New("并发状态变更：该线程的状态刚被另一处改写，请重新读数后再决定")
	// ErrThreadNodeMismatch 上报的承载节点与线程行不符。
	//
	// 存在的理由是堵两个方向：不能在一个线程**不在**的节点上宣布它死了（误报会终止一条
	// 还在跑的线程）；也不能借「节点丢失」这个入口把线程搬到别的节点（那就是迁移）。
	ErrThreadNodeMismatch = errors.New("线程不在该承载节点上（承载节点亲和不迁移）")
)

// threadColumns 读面列清单（一处定义，免得各查询各写一遍后漂移）。
const threadColumns = `id, realm, project_id, task_id, coordinator_session_ref, session_ref,
	node_id, workspace, state, created_at, updated_at`

func scanThread(row pgx.Row) (domain.Thread, error) {
	var t domain.Thread
	err := row.Scan(&t.ID, &t.Realm, &t.ProjectID, &t.TaskID, &t.CoordinatorSessionRef,
		&t.SessionRef, &t.NodeID, &t.Workspace, &t.State, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// CreateThread 新建一条线程行。
//
// `state` 由 domain 判死为 `idle`（ValidateThreadCreate）：线程先建好、再由派发方推状态，
// 一个一出生就 running 的行会让看板把「还没放上去」显示成「在执行」。
//
// created_at / updated_at 用库的 now()：时间由**单一时钟源**给出，免得父节点与承载节点
// 的时钟差被写进同一张表，让「谁先动」这类排查失去依据。
func (s *Store) CreateThread(ctx context.Context, t domain.Thread) (domain.Thread, error) {
	if err := domain.ValidateThreadCreate(t); err != nil {
		return domain.Thread{}, err
	}
	created, err := scanThread(s.pg.QueryRow(ctx, `
		INSERT INTO threads (id, realm, project_id, task_id, coordinator_session_ref,
			session_ref, node_id, workspace, state)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING `+threadColumns,
		t.ID, t.Realm, t.ProjectID, t.TaskID, t.CoordinatorSessionRef,
		t.SessionRef, t.NodeID, t.Workspace, string(t.State)))
	if constraint := threadUniqueViolation(err); constraint != "" {
		switch constraint {
		case "threads_session":
			return domain.Thread{}, ErrThreadSessionTaken
		case "threads_pkey":
			return domain.Thread{}, ErrThreadIDTaken
		default:
			// 撞上一个本文件不认识的唯一约束 = schema 漂移。**不猜**：原样带出约束名，
			// 让它在 500 里露出来，好过把它归到某个已知桶里继续自洽。
			return domain.Thread{}, fmt.Errorf("新建线程撞上未知唯一约束 %s: %w", constraint, err)
		}
	}
	if err != nil {
		return domain.Thread{}, fmt.Errorf("新建线程失败: %w", err)
	}
	return created, nil
}

// GetThread 按 (realm, id) 读一条线程行。
func (s *Store) GetThread(ctx context.Context, realm, id string) (domain.Thread, error) {
	t, err := scanThread(s.pg.QueryRow(ctx,
		`SELECT `+threadColumns+` FROM threads WHERE realm = $1 AND id = $2`, realm, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Thread{}, ErrThreadNotFound
	}
	if err != nil {
		return domain.Thread{}, err
	}
	return t, nil
}

// ListThreads 列一个项目（或整个 realm）下的线程行；`state` 为空表示不过滤。
//
// 有界：这是给看板与协调者读的列表面，无界列表会在项目跑久之后变成一次全表扫描。
// 过滤器为空时按 id 排序而不是按时间——排序键必须**唯一**，否则分页与「同一时刻的
// 两条线程谁在前」都不确定，看板会随查询抖动。
func (s *Store) ListThreads(ctx context.Context, realm, projectID string, state domain.ThreadState, limit int) ([]domain.Thread, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	sql := `SELECT ` + threadColumns + ` FROM threads WHERE realm = $1`
	args := []any{realm}
	if projectID != "" {
		args = append(args, projectID)
		sql += fmt.Sprintf(" AND project_id = $%d", len(args))
	}
	if state != "" {
		if err := domain.ValidThreadState(state); err != nil {
			return nil, err
		}
		args = append(args, string(state))
		sql += fmt.Sprintf(" AND state = $%d", len(args))
	}
	args = append(args, limit)
	sql += fmt.Sprintf(" ORDER BY id LIMIT $%d", len(args))

	rows, err := s.pg.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Thread, 0, 16)
	for rows.Next() {
		t, err := scanThread(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// TransitionThread 把线程推进到 `to`（唯一的状态写入口）。
//
// 事务里的三步各自防一种事故：
//
//  1. `SELECT ... FOR UPDATE` 预读当前行——锁住它，让并发写者排队而不是各自以为成功；
//     同时拿到 node_id/state 用于判据（判据要用**库里的**状态，不是调用方转述的状态）。
//  2. domain.ValidateThreadTransition——合法边判定只有一处（domain 的那张表）。
//  3. `UPDATE ... WHERE id AND realm AND state = $old`——带前置状态的 CAS；0 行受影响
//     说明预读之后被抢走，报冲突。WHERE 里带 `state = $old` 还顺手保证了「终态不可复活」
//     即便状态机被改错也不会在这里静默生效。
func (s *Store) TransitionThread(ctx context.Context, realm, id string, to domain.ThreadState) (domain.Thread, error) {
	if err := domain.ValidThreadState(to); err != nil {
		return domain.Thread{}, err
	}
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return domain.Thread{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	current, err := scanThread(tx.QueryRow(ctx,
		`SELECT `+threadColumns+` FROM threads WHERE realm = $1 AND id = $2 FOR UPDATE`, realm, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Thread{}, ErrThreadNotFound
	}
	if err != nil {
		return domain.Thread{}, err
	}
	if err := domain.ValidateThreadTransition(current.State, to); err != nil {
		return domain.Thread{}, err
	}

	updated, err := scanThread(tx.QueryRow(ctx, `
		UPDATE threads SET state = $1, updated_at = now()
		WHERE id = $2 AND realm = $3 AND state = $4
		RETURNING `+threadColumns,
		string(to), id, realm, string(current.State)))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Thread{}, ErrThreadConflict
	}
	if err != nil {
		return domain.Thread{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Thread{}, err
	}
	return updated, nil
}

// FailThreadOnNodeLoss 承载节点丢失的处置（§24.2.1 末段；判据在 domain.ThreadOnNodeLoss）。
//
// `nodeID` 是**上报方声称**丢失的那个节点，必须与行上的 node_id 相等——这个参数不是为了
// 记日志，而是为了让「拿别的节点名来关掉这条线程」这件事必须显式写出来并且失败。
//
// 已终态的行原样返回（不报错、不写库）：节点丢失是至少一次投递的通知，同一个节点的丢失
// 会被心跳、调度器、协调者各报一次；对终态行报错只会让这些上报互相打架（§7.1：绝不无限重投）。
func (s *Store) FailThreadOnNodeLoss(ctx context.Context, realm, id, nodeID string) (domain.Thread, error) {
	if strings.TrimSpace(nodeID) == "" {
		return domain.Thread{}, fmt.Errorf("%w: 上报节点丢失必须给出 node_id", domain.ErrInvalidThread)
	}
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return domain.Thread{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	current, err := scanThread(tx.QueryRow(ctx,
		`SELECT `+threadColumns+` FROM threads WHERE realm = $1 AND id = $2 FOR UPDATE`, realm, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Thread{}, ErrThreadNotFound
	}
	if err != nil {
		return domain.Thread{}, err
	}
	if current.NodeID != nodeID {
		return domain.Thread{}, fmt.Errorf("%w: 线程 %s 承载于 %s，上报的是 %s",
			ErrThreadNodeMismatch, current.ID, current.NodeID, nodeID)
	}

	updated, _, err := failThreadRow(ctx, tx, current)
	if err != nil {
		return domain.Thread{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Thread{}, err
	}
	return updated, nil
}

// NodeLossOutcome 一次「按节点上报」的结果（§24.2.3(4) 的上报腿）。
//
// 两个桶分开返回，因为它们要让上报方看见**同一份事实的两个部分**：`Failed` 是本次真的被
// 终止的线程（协调者将为它们收到通知），`Ignored` 是本来就已终态的线程（至少一次投递下的
// 重复上报，幂等忽略）。合成一个数字，上报方就分不清「我报的节点确实空着」与
// 「我报的节点上的线程早就结束了」。
type NodeLossOutcome struct {
	NodeID  string          `json:"node_id"`
	Failed  []domain.Thread `json:"failed"`
	Ignored []domain.Thread `json:"ignored"`
}

// FailThreadsOnNodeLoss **按节点**上报失联：把该节点上本 realm 内所有未终态的线程一并终止。
//
// 为什么要有这个入口（而不是让心跳侧先列出线程再逐个上报）：上报方手里只有**节点**这个
// 事实——它无从知道该节点上此刻挂着哪些线程，而「谁在这台机器上」是 `threads` 表的真相，
// 只有本服务读得到。让上报方去列表再逐个报，等于把「线程清单」这份真相复制到第二个地方，
// 而两份清单之间的时间差里漏掉的线程会**永远停在 running**（没有任何人再想起它）。
//
// 三条与单条上报同源的判据，一条都没有放宽：realm 必须来自身份；`node_id` 必须非空；
// 只动 node_id 相等且未终态的行。终态行进 `Ignored` 而不写库（写一次 updated_at 会让看板
// 上的静默时长失真）。
//
// 行按 id 排序加锁：两个上报方（心跳与调度器）并发上报同一个节点时，加锁顺序一致才不会
// 互相等成死锁——顺序不一致的锁等待在 PG 里表现为随机的 40P01，而它看起来像「数据库偶发故障」。
func (s *Store) FailThreadsOnNodeLoss(ctx context.Context, realm, nodeID string) (NodeLossOutcome, error) {
	out := NodeLossOutcome{NodeID: nodeID, Failed: []domain.Thread{}, Ignored: []domain.Thread{}}
	if strings.TrimSpace(nodeID) == "" {
		return out, fmt.Errorf("%w: 上报节点丢失必须给出 node_id", domain.ErrInvalidThread)
	}
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT `+threadColumns+` FROM threads
		 WHERE realm = $1 AND node_id = $2 ORDER BY id FOR UPDATE`, realm, nodeID)
	if err != nil {
		return out, err
	}
	hosted := make([]domain.Thread, 0, 8)
	for rows.Next() {
		t, err := scanThread(rows)
		if err != nil {
			rows.Close()
			return out, err
		}
		hosted = append(hosted, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	for _, current := range hosted {
		updated, changed, err := failThreadRow(ctx, tx, current)
		if err != nil {
			return out, err
		}
		if changed {
			out.Failed = append(out.Failed, updated)
			continue
		}
		out.Ignored = append(out.Ignored, updated)
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}

// failThreadRow 一行的节点丢失处置：判据 → 状态 CAS → **通知与状态同一次写入**。
//
// 三者必须在同一个事务里，理由是「标记 failed」与「通知协调者」是同一个事实的两面：
// 分开写会出现一个窗口——线程已 failed 而通知还没落库，此时协调者既等不到通知（mailbox
// 里什么都没有），也无法从注册表分辨这条线程是「节点没了」还是「别的原因失败」
// （§3.3(3)：表达力缺口就是它没有把两种多轮形态分开）。窗口里重派与否的判断只能靠猜。
//
// 返回的第二个值表示**这一行是否真的被改动**：false = 已终态、幂等忽略（调用方据此分桶）。
func failThreadRow(ctx context.Context, tx pgx.Tx, current domain.Thread) (domain.Thread, bool, error) {
	verdict, err := domain.ThreadOnNodeLoss(current)
	if err != nil {
		return domain.Thread{}, false, err
	}
	if !verdict.ReassignRun {
		return current, false, nil
	}
	updated, err := scanThread(tx.QueryRow(ctx, `
		UPDATE threads SET state = $1, updated_at = now()
		WHERE id = $2 AND realm = $3 AND state = $4
		RETURNING `+threadColumns,
		string(verdict.State), current.ID, current.Realm, string(current.State)))
	if errors.Is(err, pgx.ErrNoRows) {
		// 预读与写入之间被抢走（并发上报里另一个写者先赢了）。这里**不重试**：重试等于
		// 替调用方决定哪一次转移生效（与 projects 的取代同训）。
		return domain.Thread{}, false, ErrThreadConflict
	}
	if err != nil {
		return domain.Thread{}, false, err
	}
	notice, err := domain.NodeLossNoticeOf(updated, verdict.Reason)
	if err != nil {
		return domain.Thread{}, false, err
	}
	// 唯一索引承担去重：至少一次投递下同一个节点会被多个观察者各报一次，第二次是空操作
	// （而不是报错——上报方无从知道自己是不是第一个）。
	if _, err := tx.Exec(ctx, `
		INSERT INTO thread_node_loss_notices
			(realm, thread_id, node_id, session_ref, coordinator_session_ref, reason)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (realm, thread_id) DO NOTHING`,
		notice.Realm, notice.ThreadID, notice.NodeID,
		notice.SessionRef, notice.CoordinatorSessionRef, notice.Reason); err != nil {
		return domain.Thread{}, false, err
	}
	return updated, true, nil
}

// ListNodeLossNotices 读本 realm 的通知增量（游标 = `seq`，严格大于 `since`）。
//
// 为什么按 `seq` 而不是时间戳：同一个节点的丢失会在同一毫秒里产生多条通知（一台机器上
// 挂着十条线程），用 `created_at > since` 拉增量时，同一毫秒里的其余几条会被**永久跳过**，
// 而它们的线程已经 failed、协调者却永远收不到通知。`seq` 由库端 `BIGSERIAL` 分配，单调且唯一。
//
// 有界：`limit` 夹在 1..500（默认 100）。这是给协调者的轮询面，无界的列表会在一个节点
// 掉线时把整个 realm 的线程一次拉回来。
func (s *Store) ListNodeLossNotices(ctx context.Context, realm string, since int64, limit int) ([]domain.NodeLossNotice, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if since < 0 {
		since = 0
	}
	rows, err := s.pg.Query(ctx, `
		SELECT seq, realm, thread_id, node_id, session_ref, coordinator_session_ref, reason, created_at
		FROM thread_node_loss_notices
		WHERE realm = $1 AND seq > $2
		ORDER BY seq
		LIMIT $3`, realm, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.NodeLossNotice, 0, 8)
	for rows.Next() {
		var n domain.NodeLossNotice
		if err := rows.Scan(&n.Seq, &n.Realm, &n.ThreadID, &n.NodeID, &n.SessionRef,
			&n.CoordinatorSessionRef, &n.Reason, &n.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// threadUniqueViolation 唯一键冲突的**归属**：返回被撞的约束名，非唯一键冲突返回空串。
//
// 为什么要区分约束名而不是笼统报「冲突」：这张表有两处唯一键，撞上它们的处置完全不同——
// `threads_pkey` 是调用方把 id 用重了（改 id 重试即可）；`threads_session` 是**同一个会话
// 已经有线程行了**（改 id 也救不了，得先查清那条行是谁的）。报成同一句话，现场会照着
// 一份错的处置清单去修。
//
// 为什么这里直接取 `pgconn.PgError` 的字段，而不是像 projects 的同名助手那样只认
// `SQLState() string`：**`ConstraintName` 是字段不是方法**，结构性接口匹配不到它。
// 这一点是真库跑出来的——只按 SQLState 判定时，两类冲突会一起落进通用分支，
// 于是「会话已被占用」被报成 500。pgconn 是 pgx 模块内的包（不是新依赖），
// 与 governance/llm-gateway 的用法一致。
func threadUniqueViolation(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return pgErr.ConstraintName
	}
	return ""
}
