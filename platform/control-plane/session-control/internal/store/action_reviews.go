// 动作放行记录（§24.5）的建表与读写面。**本文件是 `action_reviews` 的唯一建表方**
// （本仓库的 DDL 归属纪律：一张表只能有一个建表方，否则先启动的那个定 schema，后到者
// 静默拿到一张自己没写过的表）。
//
// 它落在本服务而不是别处，理由是这张表的**族**：它和 `session_control_state` /
// `session_control_audit` 是同一族——都是「谁在什么时候对什么做了判定」的控制面事实，
// 由同一个服务拥有、同一次 `init()` 建立、同一个连接池读写。拆到另一个服务去建，
// 只会让同一次 `Init` 变成两次、两地。
//
// 与另外两张表的分工见 store.go 的包注释（不要合并）：本表记的是**逐个动作的放行判定**，
// 粒度比控制指令细得多——每次工具调用都可能产生一行。
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/session-control/internal/release"
)

// actionReviewDDL 与 §11 ③ **逐字**相同（表名、列名、索引名都不改）。
//
// 为什么不在这里「顺手改良」：§11 的表是设计定稿，全文有交叉引用指向这些名字；
// 改名会让设计文档与实现各说一套，而这类漂移在下一次有人照文档写查询时才会暴露
// （写出来的 SQL 报 42703，然后有人把文档改掉来「修复」它）。
//
// 闭集（`band` / `decider`）在 PG 侧**没有 CHECK 约束**，这不是疏漏：加 CHECK 会把
// 闭集的执行点变成两个（PG 与写入方），而 §11 的 DDL 已定稿不改。执行点是
// internal/release 的 Validate —— 每一个能写这张表的入口都必须过它。
const actionReviewDDL = `
CREATE TABLE IF NOT EXISTS action_reviews (
  id            TEXT PRIMARY KEY,
  realm         TEXT NOT NULL,
  session_ref   TEXT NOT NULL,
  run_id        TEXT,                     -- §23.3 的 Run
  action        TEXT NOT NULL,            -- 工具名 / 外部动作标识
  band          TEXT NOT NULL,            -- 闭集：AUTO | REVIEW | DENY
  decider       TEXT NOT NULL,            -- 闭集：classifier | human | fallback
  reason        TEXT NOT NULL,
  denied_streak INT NOT NULL DEFAULT 0,   -- 连续被拒计数（兜底判据）
  denied_total  INT NOT NULL DEFAULT 0,   -- 单 Run 累计被拒计数（兜底判据）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_reviews_recent
  ON action_reviews (realm, session_ref, created_at DESC);
`

// actionReviewDefaultLimit 是读面的兜底上限。
//
// 它**必须**存在：本表随每一次工具调用增长（§24.5 的放行判定是逐动作的），而无上限的
// 读面等于让控制面的内存跟着会话的工具调用次数走。HTTP 层的缺省值与上限见 internal/server。
const actionReviewDefaultLimit = 100

// actionReviewColumns 两处 SQL 共用的列清单。抽出来是为了让「INSERT 的列」与
// 「SELECT 的列」不可能漂移——漂移的症状是 RETURNING 与 Scan 对不上，
// 而那只会在运行时、在写成功之后才报错。
const actionReviewColumns = `id, realm, session_ref, run_id, action, band, decider,
	       reason, denied_streak, denied_total, created_at`

var (
	// errNoActionReview 是内部信号：这个 id 上没有行。
	//
	// 两个调用点各有含义，都**不是**基础设施故障：
	//   - INSERT ... ON CONFLICT DO NOTHING 没返回行 → 同 id 已存在（下面走重放/冲突分支）；
	//   - 冲突后的读回查不到 → 行在我们写入与读回之间消失了。本表没有删除路径，
	//     出现这一点说明有人绕过本服务动了库，必须响亮地失败而不是当作正常缺失。
	errNoActionReview = errors.New("action_reviews 上没有这一行")

	// ErrReviewIDConflict 表示同 id 已存在，且内容与本次要写的**不同**。
	//
	// 它与「重放」必须分开：同 id 同内容是网络重试（返回既有行，不重复写入），
	// 同 id 不同内容是**两个不同的判定在抢一个身份**——覆盖任意一方都会让审计少掉
	// 一次放行（或一次回落），因此只拒绝、不改写。
	ErrReviewIDConflict = errors.New("动作放行记录的 id 已被另一条内容不同的记录占用")
)

