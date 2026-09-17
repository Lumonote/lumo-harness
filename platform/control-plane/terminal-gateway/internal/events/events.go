// Package events 定义终端网关的「会话事件」来源抽象。架构 §8.2 要求终端订阅
// session/event 并「连接即 replay 历史 + live push」。事件来源被抽象成 EventSource 接口，
// 本进程只提供一个**内存**实现用于演示与测试；真实来源（PG / 消息总线）由部署接线注入。
//
// 关键诚实约束（§8.2「未配置真实来源时要诚实」）：EventSource 为 nil 时，上层必须返回 503
// 或明确告知「没有历史源」，**绝不伪造一个空历史**让终端误以为「这个会话本来就没有事件」。
package events

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"
)

// Event 是 session/event 总线上的一个点。Seq 是会话内单调递增序号，作为 replay 游标。
type Event struct {
	Seq        int64           `json:"seq"`
	SessionRef string          `json:"session_ref"`
	Type       string          `json:"type"`
	NodeKind   string          `json:"node_kind,omitempty"` // 用于能力协商选 renderer
	Payload    json.RawMessage `json:"payload"`
}

// EventSource 历史事件与实时推送的来源。实现可以是内存、PG、或消息总线。
type EventSource interface {
	// History 返回 sessionRef 中 Seq > since 的全部事件，按 Seq 升序。since<0 视为非法。
	History(ctx context.Context, sessionRef string, since int64) ([]Event, error)
	// LatestSeq 返回该会话当前最大 Seq（无事件时为 0）。用于游标边界断言。
	LatestSeq(ctx context.Context, sessionRef string) (int64, error)
	// Subscribe 订阅实时事件。返回的 channel 在 ctx 取消时关闭。
	Subscribe(ctx context.Context, sessionRef string) (<-chan Event, error)
}

// MemoryEventSource 是 EventSource 的内存实现，供演示与单测。它不是生产来源——
// 进程重启即丢失，且不做持久化；真实部署应替换为接线后的来源（见 package 注释）。
type MemoryEventSource struct {
	mu        sync.Mutex
	bySession map[string][]Event
	subs      map[string][]chan Event
	subscribe int // 防竞态计数，仅用于确保测试可观察
}

func NewMemory() *MemoryEventSource {
	return &MemoryEventSource{
		bySession: make(map[string][]Event),
		subs:      make(map[string][]chan Event),
	}
}

// Append 追加一个事件，自动分配 Seq（若调用方未给）。同一会话的 Seq 严格递增。
// 同时把事件 fan-out 给该会话的实时订阅者（慢订阅者丢弃，不阻塞历史追加）。
func (m *MemoryEventSource) Append(sessionRef string, ev Event) Event {
	m.mu.Lock()
	defer m.mu.Unlock()
	ev.SessionRef = sessionRef
	if ev.Seq == 0 {
		ev.Seq = int64(len(m.bySession[sessionRef]) + 1)
	}
	m.bySession[sessionRef] = append(m.bySession[sessionRef], ev)
	for _, ch := range m.subs[sessionRef] {
		select {
		case ch <- ev:
		default: // 慢订阅者：丢弃这一条，避免阻塞 Append 与别的订阅者
		}
	}
	return ev
}

// History 返回 Seq > since 的事件（升序）。since<0 → 错误（游标非法）。
//
// 游标边界语义（要求逐条断言）：
//   - since == 0      → 返回**全部**历史；
//   - since == latest → 返回空（恰好追上最新，转 live）；
//   - since >  latest → 返回空（游标已越过最新，不报错、不 panic，直接转 live）；
//   - since <  0      → 错误（上游不应传负值游标）。
func (m *MemoryEventSource) History(_ context.Context, sessionRef string, since int64) ([]Event, error) {
	if since < 0 {
		return nil, errors.New("replay 游标不能为负")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	all := m.bySession[sessionRef]
	out := make([]Event, 0, len(all))
	for _, e := range all {
		if e.Seq > since {
			out = append(out, e)
		}
	}
	return out, nil
}

// LatestSeq 返回该会话当前最大 Seq（无事件为 0）。
func (m *MemoryEventSource) LatestSeq(_ context.Context, sessionRef string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	all := m.bySession[sessionRef]
	if len(all) == 0 {
		return 0, nil
	}
	return all[len(all)-1].Seq, nil
}

// Subscribe 订阅实时事件；返回的 channel 缓冲 64，ctx 取消时关闭并解除注册。
func (m *MemoryEventSource) Subscribe(ctx context.Context, sessionRef string) (<-chan Event, error) {
	ch := make(chan Event, 64)
	m.mu.Lock()
	m.subs[sessionRef] = append(m.subs[sessionRef], ch)
	m.mu.Unlock()
	go func() {
		<-ctx.Done()
		m.mu.Lock()
		subs := m.subs[sessionRef]
		for i, c := range subs {
			if c == ch {
				// 用切片收缩避免重复关闭；保留其余订阅者
				m.subs[sessionRef] = append(subs[:i], subs[i+1:]...)
				break
			}
		}
		m.mu.Unlock()
		close(ch)
	}()
	return ch, nil
}

// Sorted 便于测试断言：返回按 Seq 升序的副本。
func Sorted(evs []Event) []Event {
	out := append([]Event(nil), evs...)
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}
