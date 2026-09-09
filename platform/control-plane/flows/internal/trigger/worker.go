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
	AckTrigger(context.Context, uint64, int64) error
	RenewTrigger(context.Context, uint64, int64) error
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
	return &Worker{outbox: outbox, bus: bus, workerID: workerID, limit: 1, poll: time.Second, staleAfter: store.RunExpiry}
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
	for i := 0; i < w.limit && ctx.Err() == nil; i++ {
		// Claim only the event about to execute. A serial batch must not hold
		// unrenewed leases for other events while its first handler is running.
		records, err := w.outbox.ClaimTriggers(ctx, w.workerID, 1)
		if err != nil {
			w.report(err)
			return
		}
		if len(records) == 0 {
			return
		}
		w.report(w.deliver(ctx, records[0]))
	}
}

func (w *Worker) deliver(ctx context.Context, record store.TriggerRecord) error {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop, done := make(chan struct{}), make(chan error, 1)
	interval := w.staleAfter / 3
	if interval > 15*time.Second {
		interval = 15 * time.Second
	}
	if interval <= 0 {
		interval = time.Millisecond
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				done <- nil
				return
			case <-runCtx.Done():
				done <- runCtx.Err()
				return
			case <-ticker.C:
				renewCtx, renewCancel := context.WithTimeout(runCtx, interval)
				err := w.outbox.RenewTrigger(renewCtx, record.ID, record.ClaimToken)
				renewCancel()
				if err != nil {
					cancel()
					done <- err
					return
				}
			}
		}
	}()
	err := w.bus.Publish(runCtx, Event{
		ID: record.ID, Realm: record.Realm, Name: record.Name, Payload: record.Payload,
		ReplayAutomationID: record.ReplayAutomationID, ReplayFlowID: record.ReplayFlowID,
		ReplayFlowVersion: record.ReplayFlowVersion, ReplayOfRunID: record.ReplayOfRunID,
	})
	close(stop)
	if renewErr := <-done; renewErr != nil {
		return renewErr
	}
	if err != nil {
		return err
	}
	return w.outbox.AckTrigger(ctx, record.ID, record.ClaimToken)
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
