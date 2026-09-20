// Package store 是共享执行控制（§8.4）的持久层：**状态行 + 审计表 + 动作放行记录**。
//
// # 三张表的分工（不要合并）
//
//   - `session_control_state`：每会话一行，回答「现在是 paused 还是 running」。它是
//     **可变的当前值**，因此必须能被行锁住——跨实例仲裁靠它，不靠进程内的队列。
//   - `session_control_audit`：只追加，回答「谁在什么时候想做什么、结果如何」。
//     **放行与拒绝都写**（同 connector-gateway/internal/audit 的口径：只记成功的审计
//     等于没有审计）。它同时是控制台时间线的读面。
//   - `action_reviews`（§24.5，实现见 action_reviews.go）：只追加，回答「分类器替人
//     放行了哪个动作、凭什么」。粒度是**逐个动作**而不是逐条指令——一次工具调用一行，
//     所以它的读面必须带上限。它补的是审计缺的那一半：`approve` 可以由分类器行使之后，
//     被拒的路径有记录而放行的路径没有，等于只记「谁被拦住」、答不出「谁被放过去」。
//
// 把审计折进状态行（比如「状态行上存最近 N 条事件」）会让「谁拒过」随着后来的写入
// 消失，而权限事故的排查恰恰是从「被拒的那些次」开始的。
//
// # 本包是跨实例的唯一仲裁者（与 internal/queue 的分工）
//
// internal/queue 只给「本实例观测到的顺序」，它是进程内的，多副本下各排各的。
// 真正的仲裁是这里的状态行 `SELECT ... FOR UPDATE`：两个实例同时拿到自己的队列
// 许可后，进入本包的操作仍会被串行化。
//
// 但库端串行**不足以**得到正确状态：控制器是在进入本包之前读状态、跑状态机、算目标
// 状态的，两个实例可能都读到 `running`。所以 Commit 要求调用方带上它读到的
// `revision`，**版本不符即拒绝并让调用方重读重试**（比较后交换）。少这一步时，
// 后写者会把一个基于过期前提的决定落库，而审计里两次都写着「applied」。
//
// # 为什么不写 usage_ledger
//
// §8.4.2 说「每次控制指令（含拒）都写 UsageLedger（feature=session/control）」。
// 本服务**不写**，理由是一个具体的事实而不是偏好：`cost_type` 是跨语言闭集
// （`platform/shared/manifests/cost-types.manifest.json`，六个类型各有唯一 unit），
// 控制指令既没有 unit 也没有成本。为存一条零成本审计行而往闭集里加类型，会让**每一次
// 成本聚合查询**永久多出一个必须被过滤掉的类别，而收益只是把已经写在本表里的字段
// 复制一份。审计的完整性由本表的「放行与拒绝都写 + 只追加」保证。
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/session-control/internal/state"
)

// DDL 建两张表。
//
// `revision` 从 0 起（不是 1）：0 的含义是「这一行还没有过一次状态变更」，于是
// 「控制器读到的版本」与库里的版本可以在**未登记**与**已登记但未变更**两种情形下
// 用同一个整数比较——不必再引入一个「是否已登记」的布尔去参与 CAS。
const DDL = `
CREATE TABLE IF NOT EXISTS session_control_state (
  session_ref    TEXT PRIMARY KEY,
  realm          TEXT NOT NULL,
  state          TEXT NOT NULL,
  revision       BIGINT NOT NULL DEFAULT 0,
  last_command   TEXT NOT NULL DEFAULT '',
  last_actor     TEXT NOT NULL DEFAULT '',
  last_reason    TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_control_audit (
  id             BIGSERIAL PRIMARY KEY,
  session_ref    TEXT NOT NULL,
  realm          TEXT NOT NULL,
  command        TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  from_state     TEXT NOT NULL,
  to_state       TEXT NOT NULL,
  actor          TEXT NOT NULL DEFAULT '',
  actor_role     TEXT NOT NULL DEFAULT '',
  reason         TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL DEFAULT '',
  revision       BIGINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 投影到复制式 SessionEvent 日志（§4.2）的待办尾巴。只用一列，不加 attempts /
  -- next_attempt_at / claimed_at：投影器（E7b 一族）还没落地，而**没人读的列与
  -- 有人忘了读的列在表结构上长得一样**，等投影器真的写出来再加退避列。
  projected_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_session_control_audit_timeline
  ON session_control_audit (session_ref, id DESC);
CREATE INDEX IF NOT EXISTS idx_session_control_audit_realm_time
  ON session_control_audit (realm, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_control_audit_pending
  ON session_control_audit (id) WHERE projected_at IS NULL;
`

