// Package schedule 是 cron 自动化的调度生产者：把 project_automations 里的
// cron 表达式变成持久的 flow trigger。
//
// # 为什么生产者放在 flows 而不是 scheduler 服务
//
// 推进游标与入队触发必须落在**同一个事务**里，否则崩溃点会落在两者之间——要么
// 漏跑一次，要么重复跑一次。而 flow_trigger_outbox 归 flows 所有，只有 flows 能在
// 自己的事务里同时做这两件事。scheduler 服务只负责 Worker 的放置与派发
// （nodes / placements / tasks / cancel / result），对自动化一无所知，把它牵进来
// 只会凭空多出一个跨服务的分布式事务。
//
// # 时区
//
// cron 表达式默认按 UTC 解释；需要本地时间就在表达式里写时区前缀，例如
// "CRON_TZ=Asia/Shanghai 0 9 * * *"。部署方可以用 LUMO_FLOW_CRON_TZ 改默认时区，
// 但改了之后已经落库的 next_fire_at 仍是按旧时区算出的瞬间，要到各自触发一次之后
// 才会按新时区重算（最多漂移一个触发周期）。要求显式写前缀就没有这个问题。
//
// # 语义边界
//
// 生产者只负责「什么时候该跑」；跑什么由 flows 既有的 outbox → Bus → binding 链路
// 决定，与 event/webhook 完全共用。因此这里不做权限判断、不解析流程定义。
package schedule

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/lumo-harness/platform/flows/internal/cron"
	"github.com/lumo-harness/platform/flows/internal/store"
)

// ErrCursorAdvanced 由 store 提供（见 store.ErrCursorAdvanced），这里转出是为了
// 让调用方不必同时 import 两个包。
var ErrCursorAdvanced = store.ErrCursorAdvanced

// Cursors 是生产者在存储层上的最小接口，便于在不启动 PostgreSQL 的情况下测试。
//
// 行类型（Cursor / CronAutomation / Fire）由 store 提供，与 trigger.Outbox 复用
// store.TriggerRecord 的方向一致：接口定义在消费方，数据形状定义在存储层。
type Cursors interface {
	// ListCronAutomations 返回「已发布流程上的启用 cron 自动化」。
	ListCronAutomations(ctx context.Context) ([]store.CronAutomation, error)
	// LoadCronCursors 返回全部现有游标。
	LoadCronCursors(ctx context.Context) ([]store.Cursor, error)
	// UpsertCronCursor 建立或重置游标。
	UpsertCronCursor(ctx context.Context, cursor store.Cursor) error
	// DeleteCronCursors 删除不再适用的游标。
	DeleteCronCursors(ctx context.Context, automationIDs []string) error
	// DueCronCursors 返回未停滞且 next_fire_at <= now 的游标。
	DueCronCursors(ctx context.Context, now time.Time, limit int) ([]store.Cursor, error)
	// FireCronCursor 在**同一个事务**里入队触发并推进游标。
	// CAS 未命中（游标已被别人推进）时返回 ErrCursorAdvanced。
	FireCronCursor(ctx context.Context, fire store.Fire) (uint64, error)
	// StallCronCursor 标记游标不可调度，并记下原因。
	StallCronCursor(ctx context.Context, automationID, reason string) error
}

// 编译期断言：store 必须满足这个接口。放在这里而不是 store 里，是因为依赖方向是
// schedule → store，反过来写就成环了。
var _ Cursors = (*store.Store)(nil)

// Payload 是 cron 触发交给流程的事件体。
type Payload struct {
	AutomationID string `json:"automation_id"`
	ProjectID    string `json:"project_id"`
	Spec         string `json:"spec"`
	// ScheduledFor 是这次触发对应的计划时刻；FiredAt 是真正提交的时刻。
	// 追赶时两者会相差一个或多个周期，流程可以据此判断自己是不是在补跑。
	ScheduledFor time.Time `json:"scheduled_for"`
	FiredAt      time.Time `json:"fired_at"`
}

// Report 是一轮调度的结果，用于日志与巡检。
type Report struct {
	// Reconciled 是新建 + 重置 + 删除的游标总数。
	Reconciled int
	// Fired 是成功入队的触发数。
	Fired int
	// Advanced 是被其他副本抢先推进、本轮跳过的游标数。
	Advanced int
	// Stalled 是判定为不可调度的游标数。
	Stalled int
}

