package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PgEventSource 从复制式会话日志（`session_log`）读历史与实时事件。
//
// # 只读是对的，而且不违反单写者约束
//
// `session_log` 是**单写者 + fencing** 的：写侧必须持有 `session_writer_lease` 的令牌，
// 因为 `(session_ref, seq)` 是主键，两个写者会撞 seq 并把日志变成分叉。**读侧完全没有
// 这个约束** —— 本类型只发 SELECT，既不取租约也不写任何行，所以它可以在任何数量的终端
// 网关实例上同时跑。这条区分正是本文件存在的理由：把「日志不能由外部进程写」误读成
// 「日志不能由外部进程读」，会让人以为终端必须由承载节点自己代理。
//
// # 为什么游标取 `max(seq)` 而不是 `session_log_heads.seq`
//
// `session_log_heads` 是**已发布水位**，它可以领先于已落盘的行（写侧先 publishHead 再
// 落 append 是允许的）。终端要的是「现在能读到什么」，所以取 `session_log` 里真实的
// 最大 seq。用 heads 会让游标跳过一个还没落盘的位置，那之后补上的事件**永远不会被读到**
// —— 终端上表现为「会话里少了一段」，而且没有任何错误。
//
// # Subscribe 为什么是轮询
//
// 没有为它引入消息总线：轮询的代价是延迟（一个周期），而引入一条总线的代价是**多一个
// 必须与日志保持一致的真相源**。会话日志本来就是权威，轮询它不需要任何一致性论证。
// 实时轮询按页推进。发送受阻时只保留当前页，数据库连接已归还连接池。
type PgEventSource struct {
	pool     *pgxpool.Pool
	interval time.Duration
	log      *slog.Logger
	// maxReplay 是单次 History 的事件上限，见 maxReplayEvents。做成字段而不是直接用
	// 常量，是为了让「超限报错」这条守卫**可被测试触发**：用一个五万行以上的会话去证它，
	// 会在 CI 里变成一条又慢又没人愿意维护的用例，而没有人跑的守卫与不存在的守卫等价。
	maxReplay int
}

// maxReplayEvents 是单次 History 的硬上限。
//
// 两个更简单的选择都被否掉了：**不设上限**会让一个长会话把整个日志拉进内存（每次连接
// 都要），是一个不用登录就能触发的内存放大；**静默截断**更坏 —— 终端会把「我们只回放了
// 前 N 条」显示成「这个会话就这么多」，与 §8.2 禁止的「伪造空历史」是同一类谎。
// 所以超限时**报错并说出上限**，让它在界面上可见。
const maxReplayEvents = 50_000

// 每条连接在回放或追赶实时事件时按页释放查询结果。
const logPageSize = 256

// Options 装配 PgEventSource。
type Options struct {
	Pool *pgxpool.Pool
	// Interval 是 Subscribe 的轮询周期；<=0 时取 1s。
	Interval time.Duration
	Logger   *slog.Logger
	// MaxReplay 覆盖单次 History 的事件上限；<=0 时取 maxReplayEvents。
	// 只有测试需要改它。
	MaxReplay int
}

