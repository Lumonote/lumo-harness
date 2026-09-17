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
// acquireFunc 取一次锁。两种作用域共用同一个循环：「acquire + 续租 + 变更回调」这三件事
// 与锁的大小无关，拆成两个循环只会让两者的续租节奏有机会分叉——而分叉的后果是一把锁
// 比另一把早过期，症状是「偶尔有人拿不到降级决策权」，且只在压力下出现。
type acquireFunc func(ctx context.Context, holder string, ttlMs int64) (*domain.Lease, error)

func run(ctx context.Context, st *State, acquire acquireFunc, holder string, ttl time.Duration, onChange func(bool)) {
	try := func() {
		l, err := acquire(ctx, holder, ttl.Milliseconds())
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

// Run 全局租约：跨集群的唯一放置决策者。
func Run(ctx context.Context, st *State, s *store.Store, holder string, ttl time.Duration, onChange func(bool)) {
	run(ctx, st, s.Acquire, holder, ttl, onChange)
}

// RunCluster 本集群的本地租约：全局调度不可用时的本集群决策者。
//
// **只在设了集群身份时才跑。** 一个不知道自己属于哪个集群的实例无从判断「本地」是什么，
// 让它参与只会造出一把「所有没有身份的实例」共用的锁——它们会互相认为自己是同一个集群的
// 决策者，而那正是围栏要防的事。这与 store.AcquireCluster 拒绝空 cluster_id 是同一条判据的
// 两处落点：一处防误用，一处防误启动。
func RunCluster(ctx context.Context, st *State, s *store.Store, clusterID, holder string, ttl time.Duration, onChange func(bool)) {
	if clusterID == "" {
		return
	}
	run(ctx, st, func(ctx context.Context, holder string, ttlMs int64) (*domain.Lease, error) {
		return s.AcquireCluster(ctx, clusterID, holder, ttlMs)
	}, holder, ttl, onChange)
}