// Producer 周期性地把到期的 cron 自动化变成持久触发。
type Producer struct {
	cursors Cursors
	limit   int
	poll    time.Duration
	// location 是表达式没有 TZ= / CRON_TZ= 前缀时的默认时区。
	location *time.Location
	now      func() time.Time
	onError  func(error)
}

// NewProducer 构造生产者。defaultLocation 为 nil 时按 UTC 解释表达式。
func NewProducer(cursors Cursors, defaultLocation *time.Location) *Producer {
	if defaultLocation == nil {
		defaultLocation = time.UTC
	}
	return &Producer{
		cursors:  cursors,
		limit:    100,
		poll:     30 * time.Second,
		location: defaultLocation,
		now:      time.Now,
	}
}

// SetTiming 主要供测试和本地小型部署调整节奏。
func (p *Producer) SetTiming(poll time.Duration, limit int) {
	if poll > 0 {
		p.poll = poll
	}
	if limit > 0 {
		p.limit = limit
	}
}

// SetClock 覆盖时钟，仅用于测试。
func (p *Producer) SetClock(now func() time.Time) {
	if now != nil {
		p.now = now
	}
}

func (p *Producer) SetErrorHandler(handler func(error)) { p.onError = handler }

// Location 返回表达式没有时区前缀时使用的默认时区。
func (p *Producer) Location() *time.Location { return p.location }

func (p *Producer) report(err error) {
	if err != nil && p.onError != nil {
		p.onError(err)
	}
}

// Run 立即跑一轮再按 poll 周期重复，直到 ctx 结束。
func (p *Producer) Run(ctx context.Context) {
	p.Cycle(ctx)
	ticker := time.NewTicker(p.poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.Cycle(ctx)
		}
	}
}

// Cycle 跑一轮：先对齐游标集合，再把到期的游标变成触发。
func (p *Producer) Cycle(ctx context.Context) Report {
	now := p.now()
	report := Report{}

	reconciled, err := p.reconcile(ctx, now)
	report.Reconciled = reconciled
	if err != nil {
		p.report(err)
		return report
	}

	due, err := p.cursors.DueCronCursors(ctx, now, p.limit)
	if err != nil {
		p.report(err)
		return report
	}

	for _, cursor := range due {
		if ctx.Err() != nil {
			return report
		}
		switch outcome := p.fire(ctx, cursor, now); outcome {
		case outcomeFired:
			report.Fired++
		case outcomeAdvanced:
			report.Advanced++
		case outcomeStalled:
			report.Stalled++
		}
	}
	return report
}

type outcome int

const (
	outcomeFired outcome = iota
	outcomeAdvanced
	outcomeStalled
)

// fire 处理单个到期游标。
func (p *Producer) fire(ctx context.Context, cursor store.Cursor, now time.Time) outcome {
	sched, err := cron.Parse(cursor.Spec, p.location)
	if err != nil {
		return p.stall(ctx, cursor, fmt.Sprintf("cron 表达式无法解析: %v", err))
	}

	// 从游标（而不是 now）出发找「最后一次漏掉的触发」。这样停机期间落后多次时
	// 只补最近一次，而不会把落后的每一次都补一遍。
	fired, due, err := sched.Due(cursor.LastFiredAt, now)
	if err != nil {
		return p.stall(ctx, cursor, fmt.Sprintf("cron 表达式永远不会触发: %v", err))
	}
	if !due {
		// 契约上不可达：DueCronCursors 只挑 next_fire_at <= now 的游标，而
		// next_fire_at 就是 Next(LastFiredAt)，所以区间内必定至少有一次。
		// 真出现了说明游标与表达式不一致（例如被旧版本代码写坏），
		// 从 now 重新起步自愈，并把它报出来。
		next, nextErr := sched.Next(now)
		if nextErr != nil {
			return p.stall(ctx, cursor, fmt.Sprintf("cron 表达式永远不会触发: %v", nextErr))
		}
		p.report(fmt.Errorf("cron 游标 %s 已到期但补不出触发时刻，已按 now 重新起步", cursor.AutomationID))
		cursor.LastFiredAt = now
		cursor.NextFireAt = next
		if err := p.cursors.UpsertCronCursor(ctx, cursor); err != nil {
			p.report(err)
		}
		return outcomeAdvanced
	}

	// 推进到 now 之后，而不是 Next(fired)：后者会让落后 5 次的高频表达式在接下来
	// 5 个周期里连续补跑。代价是只补一次、中间的漏跑被合并掉——对自动化来说，
	// 「恢复后跑一次并回到正常节奏」比「把停机期间的每一次都重放」更可预期。
	next, err := sched.Next(now)
	if err != nil {
		return p.stall(ctx, cursor, fmt.Sprintf("cron 表达式永远不会触发: %v", err))
	}

	payload, err := json.Marshal(Payload{
		AutomationID: cursor.AutomationID,
		ProjectID:    cursor.ProjectID,
		Spec:         cursor.Spec,
		ScheduledFor: fired,
		FiredAt:      now,
	})
	if err != nil {
		p.report(fmt.Errorf("序列化 cron 触发负载失败（automation_id=%s）: %w", cursor.AutomationID, err))
		return outcomeStalled
	}

	_, err = p.cursors.FireCronCursor(ctx, store.Fire{
		Cursor: cursor, Payload: payload, Fired: fired, Next: next, Now: now,
	})
	if errors.Is(err, ErrCursorAdvanced) {
		return outcomeAdvanced
	}
	if err != nil {
		p.report(err)
		return outcomeStalled
	}
	return outcomeFired
}

