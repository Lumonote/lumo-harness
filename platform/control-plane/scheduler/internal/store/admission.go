package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// 准入锁：谁能在「当前任期」内写，以及任期之间如何交接。
//
// 这把锁原先是租约行上的 FOR UPDATE，所有放置因此全局串行——跨集群、跨 realm、
// 落在不同节点上的放置也排成一队，吞吐 = 1 / 单个事务时长（往返 1ms 时约 60 条/秒，
// 与并发数无关）。现在是一把事务级咨询锁，分两档：
//
//   - **共享**：全局 leader 的 PlaceTask。放置之间真正需要互斥的东西各有各的锁——
//     容量在节点行上，attempt 单飞在任务锁（placementAdmissionSQL）与任务行上——
//     不需要全局串行。
//   - **排他**：其余 fenced 路径（取队列、排队、对账、清理）、CancelUnseen、
//     集群本地租约的降级放置（理由见 checkPlacementFencing），以及**任期变更**
//     （易主、过期租约重新生效）。
//
// 围栏的论证只有一句：**「此刻谁有权决策」的每一次变更都发生在排他锁内**，所以它
// 必须等所有在途的 fenced 事务落定，旧任期的写入不会出现在新任期开始之后。
// 反过来，不改变这件事的操作不需要这把锁：
//
//   - 续一把**仍然有效**的租约（同一持有者、同一 token，只是推后到期时刻）；
//   - 租约失效（到期、Release）——在途事务可能在失效后提交，但在任何人重新获得
//     决策权之前，这仍然是「上一个任期的最后几笔」。
//
// 这条论证有一个盖不住的交接点：全局租约一到期，早已握着集群租约的实例就获得了
// 降级决策权，中间没有任何人取排他锁。所以降级放置自己取排他档（checkPlacementFencing）。
//
// 为什么不是把行锁降成 FOR SHARE（最初设想的方向）：PostgreSQL 的共享行锁不排在
// 等待的排他方后面，只要共享持有者持续有重叠，排他方（续租的 UPDATE、取队列）就
// 永远等不到。压测里 16 并发放置就能让续租 2s 超时——放置越忙 leader 越续不上租。
// 咨询锁走重量级锁管理器，等待队列是公平的：排他方一旦开始等，后来的共享请求排在
// 它后面。续租则根本不经过这把锁。数据见 admission_bench_test.go。
//
// 锁键取租约表自身的 OID：它随 search_path 解析到实际那张表，所以同库不同 schema
// 的两套调度器（验收测试与在线拓扑共用一个库）互不干扰，而 search_path 写法不同
// 但落到同一张表的两个副本仍然互斥。
type admissionMode int

const (
	admissionExclusive admissionMode = iota
	admissionShared
)

// legacyRowLock 排他方在咨询锁之外**仍然**锁租约行。
//
// 只为滚动升级：旧版本只认行锁（放置与 CancelUnseen 取 FOR UPDATE，易主是一条不取
// 咨询锁的 UPDATE）。保留它，新版本的排他路径与旧版本的全部路径之间仍然互斥。
// 共享路径不能保留——任何能挡住旧版易主 UPDATE 的行锁档位也会挡住续租的 UPDATE，
// 那正是要去掉的东西。所以新旧混跑期间有一个已知窗口（见 deploy/README
// 「调度器放置并发与升级」）。
// 全部副本升级后这把行锁不再有作用，可以删。
func (m admissionMode) legacyRowLock() string {
	if m == admissionShared {
		return ""
	}
	return "FOR UPDATE"
}

const admissionKey = `'scheduler_leader_lease'::regclass::oid::bigint`

const exclusiveAdmissionSQL = `SELECT pg_advisory_xact_lock(` + admissionKey + `)`

// lockAdmission 取排他准入锁。
func lockAdmission(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, exclusiveAdmissionSQL); err != nil {
		return fmt.Errorf("scheduler: 取准入锁失败: %w", err)
	}
	return nil
}

