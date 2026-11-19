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
	// 每个终端只由最近一次注册的连接更新。
	sessions map[string]map[string]*Registration
}

// NewStore 创建存储。ttl<=0 回落 30s；clock==nil 回落 time.Now。
func NewStore(ttl time.Duration, clock Clock) *Store {
	if clock == nil {
		clock = time.Now
	}
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &Store{ttl: ttl, clock: clock, sessions: make(map[string]map[string]*Registration)}
}

// Registration 绑定一次连接。旧连接晚到的心跳和退出只对自己的注册生效。
type Registration struct {
	store *Store
	entry Entry
}

// Register 在握手时登记能力，返回本连接专用的续期和退出句柄。
func (s *Store) Register(e Entry) *Registration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[e.SessionRef] == nil {
		s.sessions[e.SessionRef] = make(map[string]*Registration)
	}
	e.LastSeen = s.clock()
	r := &Registration{store: s, entry: e}
	s.sessions[e.SessionRef][e.TerminalID] = r
	return r
}

// HeartbeatInterval 是发给客户端的建议心跳间隔。
func (s *Store) HeartbeatInterval() time.Duration { return s.ttl / 3 }

// Refresh 返回 false 表示另一条连接已取代当前连接。
func (r *Registration) Refresh() bool {
	s := r.store
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[r.entry.SessionRef][r.entry.TerminalID] != r {
		return false
	}
	r.entry.LastSeen = s.clock()
	return true
}

func (r *Registration) Leave() {
	s := r.store
	s.mu.Lock()
	defer s.mu.Unlock()
	ref, id := r.entry.SessionRef, r.entry.TerminalID
	if m := s.sessions[ref]; m[id] == r {
		delete(m, id)
		if len(m) == 0 {
			delete(s.sessions, ref)
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
	for _, r := range src {
		e := r.entry
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
		for _, r := range m {
			if now.Sub(r.entry.LastSeen) <= s.ttl {
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