func (p *Producer) stall(ctx context.Context, cursor store.Cursor, reason string) outcome {
	p.report(fmt.Errorf("cron 自动化 %s 停滞: %s", cursor.AutomationID, reason))
	if err := p.cursors.StallCronCursor(ctx, cursor.AutomationID, reason); err != nil {
		p.report(err)
	}
	return outcomeStalled
}

// reconcile 让游标集合与 project_automations 对齐。
//
// 三件事：为新的 cron 自动化建游标、spec 变更时重置、删除已不适用的游标。
// 新游标与重置都把起点定在 now，所以**编辑表达式不会追溯旧表达式**——用户改了
// 时间之后不会立刻收到一次「按旧时间算的」补跑。
func (p *Producer) reconcile(ctx context.Context, now time.Time) (int, error) {
	automations, err := p.cursors.ListCronAutomations(ctx)
	if err != nil {
		return 0, err
	}
	existing, err := p.cursors.LoadCronCursors(ctx)
	if err != nil {
		return 0, err
	}
	known := make(map[string]store.Cursor, len(existing))
	for _, cursor := range existing {
		known[cursor.AutomationID] = cursor
	}

	changed := 0
	keep := make([]string, 0, len(automations))
	for _, automation := range automations {
		keep = append(keep, automation.AutomationID)
		current, ok := known[automation.AutomationID]
		if ok && current.Spec == automation.Spec {
			// 停滞的游标不在这里自动重试：spec 没变就还是同样的错，重试只是噪声。
			// 恢复路径是改 spec（走上面这条）或先禁用再启用（游标被删后重建）。
			continue
		}
		sched, err := cron.Parse(automation.Spec, p.location)
		if err != nil {
			// 表达式非法也要落一条游标，否则巡检看不到它；停滞标记让它不进调度。
			if err := p.cursors.UpsertCronCursor(ctx, store.Cursor{
				AutomationID: automation.AutomationID, Realm: automation.Realm,
				ProjectID: automation.ProjectID, Spec: automation.Spec,
				LastFiredAt: now, NextFireAt: now, LastError: fmt.Sprintf("cron 表达式无法解析: %v", err),
			}); err != nil {
				return changed, err
			}
			changed++
			continue
		}
		next, err := sched.Next(now)
		if err != nil {
			if err := p.cursors.UpsertCronCursor(ctx, store.Cursor{
				AutomationID: automation.AutomationID, Realm: automation.Realm,
				ProjectID: automation.ProjectID, Spec: automation.Spec,
				LastFiredAt: now, NextFireAt: now, LastError: fmt.Sprintf("cron 表达式永远不会触发: %v", err),
			}); err != nil {
				return changed, err
			}
			changed++
			continue
		}
		if err := p.cursors.UpsertCronCursor(ctx, store.Cursor{
			AutomationID: automation.AutomationID, Realm: automation.Realm,
			ProjectID: automation.ProjectID, Spec: automation.Spec,
			LastFiredAt: now, NextFireAt: next,
		}); err != nil {
			return changed, err
		}
		changed++
	}

	stale := make([]string, 0, len(existing))
	wanted := make(map[string]struct{}, len(keep))
	for _, id := range keep {
		wanted[id] = struct{}{}
	}
	for _, cursor := range existing {
		if _, ok := wanted[cursor.AutomationID]; !ok {
			stale = append(stale, cursor.AutomationID)
		}
	}
	if len(stale) > 0 {
		if err := p.cursors.DeleteCronCursors(ctx, stale); err != nil {
			return changed, err
		}
		changed += len(stale)
	}
	return changed, nil
}
