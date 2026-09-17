// Package presence 实现 §8.2 的「Terminal Gateway / Presence」：谁在某 session 上在线、
// 以什么能力在线。
//
// 核心设计：过期**只靠时间判定**——写入时带时刻、读取时算年龄。绝不依赖「连接关闭的回调
// 一定会到」。原因：进程被 kill 时，TCP 关闭/goroutine 清理都不会发生，回调更不会到；若过期
// 依赖回调，被杀的终端会永远显示为在线，presence 视图就此失真且无法自愈。靠真实时间推进，
// 即使回调永远不到，超时的条目也会被自然收敛掉（见 Snapshot 与 TestExpiry_ConvergesAfterKill）。
package presence

import (
	"sort"
	"sync"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/terminal-gateway/internal/capability"
)

// Entry 一条 presence 记录：谁（TerminalID）在某会话上、以什么能力在线。
type Entry struct {
	SessionRef string
	TerminalID string
	Kind       capability.TerminalKind
	Renderers  []capability.RendererKey
	LastSeen   time.Time
}

// Clock 用于注入可控时间，便于测试过期逻辑。默认 time.Now。
type Clock func() time.Time

// Store 基于时间的 presence 存储。线程安全。
type Store struct {
	mu    sync.Mutex
	ttl   time.Duration
	clock Clock
	// sessions[sessionRef][terminalID] = entry
	sessions map[string]map[string]Entry
}

// NewStore 创建存储。ttl<=0 回落 30s；clock==nil 回落 time.Now。
func NewStore(ttl time.Duration, clock Clock) *Store {
	if clock == nil {
		clock = time.Now
	}
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &Store{ttl: ttl, clock: clock, sessions: make(map[string]map[string]Entry)}
}

// Touch 写入/刷新一条 presence（用当前时钟）。同一 terminalID 覆盖而非新增——一个终端只应
// 在会话里占一条。注意：这里**不**注册任何「断开清理」回调，过期完全靠 TTL。
func (s *Store) Touch(e Entry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[e.SessionRef] == nil {
		s.sessions[e.SessionRef] = make(map[string]Entry)
	}
	e.LastSeen = s.clock()
	s.sessions[e.SessionRef][e.TerminalID] = e
}

// Leave 显式移除一条 presence（尽力而为：连接正常关闭时调用，仅作优化）。
// 即使永远不被调用，Snapショット 也会因 TTL 把过期条目收敛掉——这正是「不依赖回调」的体现。
func (s *Store) Leave(sessionRef, terminalID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m := s.sessions[sessionRef]; m != nil {
		delete(m, terminalID)
		if len(m) == 0 {
			delete(s.sessions, sessionRef)
		}
	}
}

// Snapshot 返回某会话当前**未过期**的 presence 列表，按 TerminalID 排序以稳定输出。
// 过期的判定只看 (now - LastSeen) <= ttl，故进程被杀而回调不到的条目会随真实时间被过滤掉。
func (s *Store) Snapshot(sessionRef string) []Entry {
	now := s.clock()
	s.mu.Lock()
	defer s.mu.Unlock()
	src := s.sessions[sessionRef]
	out := make([]Entry, 0, len(src))
	for _, e := range src {
		if now.Sub(e.LastSeen) <= s.ttl {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TerminalID < out[j].TerminalID })
	return out
}

// PublishMetrics 用**整体替换**把 presence 导出为带标签 gauge
// lumo_terminal_presence_count（标签 session_ref=会话，值为该会话当前未过期的在线人数）。
//
// 必须用 ReplaceGauges 而非增量 SetGaugeWithLabels：某会话 presence 归零时，序列必须真正
// 消失（整体替换会把该 (name,labels) 摘掉），否则告警/图表会停在旧值、永不解除——
// 这正是 observability 文档反复强调的「增量写入表达不了维度消失」。
func (s *Store) PublishMetrics() {
	counts := make(map[string]float64)
	now := s.clock()
	s.mu.Lock()
	for sess, m := range s.sessions {
		n := 0
		for _, e := range m {
			if now.Sub(e.LastSeen) <= s.ttl {
				n++
			}
		}
		if n > 0 {
			counts[sess] = float64(n)
		}
	}
	s.mu.Unlock()

	points := make([]observability.GaugePoint, 0, len(counts))
	for sess, n := range counts {
		points = append(points, observability.GaugePoint{
			Labels: map[string]string{"session_ref": sess},
			Value:  n,
		})
	}
	observability.ReplaceGauges("lumo_terminal_presence_count", points)
}