// ActionReview 是 action_reviews 的一行。
//
// Band / Decider 用闭集类型而不是 string：这两个字段的合法性是**类型 + 校验**两层
// 保证的，用裸 string 会让「写进去一个 ALLOW」在编译期完全没有阻力。
type ActionReview struct {
	ID         string `json:"id"`
	Realm      string `json:"realm"`
	SessionRef string `json:"session_ref"`
	// RunID 为 nil 表示「不属于任何 Run」（列可空，§22.3 规则 2：NULL 是语义）。
	RunID        *string         `json:"run_id,omitempty"`
	Action       string          `json:"action"`
	Band         release.Band    `json:"band"`
	Decider      release.Decider `json:"decider"`
	Reason       string          `json:"reason"`
	DeniedStreak int             `json:"denied_streak"`
	DeniedTotal  int             `json:"denied_total"`
	CreatedAt    time.Time       `json:"created_at"`
}

// RecordActionReview 追加一条放行记录，返回落库后的行与「这次是否真的写入了」。
//
// **append-only**：本包对这张表只有这一条写路径，没有 UPDATE、没有 DELETE——审计表
// 上任何一条原地修改都会让「谁放行了什么」变成「最后一次写成什么」（§22.5 把
// `usage_ledger` 的 append-only 列为不可逆决定，本表同理）。
//
// 返回值 `created` 区分两种成功：
//   - true：这次真的插入了；
//   - false：同 id 同内容已存在（重试），返回**既有**行。
//
// 两者都是成功，因为调用方的下一次动作相同（继续跑），但审计对账需要知道这一次到底
// 写没写——把重试回成「新建」会让人以为库里有两行。
func (s *Store) RecordActionReview(ctx context.Context, in release.Record) (ActionReview, bool, error) {
	// 与 HTTP 层调用的是**同一份**判据：绕过 HTTP 的调用方（将来的节点直连、批处理
	// 回填）同样不能写脏数据。闭集外的档位一旦落库就擦不掉（append-only）。
	if err := in.Validate(); err != nil {
		return ActionReview{}, false, err
	}

	inserted, err := scanActionReview(s.pool.QueryRow(ctx, `
		INSERT INTO action_reviews
		  (id, realm, session_ref, run_id, action, band, decider, reason,
		   denied_streak, denied_total)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (id) DO NOTHING
		RETURNING `+actionReviewColumns,
		in.ID, in.Realm, in.SessionRef, optionalRunID(in.RunID), in.Action,
		string(in.Band), string(in.Decider), in.Reason, in.DeniedStreak, in.DeniedTotal))
	switch {
	case err == nil:
		return inserted, true, nil
	case !errors.Is(err, errNoActionReview):
		return ActionReview{}, false, err
	}

	existing, err := scanActionReview(s.pool.QueryRow(ctx,
		`SELECT `+actionReviewColumns+` FROM action_reviews WHERE id = $1`, in.ID))
	if err != nil {
		return ActionReview{}, false, err
	}
	if !existing.matches(in) {
		return ActionReview{}, false, ErrReviewIDConflict
	}
	return existing, false, nil
}