var (
	// ErrNotFound 表示该会话在控制面**尚无状态行**。
	//
	// 它不是「状态是 running」：本服务没有会话注册表，无从知道一个陌生会话在生产面上
	// 处于什么状态。返回一个编造的 running 会让控制台显示一个我们从没观测过的事实。
	// 读面据此回 `registered=false`，并单独给出「首条指令将以什么状态起算」。
	ErrNotFound = errors.New("该会话在控制面尚无状态行（从未有控制指令作用于它）")

	// ErrRealmMismatch 表示调用方主张的 realm 与状态行上已确立的 realm 不一致。
	//
	// 状态行的 realm 在**首次**控制指令时确立，之后不可变。这是本服务仅有的隔离
	// 手段：realm 是首要隔离边界（§10.2），一个 realm 的调用方不该能暂停另一个 realm
	// 的会话。注意当前身份来自调用方声明（控制面共享令牌之下），OPA 是唯一的授权点
	// ——正因为身份不可强认证，把 realm 钉成写后不可变才有意义。
	ErrRealmMismatch = errors.New("realm 不匹配：该会话的控制权已由另一个 realm 确立")

	// ErrConflict 表示状态行的 revision 与调用方读到的不符：在我们读状态与写状态
	// 之间，有别的实例提交了一次变更。
	//
	// **必须由调用方重读重试**，不能当成失败返回给用户（指令本身仍然可能合法）。
	// 这与 internal/queue 的 ErrBusy 是两件事：ErrBusy 是「这一刻轮不到你」，
	// ErrConflict 是「你的前提过期了」。
	ErrConflict = errors.New("状态版本冲突：该会话已被并发变更")
)

// Row 是 session_control_state 的一行。
type Row struct {
	SessionRef    string
	Realm         string
	State         state.State
	Revision      int64
	LastCommand   state.Command
	LastActor     string
	LastReason    string
	CorrelationID string
	UpdatedAt     time.Time
}

// AuditRow 是 session_control_audit 的一行（控制台时间线的一条）。
type AuditRow struct {
	ID            int64      `json:"id"`
	SessionRef    string     `json:"session_ref"`
	Realm         string     `json:"realm"`
	Command       string     `json:"command"`
	Outcome       string     `json:"outcome"`
	FromState     string     `json:"from_state"`
	ToState       string     `json:"to_state"`
	Actor         string     `json:"actor"`
	ActorRole     string     `json:"actor_role"`
	Reason        string     `json:"reason,omitempty"`
	CorrelationID string     `json:"correlation_id,omitempty"`
	Revision      int64      `json:"revision"`
	CreatedAt     time.Time  `json:"created_at"`
	ProjectedAt   *time.Time `json:"projected_at,omitempty"`
}

// Commit 是一次要落库的控制裁决。
//
// 它承载的判据必须是**控制器已经在锁外算好**的：状态机给出的目标状态、策略给出的
// 放行与否。本层只负责「在行锁之下确认前提没变，然后写下去」，不重复做业务判断
// ——两份判断一旦漂移，落库的与回给用户的就是两个结论。
type Commit struct {
	SessionRef string
	// Realm 是发起方主张的 realm。在**已登记**的会话上它必然等于会话的 realm
	// （不等就会被 realm 隔离拒掉）；未登记会话上只能用它，因为那时没有会话可归属。
	Realm string
	// Actor 是主体标识（OPA 侧的 `actor`）；ActorRole 是角色，进审计供回溯。
	Actor     string
	ActorRole string

	Command state.Command
	// ExpectedRevision 是控制器读到的版本号；0 表示「控制器认为该会话尚未登记」。
	// 与库内当前版本不符即 ErrConflict。
	ExpectedRevision int64

	// ChangeState 为 false 时只写审计、不动状态行（拒绝、无副作用、以及排队失败）。
	ChangeState bool
	// ToState 是变更后的状态；ChangeState 为 false 时被忽略。
	ToState state.State

	// Outcome 是写入审计的结果分类（见 internal/control 的 Outcome* 常量）。
	Outcome string
	Reason  string
	// FromState 用于审计；控制器传它读到的起点状态（未登记时传初始化状态）。
	FromState     state.State
	CorrelationID string
}

