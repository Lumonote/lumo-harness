// Package breaker 自研滑动窗口熔断器（§12.2 明确许可「sentinel-go 或自研滑动窗口」）。
//
// 熔断器是**本实例本地**的：它保护的是本网关的 goroutine/连接不被一个挂掉的上游拖死，
// 这是本地资源问题，不需要跨实例共识。跨实例的配额才走 Redis（见 ratelimit）。
package breaker

import (
	"sync"
	"time"
)

// State 熔断状态。
type State int

const (
	// StateClosed 正常放行。
	StateClosed State = iota
	// StateOpen 快速失败，不打上游。
	StateOpen
	// StateHalfOpen 试探性放行有限请求，成功则闭合，失败立刻重新打开。
	StateHalfOpen
)

func (s State) String() string {
	switch s {
	case StateOpen:
		return "open"
	case StateHalfOpen:
		return "half-open"
	default:
		return "closed"
	}
}

// Config 熔断参数。
type Config struct {
	// Window 滑动窗口长度。
	Window time.Duration
	// MinRequests 窗口内低于此请求数不做判定（防止 1 次失败就熔断）。
	MinRequests int
	// FailureRatio 失败率阈值（0–1）。
	FailureRatio float64
	// OpenFor 打开后多久转入半开试探。
	OpenFor time.Duration
	// HalfOpenProbes 半开期允许的试探请求数。
	HalfOpenProbes int
	// Now 注入时钟，便于测试；nil 时用 time.Now。
	Now func() time.Time
}

func DefaultConfig() Config {
	return Config{
		Window:         30 * time.Second,
		MinRequests:    20,
		FailureRatio:   0.5,
		OpenFor:        15 * time.Second,
		HalfOpenProbes: 3,
	}
}

type bucket struct {
	at            time.Time
	total, failed int
}

// Breaker 单个 key（连接器）的熔断器。
type Breaker struct {
	cfg Config

	mu       sync.Mutex
	buckets  []bucket // 每秒一格的环形窗口
	state    State
	openedAt time.Time
	probes   int
}

func newBreaker(cfg Config) *Breaker {
	secs := int(cfg.Window / time.Second)
	if secs < 1 {
		secs = 1
	}
	return &Breaker{cfg: cfg, buckets: make([]bucket, secs)}
}

func (b *Breaker) now() time.Time {
	if b.cfg.Now != nil {
		return b.cfg.Now()
	}
	return time.Now()
}

// Allow 询问是否放行。返回的 done 必须被调用（成功传 true），否则半开配额会泄漏。
func (b *Breaker) Allow() (allowed bool, done func(success bool), state State) {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := b.now()
	if b.state == StateOpen && now.Sub(b.openedAt) >= b.cfg.OpenFor {
		b.state = StateHalfOpen
		b.probes = 0
	}

	switch b.state {
	case StateOpen:
		return false, func(bool) {}, StateOpen

	case StateHalfOpen:
		if b.probes >= b.cfg.HalfOpenProbes {
			return false, func(bool) {}, StateHalfOpen
		}
		b.probes++
		return true, b.finishHalfOpen, StateHalfOpen

	default:
		return true, b.finishClosed, StateClosed
	}
}

func (b *Breaker) finishHalfOpen(success bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !success {
		// 半开期一次失败即重新打开：上游还没好，别再拿真实流量去试
		b.state = StateOpen
		b.openedAt = b.now()
		b.probes = 0
		return
	}
	if b.probes >= b.cfg.HalfOpenProbes {
		b.state = StateClosed
		b.reset()
	}
}

func (b *Breaker) finishClosed(success bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.record(success)

	total, failed := b.tally()
	if total >= b.cfg.MinRequests && float64(failed)/float64(total) >= b.cfg.FailureRatio {
		b.state = StateOpen
		b.openedAt = b.now()
		b.probes = 0
	}
}

// record 记一次结果到当前秒格；格子过期则复位（这就是「滑动」）。
func (b *Breaker) record(success bool) {
	now := b.now()
	idx := int(now.Unix()) % len(b.buckets)
	slot := &b.buckets[idx]
	if now.Sub(slot.at) >= time.Duration(len(b.buckets))*time.Second {
		*slot = bucket{at: now}
	}
	slot.at = now
	slot.total++
	if !success {
		slot.failed++
	}
}

func (b *Breaker) tally() (total, failed int) {
	cutoff := b.now().Add(-b.cfg.Window)
	for _, s := range b.buckets {
		if s.at.After(cutoff) {
			total += s.total
			failed += s.failed
		}
	}
	return
}

func (b *Breaker) reset() {
	for i := range b.buckets {
		b.buckets[i] = bucket{}
	}
	b.probes = 0
}

// State 当前状态（供 /healthz 与审计读取）。
func (b *Breaker) State() State {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == StateOpen && b.now().Sub(b.openedAt) >= b.cfg.OpenFor {
		return StateHalfOpen
	}
	return b.state
}

// Group 按 key 管理多个熔断器。
type Group struct {
	cfg Config

	mu sync.RWMutex
	bs map[string]*Breaker
}

func NewGroup(cfg Config) *Group {
	return &Group{cfg: cfg, bs: map[string]*Breaker{}}
}

func (g *Group) Get(key string) *Breaker {
	g.mu.RLock()
	b, ok := g.bs[key]
	g.mu.RUnlock()
	if ok {
		return b
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if b, ok = g.bs[key]; ok {
		return b
	}
	b = newBreaker(g.cfg)
	g.bs[key] = b
	return b
}

// Snapshot 各 key 的当前状态，供健康检查暴露。
func (g *Group) Snapshot() map[string]string {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make(map[string]string, len(g.bs))
	for k, b := range g.bs {
		out[k] = b.State().String()
	}
	return out
}
