// Package election 选主循环：acquire + 续租 + 领导权变更回调。
//
// 最终权威在库端 fencing（写路径每次校验租约行）；State 只是进程内快照，
// 供 HTTP 层做 no-leader 快速失败判定（spec §6：绝不挂起等待）。
package election

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// State 进程内领导权状态。
type State struct {
	current atomic.Pointer[domain.Lease]
}

// Current 当前租约快照；非 leader 返回 nil。
func (st *State) Current() *domain.Lease { return st.current.Load() }

// IsLeader 本进程当前是否 leader。
func (st *State) IsLeader() bool { return st.current.Load() != nil }

func (st *State) set(l *domain.Lease) { st.current.Store(l) }
func (st *State) clear()              { st.current.Store(nil) }

// Run 循环执行 acquire/续租直到 ctx 取消。
//
// onChange(true) 仅在获得（或重获）领导权时回调，续租不回调。
// 库不可用时保持现状：若本进程是 leader，写路径自会被库端 fencing 拒绝，
// 无需在选举层伪造降级。
func Run(ctx context.Context, st *State, s *store.Store, holder string, ttl time.Duration, onChange func(bool)) {
	try := func() {
		l, err := s.Acquire(ctx, holder, ttl.Milliseconds())
		if err != nil && !errors.Is(err, domain.ErrNotAcquired) {
			return
		}
		was := st.IsLeader()
		if l == nil {
			if was {
				st.clear()
				onChange(false)
			}
			return
		}
		if !was || st.Current().FencingToken != l.FencingToken {
			st.set(l)
			onChange(true)
		}
	}
	try()
	ticker := time.NewTicker(ttl / 3)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			try()
		}
	}
}