// CommitResult 是 Commit 的回执：状态行 + 本次审计行的 `id`。
//
// `id` 让响应与时间线里的那一行能对上（排查时「刚才那次控制」是哪条记录）。
// 这里**没有**会话内序号：复制式 SessionEvent 日志的契约（session-log.ts 第 3 条）
// 明确「序号用 dsh 原生的 SessionEvent.seq，不另造一套」——在本表里再造一份会话内
// 递增号，就是给同一条事件准备两个号，投影时必然要对齐两个序列，而它们迟早不一致。
type CommitResult struct {
	Row     Row
	AuditID int64
}

// Store 是 PG 实现。
type Store struct{ pool *pgxpool.Pool }

// New 构造存储层。
func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Init 建表（幂等）。
//
// 分成两条 Exec 而不是拼成一个字符串：失败信息要指名是哪一族表没建成。拼在一起时
// 「启动失败」这条日志不会告诉运维断在哪张表上，而两张表的成因（权限 / 既有同名的
// 异构表 / 迁移走过一半）完全不同。
//
// 幂等由 `CREATE TABLE IF NOT EXISTS` + 索引的 `IF NOT EXISTS` 保证（§22.3 规则 5），
// 因此 `init()` 跑两次不报错——这几张表可能同时被多个实例启动时建，而「谁先启动谁建」
// 是正常路径不是竞态。
func (s *Store) Init(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, DDL); err != nil {
		return fmt.Errorf("建 session_control 表失败: %w", err)
	}
	if _, err := s.pool.Exec(ctx, actionReviewDDL); err != nil {
		return fmt.Errorf("建 action_reviews 表失败: %w", err)
	}
	return nil
}

// Load 读当前状态。未登记返回 ErrNotFound（**不返回编造的 running**）。
func (s *Store) Load(ctx context.Context, sessionRef string) (Row, error) {
	if sessionRef == "" {
		return Row{}, fmt.Errorf("sessionRef 不能为空")
	}
	return scanRow(s.pool.QueryRow(ctx, `
		SELECT session_ref, realm, state, revision, last_command, last_actor,
		       last_reason, correlation_id, updated_at
		FROM session_control_state WHERE session_ref = $1`, sessionRef))
}

