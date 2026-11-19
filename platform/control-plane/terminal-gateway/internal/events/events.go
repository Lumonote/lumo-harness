// Package events 定义终端网关的「会话事件」来源抽象。架构 §8.2 要求终端订阅
// session/event 并「连接即 replay 历史 + live push」。事件来源被抽象成 EventSource 接口，
// 生产部署读取 PostgreSQL 日志，演示与测试可使用内存实现。
//
// 关键诚实约束（§8.2「未配置真实来源时要诚实」）：EventSource 为 nil 时，上层必须返回 503
// 或明确告知「没有历史源」，**绝不伪造一个空历史**让终端误以为「这个会话本来就没有事件」。
package events

import (
	"context"
	"encoding/json"
	"errors"
	"math"
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

// Subscription 把回放的最后一个序号与随后的实时事件绑定到同一次订阅。
// Through 为 0 也可表示空历史，Live 仍可投递其第一个事件。
type Subscription struct {
	Through int64
	Live    <-chan Event
}

// EventSource 提供互不重叠的历史和实时事件。
type EventSource interface {
	// Replay 按序投递 (since, through]，emit 返回错误或 ctx 取消时停止。
	Replay(ctx context.Context, sessionRef string, since, through int64, emit func(Event) error) error
	Subscribe(ctx context.Context, sessionRef string) (Subscription, error)
}

// MemoryEventSource 是 EventSource 的内存实现，供演示与单测。它不是生产来源——
// 进程重启即丢失，且不做持久化；真实部署应替换为接线后的来源（见 package 注释）。
type MemoryEventSource struct {
	mu        sync.Mutex
	bySession map[string][]Event
	subs      map[string]map[chan Event]func() bool // channel → 停止取消回调
}

func NewMemory() *MemoryEventSource {
	return &MemoryEventSource{
		bySession: make(map[string][]Event),
		subs:      make(map[string]map[chan Event]func() bool),
	}
}

// Append 追加一个事件，自动分配 Seq（若调用方未给）。同一会话的 Seq 严格递增。
// 同时投递给该会话的订阅者。缓冲区满时结束该订阅，客户端可从最后收到的序号重连。
func (m *MemoryEventSource) Append(sessionRef string, ev Event) (Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ev.SessionRef = sessionRef
	all := m.bySession[sessionRef]
	last := lastSeq(all)
	if ev.Seq == 0 && last < math.MaxInt64 {
		ev.Seq = last + 1
	}
	if ev.Seq <= last {
		return Event{}, errors.New("追加事件的序号必须大于当前日志水位")
	}
	m.bySession[sessionRef] = append(all, ev)
	for ch, stop := range m.subs[sessionRef] {
		select {
		case ch <- ev:
		default:
			stop()
			m.removeSubscriber(sessionRef, ch)
		}
	}
	return ev, nil
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

// Replay 取得追加日志当前的切片视图。后续 Append 只写入快照长度以外，
// 因而等待终端接收时无需持锁，也无需复制整个历史。
func (m *MemoryEventSource) Replay(ctx context.Context, sessionRef string, since, through int64, emit func(Event) error) error {
	if since < 0 {
		return errors.New("replay 游标不能为负")
	}
	m.mu.Lock()
	snapshot := m.bySession[sessionRef]
	m.mu.Unlock()
	start := sort.Search(len(snapshot), func(i int) bool { return snapshot[i].Seq > since })
	for _, ev := range snapshot[start:] {
		if ev.Seq > through {
			break
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := emit(ev); err != nil {
			return err
		}
	}
	return ctx.Err()
}

func lastSeq(events []Event) int64 {
	if len(events) == 0 {
		return 0
	}
	return events[len(events)-1].Seq
}

// LatestSeq 返回该会话当前最大 Seq（无事件为 0）。
func (m *MemoryEventSource) LatestSeq(_ context.Context, sessionRef string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return lastSeq(m.bySession[sessionRef]), nil
}

// Subscribe 订阅实时事件；返回的 channel 缓冲 64，ctx 取消时关闭并解除注册。
func (m *MemoryEventSource) Subscribe(ctx context.Context, sessionRef string) (Subscription, error) {
	ch := make(chan Event, 64)
	m.mu.Lock()
	if m.subs[sessionRef] == nil {
		m.subs[sessionRef] = make(map[chan Event]func() bool)
	}
	m.subs[sessionRef][ch] = context.AfterFunc(ctx, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.removeSubscriber(sessionRef, ch)
	})
	through := lastSeq(m.bySession[sessionRef])
	m.mu.Unlock()
	return Subscription{Through: through, Live: ch}, nil
}

// 调用方持有 mu。取消与缓冲区满可能同时发生，只关闭仍已注册的 channel。
func (m *MemoryEventSource) removeSubscriber(sessionRef string, ch chan Event) {
	subs := m.subs[sessionRef]
	if _, registered := subs[ch]; registered {
		delete(subs, ch)
		close(ch)
		if len(subs) == 0 {
			delete(m.subs, sessionRef)
		}
	}
}

// Sorted 便于测试断言：返回按 Seq 升序的副本。
func Sorted(evs []Event) []Event {
	out := append([]Event(nil), evs...)
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}