// NewPg 构造 PG 事件来源。pool 必须非 nil —— 没有池就没有来源，调用方应当退回到
// 「诚实返回 503」而不是拿一个空实现顶上。
func NewPg(opts Options) (*PgEventSource, error) {
	if opts.Pool == nil {
		return nil, errors.New("events: PgEventSource 需要一个非 nil 的连接池")
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = time.Second
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	maxReplay := opts.MaxReplay
	if maxReplay <= 0 {
		maxReplay = maxReplayEvents
	}
	return &PgEventSource{pool: opts.Pool, interval: interval, log: logger, maxReplay: maxReplay}, nil
}

// History 返回 Seq > since 的事件，按 seq 升序。
func (p *PgEventSource) History(ctx context.Context, sessionRef string, since int64) ([]Event, error) {
	if since < 0 {
		return nil, errors.New("replay 游标不能为负")
	}
	out, err := p.readPage(ctx, sessionRef, since, math.MaxInt64, p.maxReplay+1)
	if err != nil {
		return nil, err
	}
	// 多取一条：命中上限说明后面还有，此时报错而不是把读到的部分当成全部。
	if len(out) > p.maxReplay {
		return nil, fmt.Errorf(
			"会话 %s 在游标 %d 之后超过 %d 条事件，超出单次回放上限；这是上限而不是终点，请从更近的游标重连",
			sessionRef, since, p.maxReplay)
	}
	return out, nil
}

// Replay 的终点取自 Subscribe，回放和实时读取共用这一次查询的水位。
func (p *PgEventSource) Replay(ctx context.Context, sessionRef string, since, through int64, emit func(Event) error) error {
	if since < 0 {
		return errors.New("replay 游标不能为负")
	}
	for since < through {
		page, err := p.readPage(ctx, sessionRef, since, through, logPageSize)
		if err != nil {
			return err
		}
		if len(page) == 0 {
			return fmt.Errorf("会话日志水位 %d 在回放期间已不可读", through)
		}
		for _, ev := range page {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := emit(ev); err != nil {
				return err
			}
			since = ev.Seq
		}
	}
	return nil
}

// readPage 返回一页已提交的事件，且在向订阅者投递前归还数据库连接。
func (p *PgEventSource) readPage(ctx context.Context, sessionRef string, since, through int64, limit int) ([]Event, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT seq, event_type, payload FROM session_log
		  WHERE session_ref = $1 AND seq > $2 AND seq <= $3
		  ORDER BY seq
		  LIMIT $4`, sessionRef, since, through, limit)
	if err != nil {
		return nil, fmt.Errorf("读取会话日志失败: %w", err)
	}
	defer rows.Close()

	out := make([]Event, 0, 64)
	for rows.Next() {
		var (
			seq     int64
			evType  string
			payload string
		)
		if err := rows.Scan(&seq, &evType, &payload); err != nil {
			return nil, fmt.Errorf("解析会话日志行失败: %w", err)
		}
		out = append(out, Event{
			Seq:        seq,
			SessionRef: sessionRef,
			Type:       evType,
			// payload 列存的是**整个 SessionEvent 封套**（写侧 `payload: event`），
			// 不是它的 data 字段。终端渲染要的正是封套（含 type/seq/time/data），
			// 所以原样透传，不做二次解包再拼回去那种会丢字段的搬运。
			Payload: json.RawMessage(payload),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历会话日志失败: %w", err)
	}
	return out, nil
}

// LatestSeq 返回该会话当前可读到的最大 seq（无事件为 0）。
func (p *PgEventSource) LatestSeq(ctx context.Context, sessionRef string) (int64, error) {
	var seq int64
	if err := p.pool.QueryRow(ctx,
		`SELECT COALESCE(MAX(seq), 0) FROM session_log WHERE session_ref = $1`, sessionRef).Scan(&seq); err != nil {
		return 0, fmt.Errorf("读取会话日志水位失败: %w", err)
	}
	return seq, nil
}

// Subscribe 按游标轮询并推送增量；返回的 channel 在 ctx 取消时关闭。
func (p *PgEventSource) Subscribe(ctx context.Context, sessionRef string) (Subscription, error) {
	// 先确定已落盘的最大序号。查询之后提交的新事件都可从这个序号向后读取。
	start, err := p.LatestSeq(ctx, sessionRef)
	if err != nil {
		return Subscription{}, err
	}
	ch := make(chan Event, 64)
	go func() {
		defer close(ch)
		ticker := time.NewTicker(p.interval)
		defer ticker.Stop()
		cursor := start
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			for ctx.Err() == nil {
				batch, err := p.readPage(ctx, sessionRef, cursor, math.MaxInt64, logPageSize)
				if err != nil {
					if ctx.Err() != nil {
						return
					}
					p.log.Warn("轮询会话事件失败", "session", sessionRef, "cursor", cursor, "err", err)
					break // 从最后送达的序号开始，在下个周期重试。
				}
				for _, ev := range batch {
					select {
					case <-ctx.Done():
						return
					case ch <- ev:
						cursor = ev.Seq
					}
				}
				if len(batch) < logPageSize {
					break
				}
			}
		}
	}()
	return Subscription{Through: start, Live: ch}, nil
}
