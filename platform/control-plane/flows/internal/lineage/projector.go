package lineage

import (
	"context"
	"log/slog"
	"time"
)

// ProjectorStore 投影器对存储层的最小接口（只暴露投影所需方法，便于 fake 测试）。
// 行类型 PendingEdge / Edge 由本包定义；接口定义在消费方、数据形状定义在存储层
// 的同一方向（见 schedule 包对 store.Cursors 的处理）。
type ProjectorStore interface {
	// ClaimPending 取一批待投影血缘边。并发安全靠 SQL 的 FOR UPDATE SKIP LOCKED，
	// 多副本各自跳过已被别人认领的行，互不阻塞也不重复搬运。
	ClaimPending(ctx context.Context, limit int) ([]PendingEdge, error)
	// MarkProjected 标记一批边已成功投影到图引擎（置 projected_at，释放认领）。
	MarkProjected(ctx context.Context, ids []int64) error
	// MarkFailed 记录某条边投影失败：累加 attempts、写可见原因、算好下次尝试时刻
	// （退避），并释放认领以便退避窗口后可重投。
	MarkFailed(ctx context.Context, id int64, reason string, attempts int, nextAttempt time.Time) error
}

// PendingEdge 是投影器从 outbox 取出来的待办边。
type PendingEdge struct {
	ID       int64
	Edge     Edge
	Attempts int
}

// Backoff 是失败重试的指数退避：base * 2^(n-1)，封顶 max。投影器用它对失败的边
// 「错开」重投，避免对挂掉的 Nebula 热循环（见 Projector.Run 的定时轮询 + 此处退避）。
//
// 为什么是「可见原因 + 退避」而非「立即重试」：立即重试会在 Nebula 持续不可用时把
// outbox 扫成空转，既浪费 PG 连接也无任何进展信号。退避让 next_attempt_at 推到未来，
// ClaimPending 据此跳过，轮询循环在空档期自然休眠；同时 attempts/last_error 落库，
// 巡检能直接看到「哪条边、第几次、为什么失败」。
func Backoff(attempts int) time.Duration {
	const base = 2 * time.Second
	const max = 2 * time.Minute
	if attempts <= 0 {
		return base
	}
	d := base
	for i := 1; i < attempts; i++ {
		d *= 2
		if d >= max {
			return max
		}
	}
	if d > max {
		return max
	}
	return d
}

// Projector 把 outbox 里的血缘边异步投影到图引擎（Nebula）。与流程提交解耦：提交只写
// PG outbox（同库事务），投影失败不影响发布，由本循环负责重试。
type Projector struct {
	store   ProjectorStore
	adapter GraphAdapter
	poll    time.Duration
	batch   int
	now     func() time.Time
	onError func(error)
	log     *slog.Logger
}

func NewProjector(store ProjectorStore, adapter GraphAdapter, log *slog.Logger) *Projector {
	if log == nil {
		log = slog.Default()
	}
	return &Projector{
		store:   store,
		adapter: adapter,
		poll:    2 * time.Second,
		batch:   100,
		now:     time.Now,
		log:     log,
	}
}

// SetTiming 主要供测试与本地小型部署调整节奏。
func (p *Projector) SetTiming(poll time.Duration, batch int) {
	if poll > 0 {
		p.poll = poll
	}
	if batch > 0 {
		p.batch = batch
	}
}

func (p *Projector) SetErrorHandler(h func(error)) { p.onError = h }

func (p *Projector) report(err error) {
	if err != nil && p.onError != nil {
		p.onError(err)
	}
}

// Run 立即跑一轮再按 poll 周期重复，直到 ctx 结束。轮询而非回调：空档期 goroutine 在
// ticker 上休眠，不会因「没活干」而空转（与 requirement 「不要热循环」一致）。
func (p *Projector) Run(ctx context.Context) {
	p.drain(ctx)
	ticker := time.NewTicker(p.poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.drain(ctx)
		}
	}
}

// drain 搬运一批待投影边。成功与失败分开标记：成功的立即置 projected_at，失败的走退避。
// 即使一批里部分失败，也不影响其它边的进度——投影动作幂等（upsert last-wins），重投
// 不会产生图数据错误，只会有重复写入。
func (p *Projector) drain(ctx context.Context) {
	pending, err := p.store.ClaimPending(ctx, p.batch)
	if err != nil {
		p.report(err)
		return
	}
	if len(pending) == 0 {
		return // 没活干，等下一个 tick
	}
	var done []int64
	type failed struct {
		id, attempts int64
		reason       string
		next         time.Time
	}
	var fails []failed
	for _, pe := range pending {
		if err := p.adapter.UpsertLineageEdge(ctx, pe.Edge); err != nil {
			next := p.now().Add(Backoff(pe.Attempts + 1))
			fails = append(fails, failed{id: pe.ID, attempts: int64(pe.Attempts + 1), reason: err.Error(), next: next})
			p.log.Warn("血缘边投影失败，已退避", "edge_id", pe.ID, "attempts", pe.Attempts+1, "err", err)
			continue
		}
		done = append(done, pe.ID)
	}
	if len(done) > 0 {
		if err := p.store.MarkProjected(ctx, done); err != nil {
			p.report(err)
		}
	}
	for _, f := range fails {
		if err := p.store.MarkFailed(ctx, f.id, f.reason, int(f.attempts), f.next); err != nil {
			p.report(err)
		}
	}
}
