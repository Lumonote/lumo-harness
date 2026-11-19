//go:build scheduler_stress

package store

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// 放置准入锁的压测台。显式启用 scheduler_stress 并提供独立测试库：
//
//	LUMO_TEST_PG_DSN=... go test -tags scheduler_stress ./internal/store -run TestAdmissionLockBench -v -count=1
//
// 量三件事，因为「放置吞吐」单看没有意义——租约行上还挂着另外两个排他写入方：
//   - 放置（PlaceTask）吞吐与延迟；
//   - 续租（Acquire，对租约行 UPDATE）在放置压力下的延迟——它超过 ttl/3 就是领导权抖动；
//   - 取队列（TakePending，对租约行 FOR UPDATE）在放置压力下的延迟。
//
// 本机回环的往返时延只有几十微秒，而锁的持有时间 ≈ 事务内语句数 × 往返时延，
// 所以用一个带固定时延的 TCP 转发器模拟真实部署里调度器到 PG 的距离。

// delayProxy 把到 target 的每个方向都推迟 oneWay：读到即打时间戳，到点才转发，
// 所以连续的包不会互相叠加时延（与真实链路一致）。
func delayProxy(t *testing.T, target string, oneWay time.Duration, clientWrites *atomic.Int64) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	type chunk struct {
		at   time.Time
		data []byte
	}
	pipe := func(dst, src net.Conn, count *atomic.Int64) {
		ch := make(chan chunk, 1024)
		go func() {
			defer close(ch)
			for {
				buf := make([]byte, 32*1024)
				n, err := src.Read(buf)
				if n > 0 {
					if count != nil {
						count.Add(1)
					}
					ch <- chunk{time.Now().Add(oneWay), buf[:n]}
				}
				if err != nil {
					return
				}
			}
		}()
		for c := range ch {
			if d := time.Until(c.at); d > 0 {
				time.Sleep(d)
			}
			if _, err := dst.Write(c.data); err != nil {
				break
			}
		}
		_ = dst.Close()
		_ = src.Close()
		for range ch {
		}
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", target)
			if err != nil {
				_ = c.Close()
				continue
			}
			for _, x := range []net.Conn{c, up} {
				if tc, ok := x.(*net.TCPConn); ok {
					_ = tc.SetNoDelay(true)
				}
			}
			go pipe(up, c, clientWrites)
			go pipe(c, up, nil)
		}
	}()
	return ln.Addr().String()
}

type latencies struct {
	mu sync.Mutex
	d  []time.Duration
}

func (l *latencies) add(d time.Duration) {
	l.mu.Lock()
	l.d = append(l.d, d)
	l.mu.Unlock()
}

func (l *latencies) pct(p float64) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.d) == 0 {
		return 0
	}
	s := append([]time.Duration(nil), l.d...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	i := int(float64(len(s)-1) * p)
	return s[i]
}

func (l *latencies) n() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.d)
}

type benchCase struct {
	rtt     time.Duration
	workers int
	nodes   int
	pool    int
}

type benchResult struct {
	placed, failed      int64
	place, renew, take  latencies
	renewFail, takeFail int64
	elapsed             time.Duration
	multixactsPerSecond float64
	// clientWrites 客户端→库的写次数（≈往返次数，含续租与取队列的少量贡献）。
	clientWrites int64
}

func benchEnvInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return def
}