// Commit 把一个已裁决的结果落库。返回登记后的状态行与审计行身份。
//
// 全过程在一个事务里：
//
//  1. 尝试 `SELECT ... FOR UPDATE` 锁住状态行——**跨实例仲裁的唯一落点**；
//  2. 状态行不存在时：需要变更就先建行再锁（首条**生效的**指令把它建立为 running），
//     不需要变更则直接记一条审计就走了（不建行，理由见第 1 步的注释）；
//  3. realm 隔离校验（写后不可变）；
//  4. 比较 revision（CAS），不符即 ErrConflict；
//  5. 需要变更时更新状态并把 revision +1；
//  6. 追加审计行（含拒）。
func (s *Store) Commit(ctx context.Context, in Commit) (CommitResult, error) {
	if in.SessionRef == "" || in.Command == "" {
		return CommitResult{}, fmt.Errorf("Commit 需要 sessionRef 与 command")
	}
	if in.Realm == "" {
		return CommitResult{}, fmt.Errorf("Commit 需要 realm：审计与隔离都依赖它")
	}
	if in.ChangeState && in.ToState == "" {
		return CommitResult{}, fmt.Errorf("ChangeState 为 true 时必须给 ToState")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CommitResult{}, err
	}
	// 提交成功后的 Rollback 是空操作；失败路径靠它兜底。
	defer func() { _ = tx.Rollback(ctx) }()

	row, locked, err := lockState(ctx, tx, in.SessionRef)
	if err != nil {
		return CommitResult{}, err
	}

	if !locked && in.ChangeState {
		// 首条**生效的**控制指令建立状态行。
		//
		// 建行只在变更路径上发生，这一条是必要的而不是保守的：状态行的 realm 写后
		// 不可变，所以「谁能建立这一行」等于「谁能决定这个会话属于哪个 realm」。
		// 若被拒的尝试也建行，任何人都能用一条 realm 拼错的（或被策略拒绝的）请求把
		// 会话永久绑到错误边界上——之后真正的主人每条指令都拿到 realm_mismatch。
		// 一条本应无副作用的结论不能被赋予这种权力。
		//
		// ON CONFLICT DO NOTHING 而不是 DO UPDATE：并发的两条首指令各自都想建立它，
		// 先到者定 realm；后到者若 realm 不同会在下面被拦住，而不是悄悄把 realm 改掉。
		if _, err := tx.Exec(ctx, `
			INSERT INTO session_control_state (session_ref, realm, state)
			VALUES ($1, $2, $3) ON CONFLICT (session_ref) DO NOTHING`,
			in.SessionRef, in.Realm, string(state.StateRunning)); err != nil {
			return CommitResult{}, err
		}
		if row, locked, err = lockState(ctx, tx, in.SessionRef); err != nil {
			return CommitResult{}, err
		}
		if !locked {
			// 刚 INSERT 完还锁不到，只能是这一行被并发删掉了——本服务没有删除状态的
			// 路径，所以这不是「正常缺失」，必须响亮地失败而不是当成功。
			return CommitResult{}, fmt.Errorf("状态行在提交过程中消失：%s", in.SessionRef)
		}
	}

	if !locked {
		// 纯审计路径：会话还没有状态行，而这次结论不改状态（被拒 / 无副作用 / 被挤掉）。
		// 仍然要留审计——「有人想对一个从未被控制过的会话做某事，被拒了」正是审计要
		// 回答的问题。但没有行可锁、也没有版本可比较，起点按初始化状态记（与读面的
		// base_state 同源），revision 记 0。
		from := in.FromState
		if from == "" {
			from = state.StateRunning
		}
		auditID, err := insertAudit(ctx, tx, auditRow{
			sessionRef: in.SessionRef, realm: in.Realm, command: in.Command,
			outcome: in.Outcome, fromState: from, toState: from,
			actor: in.Actor, actorRole: in.ActorRole, reason: in.Reason,
			correlationID: in.CorrelationID, revision: 0,
		})
		if err != nil {
			return CommitResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return CommitResult{}, err
		}
		return CommitResult{
			Row: Row{
				SessionRef: in.SessionRef, Realm: in.Realm,
				State: state.StateRunning, Revision: 0,
			},
			AuditID: auditID,
		}, nil
	}

	// realm 隔离。
	if row.Realm != in.Realm {
		return CommitResult{}, ErrRealmMismatch
	}

	// CAS。比较的是**状态行的版本**：只有状态变更才推高 revision，所以「两条都
	// 合法且都无副作用」的指令不会因为版本相同而互相误判。
	if row.Revision != in.ExpectedRevision {
		return CommitResult{}, ErrConflict
	}

	fromState := in.FromState
	if fromState == "" {
		fromState = row.State
	}

	if in.ChangeState {
		row, err = scanRow(tx.QueryRow(ctx, `
			UPDATE session_control_state
			SET state = $2, revision = revision + 1, last_command = $3, last_actor = $4,
			    last_reason = $5, correlation_id = $6, updated_at = now()
			WHERE session_ref = $1
			RETURNING session_ref, realm, state, revision, last_command, last_actor,
			          last_reason, correlation_id, updated_at`,
			in.SessionRef, string(in.ToState), string(in.Command), in.Actor,
			in.Reason, in.CorrelationID))
		if err != nil {
			return CommitResult{}, err
		}
	}
	// 拒绝路径**不**更新 last_*：状态行上的 last_* 是「生效过的那条」，它是控制台
	// 「最近一次控制」的展示源。把被拒的指令也写进去，面板会显示一个从未生效的动作。

	toState := in.ToState
	if !in.ChangeState {
		toState = row.State
	}
	auditID, err := insertAudit(ctx, tx, auditRow{
		sessionRef: in.SessionRef, realm: row.Realm, command: in.Command,
		outcome: in.Outcome, fromState: fromState, toState: toState,
		actor: in.Actor, actorRole: in.ActorRole, reason: in.Reason,
		correlationID: in.CorrelationID, revision: row.Revision,
	})
	if err != nil {
		return CommitResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return CommitResult{}, err
	}
	return CommitResult{Row: row, AuditID: auditID}, nil
}