// placementAdmissionSQL 取共享准入锁，再取该任务（$1）的单飞锁。
//
// 共享档只和任务锁捆在一起提供：放置之间不再全局串行之后，「同一个 task_id 只派发
// 一次」得另有着落。任务行存在时行锁就够；**新任务没有行可锁**——两个并发请求
// （客户端超时重试）都读到「不存在」，各自选了节点，后提交的那个经 ON CONFLICT
// 把先提交的放置改写掉，而两条派发都已写进 outbox。
//
// 两把锁一条语句，但**次序是语义的一部分**：必须先准入锁、后任务锁。反过来的话，
// 持有任务锁的事务排在一个等待中的排他方后面，而那个排他方在等的在途放置又在等
// 这把任务锁——死锁。外层的任务锁按 admission 的行求值，所以它一定在内层之后
// （MATERIALIZED 且函数为 VOLATILE，规划器不会改写这个次序）。
//
// 任务锁用双 int4 键，与准入锁的 bigint 键不在同一个键空间。hashtext 撞键只会让
// 两个无关任务的放置短暂串行。
const placementAdmissionSQL = `WITH admission AS MATERIALIZED (SELECT pg_advisory_xact_lock_shared(` + admissionKey + `))
	SELECT pg_advisory_xact_lock(hashtext('scheduler_tasks'::regclass::oid::text), hashtext($1)) FROM admission`

// admitAndReadGlobalLease 取准入锁并读全局租约，一次往返。
//
// 两条语句经管线一起发出，服务端仍然**逐条**执行：第二条在第一条返回（拿到锁）
// 之后才开始，READ COMMITTED 下它取的是那一刻的新快照，所以等锁期间发生的任期变更
// 在这次读里可见。**不能**把两者写进同一条语句——那样读用的是等锁之前的快照，
// 等到的恰恰是它看不见的那次变更（TestFencingReadsLeaseAfterAdmissionLockIsGranted）。
// 合成一次往返是因为 drain 循环顺序放置，每多一次往返都直接折进它的吞吐。
func admitAndReadGlobalLease(ctx context.Context, tx pgx.Tx, mode admissionMode, taskID string) (holder string, token int64, live bool, err error) {
	batch := &pgx.Batch{}
	if mode == admissionShared {
		batch.Queue(placementAdmissionSQL, taskID)
	} else {
		batch.Queue(exclusiveAdmissionSQL)
	}
	batch.Queue(`SELECT holder,fencing_token,expires_at > ` + nowMS + `
		FROM scheduler_leader_lease WHERE id=1 ` + mode.legacyRowLock())
	results := tx.SendBatch(ctx, batch)
	if _, err = results.Exec(); err != nil {
		_ = results.Close()
		return "", 0, false, fmt.Errorf("scheduler: 取准入锁失败: %w", err)
	}
	err = results.QueryRow().Scan(&holder, &token, &live)
	if closeErr := results.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", 0, false, fmt.Errorf("scheduler: 读全局租约失败: %w", err)
	}
	return holder, token, live, nil
}

// leaseStatements 一把租约的三条语句。全局租约与集群租约只是键和表不同，
// 续租/探测/接管的次序必须一致——分成两份实现，迟早有一份漏掉「重新生效要取排他锁」。
type leaseStatements struct {
	// renew 续一把仍然有效的租约；没有命中行 = 本持有者此刻没有有效租约。
	renew     string
	renewArgs []any
	// heldByOther 他人持有且未过期。
	heldByOther     string
	heldByOtherArgs []any
	// take 建租 / 取回自己已过期的租约 / 接管他人已过期的租约。
	take     string
	takeArgs []any
}

func (s *Store) acquireLease(ctx context.Context, q leaseStatements) (*domain.Lease, error) {
	var l domain.Lease
	err := s.pool.QueryRow(ctx, q.renew, q.renewArgs...).Scan(&l.Holder, &l.FencingToken, &l.ExpiresAt)
	if err == nil {
		return &l, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	// follower 每个选举周期都会走到这里。先不取锁看一眼：他人的租约还有效就直接返回。
	// 否则它每个周期都要去排一次排他锁，而排他方在等的时候后来的放置全都排在它后面——
	// 等于 follower 每隔 ttl/3 让 leader 的放置停顿一次。这一眼只用来决定「要不要去排队」，
	// 结论在锁内由 take 语句自己的 WHERE 重新判定。
	var held bool
	if err := s.pool.QueryRow(ctx, q.heldByOther, q.heldByOtherArgs...).Scan(&held); err != nil {
		return nil, err
	}
	if held {
		return nil, domain.ErrNotAcquired
	}
	tx, err := s.beginWork(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockAdmission(ctx, tx); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, q.take, q.takeArgs...).Scan(&l.Holder, &l.FencingToken, &l.ExpiresAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotAcquired
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &l, nil
}