func TestAdmissionLockBench(t *testing.T) {
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Fatal("压测台需 LUMO_TEST_PG_DSN 指向独立测试库")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("dsn: %v", err)
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("admin: %v", err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("scheduler_bench_%d", time.Now().UnixNano())
	ident := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+ident); err != nil {
		t.Fatalf("schema: %v", err)
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP SCHEMA "+ident+" CASCADE") }()

	seconds := time.Duration(benchEnvInt("LUMO_ADMISSION_BENCH_SECONDS", 4)) * time.Second
	var cases []benchCase
	for _, rtt := range []time.Duration{0, time.Millisecond} {
		for _, workers := range []int{1, 4, 16, 64} {
			cases = append(cases, benchCase{rtt: rtt, workers: workers, nodes: 64, pool: workers + 4})
		}
		// 生产默认：pgxpool 的 MaxConns = max(4, NumCPU)，续租与请求共用。
		cases = append(cases, benchCase{rtt: rtt, workers: 16, nodes: 64, pool: 4})
		// 全部落在同一节点：节点行锁本身就串行，这一档量的是下限。
		cases = append(cases, benchCase{rtt: rtt, workers: 16, nodes: 1, pool: 20})
	}

	t.Logf("%5s %4s %5s %4s | %8s %8s %8s %5s | %8s %8s %4s/%-4s | %8s %8s %4s/%-4s | %7s %8s",
		"rtt", "wrk", "nodes", "pool", "place/s", "p50", "p99", "fail",
		"renewP50", "renewMax", "fail", "n", "takeP50", "takeMax", "fail", "n", "mxact/s", "rt/place")
	for _, c := range cases {
		r := runAdmissionBench(t, ctx, *u, schema, c, seconds)
		t.Logf("%5s %4d %5d %4d | %8.0f %8s %8s %5d | %8s %8s %4d/%-4d | %8s %8s %4d/%-4d | %7.0f %8.1f",
			c.rtt, c.workers, c.nodes, c.pool,
			float64(r.placed)/r.elapsed.Seconds(), r.place.pct(0.5).Round(10*time.Microsecond), r.place.pct(0.99).Round(10*time.Microsecond), r.failed,
			r.renew.pct(0.5).Round(10*time.Microsecond), r.renew.pct(1).Round(10*time.Microsecond), r.renewFail, r.renew.n(),
			r.take.pct(0.5).Round(10*time.Microsecond), r.take.pct(1).Round(10*time.Microsecond), r.takeFail, r.take.n(),
			r.multixactsPerSecond, float64(r.clientWrites)/float64(max(r.placed, 1)))
	}
}

func runAdmissionBench(t *testing.T, ctx context.Context, u url.URL, schema string, c benchCase, dur time.Duration) *benchResult {
	t.Helper()
	var writes atomic.Int64
	if c.rtt > 0 {
		port := u.Port()
		if port == "" {
			port = "5432"
		}
		u.Host = delayProxy(t, net.JoinHostPort(u.Hostname(), port), c.rtt/2, &writes)
	}
	q := u.Query()
	q.Set("search_path", schema)
	q.Set("pool_max_conns", strconv.Itoa(c.pool))
	u.RawQuery = q.Encode()
	st, err := New(ctx, u.String())
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer st.Close()
	if err := st.Init(ctx); err != nil {
		t.Fatalf("init: %v", err)
	}
	if _, err := st.Pool().Exec(ctx, `TRUNCATE scheduler_tasks, scheduler_dispatch_outbox, scheduler_nodes,
		scheduler_task_attempts, scheduler_leader_lease, scheduler_queue_fairness`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if err := st.Init(ctx); err != nil {
		t.Fatalf("re-init: %v", err)
	}
	for i := 0; i < c.nodes; i++ {
		if err := st.SyncNodeSnapshot(ctx, domain.Node{NodeID: fmt.Sprintf("N%d", i), Realm: "r1", ClusterID: "c1",
			Capacity: 10_000_000, Capabilities: []string{"llm"}}); err != nil {
			t.Fatalf("node: %v", err)
		}
	}
	const ttl = 6000 // 续租周期 ttl/3 = 2s，与 election.run 的单次期限一致
	lease, err := st.Acquire(ctx, "bench", ttl)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	// 预热连接池，避免把建连时间算进第一批放置里。
	var warm sync.WaitGroup
	for i := 0; i < c.pool; i++ {
		warm.Add(1)
		go func() {
			defer warm.Done()
			_, _ = st.Pool().Exec(ctx, `SELECT pg_sleep(0.05)`)
		}()
	}
	warm.Wait()

	mxBefore := nextMultiXact(t, ctx, st)
	res := &benchResult{}
	writesBefore := writes.Load()
	runCtx, cancel := context.WithTimeout(ctx, dur)
	defer cancel()
	var wg sync.WaitGroup
	var seq atomic.Int64
	start := time.Now()
	for w := 0; w < c.workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for runCtx.Err() == nil {
				id := seq.Add(1)
				task := domain.Task{TaskID: fmt.Sprintf("b-%d", id), Realm: "r1", ClusterID: "c1",
					Requires: []domain.Requirement{{Key: "llm"}}}
				node := fmt.Sprintf("N%d", int(id)%c.nodes)
				begin := time.Now()
				_, err := st.PlaceTask(runCtx, lease, task, node)
				if err != nil {
					if runCtx.Err() == nil {
						atomic.AddInt64(&res.failed, 1)
					}
					continue
				}
				res.place.add(time.Since(begin))
				atomic.AddInt64(&res.placed, 1)
			}
		}(w)
	}
	periodic := func(every time.Duration, lat *latencies, fails *int64, fn func(context.Context) error) {
		defer wg.Done()
		tick := time.NewTicker(every)
		defer tick.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-tick.C:
				// 与 election.run 一致：单次尝试的期限是 ttl/3。
				attempt, done := context.WithTimeout(ctx, ttl/3*time.Millisecond)
				begin := time.Now()
				err := fn(attempt)
				done()
				if err != nil {
					atomic.AddInt64(fails, 1)
				}
				lat.add(time.Since(begin))
			}
		}
	}
	wg.Add(2)
	go periodic(100*time.Millisecond, &res.renew, &res.renewFail, func(c context.Context) error {
		_, err := st.Acquire(c, "bench", ttl)
		return err
	})
	go periodic(250*time.Millisecond, &res.take, &res.takeFail, func(c context.Context) error {
		_, err := st.TakePending(c, lease, 64, time.Second)
		return err
	})
	wg.Wait()
	res.elapsed = time.Since(start)
	res.clientWrites = writes.Load() - writesBefore
	res.multixactsPerSecond = float64(nextMultiXact(t, ctx, st)-mxBefore) / res.elapsed.Seconds()
	return res
}

// nextMultiXact 共享行锁在有并发持有者时要建 MultiXact；它的消耗速度是共享锁的隐性成本
// （成员 SLRU、回卷前的强制 vacuum）。读不到（权限/版本）时返回 0。
func nextMultiXact(t *testing.T, ctx context.Context, st *Store) int64 {
	t.Helper()
	// pg_control_checkpoint 给的是上一次检查点时的值，所以先打一个检查点。
	if _, err := st.Pool().Exec(ctx, `CHECKPOINT`); err != nil {
		return 0
	}
	var v int64
	if err := st.Pool().QueryRow(ctx, `SELECT next_multixact_id::text::bigint FROM pg_control_checkpoint()`).Scan(&v); err != nil {
		return 0
	}
	return v
}
