package trigger

import (
	"context"
	"time"

	"github.com/lumo-harness/platform/flows/internal/store"
)

// Outbox 是持久事件队列的最小接口，便于 worker 在不启动 PostgreSQL 的情况下测试。
type Outbox interface {
	RequeueStaleTriggers(context.Context, int64) error
	ClaimTriggers(context.Context, string, int) ([]store.TriggerRecord, error)
	AckTrigger(context.Context, uint64) error
}

// Worker 将 PG outbox 投递到 Bus。投递失败不 ack，依靠 stale claim 回收后至少一次重试。
// 下游 handler 应以 Event.ID 做幂等键；worker 不假装提供 exactly-once。
type Worker struct {
	outbox     Outbox
	bus        *Bus
	workerID   string
	limit      int
	poll       time.Duration
	staleAfter time.Duration
	onError    func(error)
}

func NewWorker(outbox Outbox, bus *Bus, workerID string) *Worker {
	if workerID == "" {
		workerID = "flows-worker"
	}
	return &Worker{outbox: outbox, bus: bus, workerID: workerID, limit: 100, poll: time.Second, staleAfter: time.Minute}
}

// SetTiming 主要供测试和本地小型部署调整节奏。
func (w *Worker) SetTiming(poll, staleAfter time.Duration, limit int) {
	if poll > 0 {
		w.poll = poll
	}
	if staleAfter > 0 {
		w.staleAfter = staleAfter
	}
	if limit > 0 {
		w.limit = limit
	}
}

func (w *Worker) SetErrorHandler(handler func(error)) { w.onError = handler }

func (w *Worker) report(err error) {
	if err != nil && w.onError != nil {
		w.onError(err)
	}
}

func (w *Worker) cycle(ctx context.Context) {
	if err := w.outbox.RequeueStaleTriggers(ctx, w.staleAfter.Milliseconds()); err != nil {
		w.report(err)
		return
	}
	records, err := w.outbox.ClaimTriggers(ctx, w.workerID, w.limit)
	if err != nil {
		w.report(err)
		return
	}
	for _, record := range records {
		err := w.bus.Publish(ctx, Event{ID: record.ID, Realm: record.Realm, Name: record.Name, Payload: record.Payload})
		if err != nil {
			w.report(err)
			continue
		}
		w.report(w.outbox.AckTrigger(ctx, record.ID))
	}
}

func (w *Worker) Run(ctx context.Context) {
	w.cycle(ctx)
	ticker := time.NewTicker(w.poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.cycle(ctx)
		}
	}
}