// ActionReviews 读某 (realm, session_ref) 的放行记录，**最新在前**。
//
// # realm 是必填的过滤条件，不是可选的分组
//
// 本表是跨租户共表的，realm 是首要隔离边界（§10.2）。读面漏掉它就等于给任意 realm 的
// 调用方一个读别人动作面的入口——而动作面里有 `action`（工具名）与 `reason`（判据），
// 这两列足够拼出一个会话在做什么。因此 realm 为空时**拒绝查询**，不退化成「不过滤」。
//
// # 跨 realm 查询返回空，而不是错误
//
// 调用方可能持有一个属于别的 realm 的 sessionRef（配置错了、或上下文串了）。此时返回
// 空列表：本表不该成为「探测某个会话属于哪个 realm」的工具——报 403/404 会泄露
// 「别的 realm 里存在这个会话」，而空列表与「本 realm 里还没有记录」给出的是同一个回答。
// 这与控制台读面（internal/server 的 registered=false）同一条纪律：不伪造、也不多给。
//
// # 排序与游标
//
// 按 `created_at DESC, id DESC`（与 `action_reviews_recent` 索引同向），第二条排序键
// 是为了让同一毫秒内的并列行有确定的顺序——没有它，同一页两次读可能给出不同排列。
// **刻意不提供游标**：`id` 是 TEXT 主键（非单调），而按 `created_at` 翻页会在并列毫秒上
// 漏行或重复。这个读面的用途是「刚才分类器放行了什么」，需要全量审计时直接查库。
func (s *Store) ActionReviews(ctx context.Context, realm, sessionRef string, limit int) ([]ActionReview, error) {
	if strings.TrimSpace(realm) == "" || strings.TrimSpace(sessionRef) == "" {
		return nil, fmt.Errorf("ActionReviews 需要 realm 与 sessionRef：缺 realm 会退化成跨租户读")
	}
	if limit <= 0 {
		limit = actionReviewDefaultLimit
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+actionReviewColumns+`
		FROM action_reviews
		WHERE realm = $1 AND session_ref = $2
		ORDER BY created_at DESC, id DESC
		LIMIT $3`, realm, sessionRef, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// 空**列表**而不是 nil：跨 realm 查询的合法结果就是「没有记录」，
	// 而响应体里的 `[]` 与 `null` 对调用方是两件事（前者是「查过了，没有」）。
	out := []ActionReview{}
	for rows.Next() {
		r, err := scanActionReview(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// matches 判断「库里已有的那一行」与「这次要写的」是不是同一条记录（用于重放识别）。
//
// 比较的是**全部审计字段**：只比 id 会让「同 id 不同内容」被当成重放静默吞掉，
// 而那正是 ErrReviewIDConflict 要拦的情形。
func (r ActionReview) matches(in release.Record) bool {
	return r.Realm == in.Realm &&
		r.SessionRef == in.SessionRef &&
		sameOptionalString(r.RunID, optionalRunID(in.RunID)) &&
		r.Action == in.Action &&
		r.Band == in.Band &&
		r.Decider == in.Decider &&
		r.Reason == in.Reason &&
		r.DeniedStreak == in.DeniedStreak &&
		r.DeniedTotal == in.DeniedTotal
}

// optionalRunID 把空串归一成 NULL（§22.3 规则 2）。
//
// 不归一的话，「没有 Run」会有两种存法（NULL 与空串），而它们读起来一样、比较却不相等：
// 此后每一条按 run_id 的查询、每一次重放比对，都得同时处理这两种形态。
func optionalRunID(raw string) *string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func sameOptionalString(a, b *string) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	default:
		return *a == *b
	}
}

// scanActionReview 把一行扫成 ActionReview，并把「没有行」转成 errNoActionReview。
func scanActionReview(row pgx.Row) (ActionReview, error) {
	var (
		r             ActionReview
		runID         *string
		band, decider string
	)
	if err := row.Scan(&r.ID, &r.Realm, &r.SessionRef, &runID, &r.Action, &band, &decider,
		&r.Reason, &r.DeniedStreak, &r.DeniedTotal, &r.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ActionReview{}, errNoActionReview
		}
		return ActionReview{}, err
	}
	r.RunID = runID
	r.Band = release.Band(band)
	r.Decider = release.Decider(decider)
	return r, nil
}
