// Package trigger provides the in-process event half of FlowEngine triggers.
// Durable callers should persist an outbox event before publishing it here.
package trigger

import (
	"context"
	"sync"
)

type Event struct {
	ID                 uint64 `json:"id,omitempty"`
	Realm              string `json:"realm"`
	Name               string `json:"name"`
	Payload            any    `json:"payload"`
	ReplayAutomationID string `json:"replay_automation_id,omitempty"`
	ReplayFlowID       string `json:"replay_flow_id,omitempty"`
	ReplayFlowVersion  int    `json:"replay_flow_version,omitempty"`
	ReplayOfRunID      int64  `json:"replay_of_run_id,omitempty"`
}

func (e Event) IsReplay() bool { return e.ReplayOfRunID > 0 }

type Handler func(context.Context, Event) error

type Bus struct {
	mu       sync.RWMutex
	next     uint64
	handlers map[string]map[uint64]Handler
}

func New() *Bus { return &Bus{handlers: map[string]map[uint64]Handler{}} }

func (b *Bus) Subscribe(name string, handler Handler) func() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.next++
	if b.handlers[name] == nil {
		b.handlers[name] = map[uint64]Handler{}
	}
	id := b.next
	b.handlers[name][id] = handler
	return func() { b.mu.Lock(); defer b.mu.Unlock(); delete(b.handlers[name], id) }
}

func (b *Bus) Publish(ctx context.Context, event Event) error {
	b.mu.RLock()
	list := make([]Handler, 0, len(b.handlers[event.Name])+len(b.handlers["*"]))
	for _, handlers := range []map[uint64]Handler{b.handlers[event.Name], b.handlers["*"]} {
		for _, h := range handlers {
			list = append(list, h)
		}
	}
	b.mu.RUnlock()
	for _, handler := range list {
		if err := handler(ctx, event); err != nil {
			return err
		}
	}
	return nil
}