// lockState 锁住某会话的状态行。第二个返回值为 false 表示这一行不存在（不是错误）。
func lockState(ctx context.Context, tx pgx.Tx, sessionRef string) (Row, bool, error) {
	row, err := scanRow(tx.QueryRow(ctx, `
		SELECT session_ref, realm, state, revision, last_command, last_actor,
		       last_reason, correlation_id, updated_at
		FROM session_control_state WHERE session_ref = $1 FOR UPDATE`, sessionRef))
	if errors.Is(err, ErrNotFound) {
		return Row{}, false, nil
	}
	if err != nil {
		return Row{}, false, err
	}
	return row, true, nil
}

// auditRow 是一条待写入的审计行（两个提交路径共用）。
type auditRow struct {
	sessionRef, realm, actor, actorRole, reason, correlationID string
	command                                                    state.Command
	outcome                                                    string
	fromState, toState                                         state.State
	revision                                                   int64
}

func insertAudit(ctx context.Context, tx pgx.Tx, a auditRow) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO session_control_audit
		  (session_ref, realm, command, outcome, from_state, to_state, actor,
		   actor_role, reason, correlation_id, revision)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
		a.sessionRef, a.realm, string(a.command), a.outcome,
		string(a.fromState), string(a.toState), a.actor, a.actorRole,
		a.reason, a.correlationID, a.revision).Scan(&id)
	return id, err
}

// Timeline 读某会话的控制时间线（含被拒的那些），按 `id` 升序。
//
// 游标用 `id`（全局 BIGSERIAL）：它是唯一存在的一把单调键，因此 `after` 分页与
// 「按 realm 扫」的巡检面共用同一个键，不需要在两种序之间做换算。
//
// `afterID` 为 0 表示从头读。limit 由调用方夹紧（服务端上限见 internal/server）。
func (s *Store) Timeline(ctx context.Context, sessionRef string, afterID int64, limit int) ([]AuditRow, error) {
	if sessionRef == "" {
		return nil, fmt.Errorf("sessionRef 不能为空")
	}
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, session_ref, realm, command, outcome, from_state, to_state,
		       actor, actor_role, reason, correlation_id, revision, created_at, projected_at
		FROM session_control_audit
		WHERE session_ref = $1 AND id > $2
		ORDER BY id
		LIMIT $3`, sessionRef, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditRow{}
	for rows.Next() {
		var r AuditRow
		if err := rows.Scan(&r.ID, &r.SessionRef, &r.Realm, &r.Command, &r.Outcome,
			&r.FromState, &r.ToState, &r.Actor, &r.ActorRole, &r.Reason, &r.CorrelationID,
			&r.Revision, &r.CreatedAt, &r.ProjectedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// scanRow 把一行扫成 Row，并统一把 pgx.ErrNoRows 转成 ErrNotFound。
func scanRow(row pgx.Row) (Row, error) {
	var r Row
	var st, cmd string
	if err := row.Scan(&r.SessionRef, &r.Realm, &st, &r.Revision, &cmd, &r.LastActor,
		&r.LastReason, &r.CorrelationID, &r.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Row{}, ErrNotFound
		}
		return Row{}, err
	}
	r.State = state.State(st)
	r.LastCommand = state.Command(cmd)
	return r, nil
}
