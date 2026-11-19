//go:build scheduler_stress && !windows

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// 多进程换主浸泡：三个**真实的调度器进程**共用一个库，并发放置的同时反复强杀 / 冻结
// leader。默认不跑（`-tags scheduler_stress` 才跑）——它依赖墙钟与信号，放进常跑套件
// 只会在慢机器上制造偶发红。
//
// 进程内的并发语义测试（admission_lock_test.go）逐条钉住了锁的次序，但它们共用一个
// 进程、一份选举状态的实现细节。这里补的是那些测试给不出的东西：独立进程、独立连接池、
// 经 HTTP 转发、kill -9 时事务被服务端回滚、SIGSTOP 之后旧 leader 带着过期的内存租约
// 醒来继续处理请求。断言全部落在库里的最终状态上：
//
//  1. 同一个 task_id 只派发一次（outbox 一行、attempt 恒为 1）；
//  2. 节点活跃数不超过容量；
//  3. 旧任期的放置不在新任期开始之后**提交**（库开了 track_commit_timestamp 时按提交
//     时刻核对；没开则退化成按语句时刻，只能抓住冻结点落在围栏校验与写 attempt 之间
//     的那一小部分，日志里会说明是哪一档）；
//  4. 调用方拿到过 201 的放置都在库里，且同一任务的所有 201 指向同一个节点。
const (
	soakTTL      = 1500 * time.Millisecond
	soakToken    = "soak-token"
	soakRealm    = "r1"
	soakCluster  = "c1"
	soakNodes    = 16
	soakCapacity = 300
	soakWorkers  = 16
	// 调度器 ↔ PG 的单程时延。回环上一笔放置只有一两毫秒，冻结 leader 的那一刻几乎
	// 没有在途事务，围栏根本没被考到；加上时延后冻结瞬间连接池基本是满的。
	soakPGDelay = time.Millisecond
	// 冻结 leader 多久：必须明显长于 TTL，旧 leader 醒来时租约早已过期。
	soakFreeze = 4 * soakTTL
)

// soakDelayProxy 在 target 前面起一个带固定单程时延的 TCP 转发器，返回监听地址。
func soakDelayProxy(t *testing.T, target string, oneWay time.Duration) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	type chunk struct {
		at   time.Time
		data []byte
	}
	pipe := func(dst, src net.Conn) {
		ch := make(chan chunk, 1024)
		go func() {
			defer close(ch)
			for {
				buf := make([]byte, 32*1024)
				n, err := src.Read(buf)
				if n > 0 {
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
		// 一端断开（进程被强杀）必须传到另一端：否则 PG 那头的事务一直挂着不回滚。
		_ = dst.Close()
		_ = src.Close()
		for range ch {
		}
	}
	go func() {
		for {
			client, err := ln.Accept()
			if err != nil {
				return
			}
			server, err := net.Dial("tcp", target)
			if err != nil {
				_ = client.Close()
				continue
			}
			go pipe(server, client)
			go pipe(client, server)
		}
	}()
	return ln.Addr().String()
}

type soakProc struct {
	slot     int
	port     int
	instance string
	cmd      *exec.Cmd
	log      *os.File
}

type soakCluster3 struct {
	t    *testing.T
	bin  string
	dir  string
	dsn  string
	mu   sync.Mutex
	gen  int
	proc [3]*soakProc
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("取空闲端口失败: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// start 在 slot 上拉起一个新进程。实例名每次都换：租约 holder 重启后不得与旧进程重复。
func (c *soakCluster3) start(slot, port int) {
	c.t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	instance := fmt.Sprintf("soak-%d-g%d", slot, c.gen)
	logFile, err := os.Create(filepath.Join(c.dir, instance+".log"))
	if err != nil {
		c.t.Fatalf("建日志文件失败: %v", err)
	}
	cmd := exec.Command(c.bin)
	// 环境从零拼：继承来的 LUMO_NACOS_ADDR 之类会把进程带到另一套目录上。
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"),
		"LUMO_PG_DSN=" + c.dsn,
		fmt.Sprintf("LUMO_LISTEN=127.0.0.1:%d", port),
		fmt.Sprintf("LUMO_ADVERTISE_URL=http://127.0.0.1:%d", port),
		"LUMO_INSTANCE=" + instance,
		fmt.Sprintf("LUMO_TTL_MS=%d", soakTTL.Milliseconds()),
		"LUMO_DRAIN_MS=200",
		"LUMO_CONTROL_PLANE_TOKEN=" + soakToken,
		// 节点不会回报、任务不会完成：收割与漂移只会往断言里掺别的写入方。
		"LUMO_MAX_STALL_MS=-1", "LUMO_MIGRATE_MS=-1",
	}
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		c.t.Fatalf("启动调度器进程失败: %v", err)
	}
	c.proc[slot] = &soakProc{slot: slot, port: port, instance: instance, cmd: cmd, log: logFile}
}

func (c *soakCluster3) byInstance(instance string) *soakProc {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range c.proc {
		if p != nil && p.instance == instance {
			return p
		}
	}
	return nil
}

func (c *soakCluster3) ports() []int {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]int, 0, len(c.proc))
	for _, p := range c.proc {
		out = append(out, p.port)
	}
	return out
}

func (c *soakCluster3) stopAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range c.proc {
		if p == nil {
			continue
		}
		// 冻结中的进程收不到 KILL 之外的任何东西；先解冻再杀，两条都发不会出错。
		_ = p.cmd.Process.Signal(syscall.SIGCONT)
		_ = p.cmd.Process.Kill()
		_, _ = p.cmd.Process.Wait()
		_ = p.log.Close()
	}
}

func soakPost(client *http.Client, port int, path, body string) (int, []byte, error) {
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), bytes.NewReader([]byte(body)))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("X-Lumo-Realm", soakRealm)
	req.Header.Set("Authorization", "Bearer "+soakToken)
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b, nil
}

// termStart 一个任期第一次被看到时的起点（库端时钟，毫秒）。
type termStart struct {
	token  int64
	holder string
	at     int64
}

func TestMultiProcessFailoverSoak(t *testing.T) {
	if os.Getenv("LUMO_TEST_PG_DSN") == "" {
		t.Fatal("多进程换主浸泡需 LUMO_TEST_PG_DSN 指向独立测试库")
	}
	duration := 30 * time.Second
	if v := os.Getenv("LUMO_MULTIPROC_SOAK_SECONDS"); v != "" {
		var secs int
		if _, err := fmt.Sscanf(v, "%d", &secs); err != nil || secs < 5 {
			t.Fatalf("LUMO_MULTIPROC_SOAK_SECONDS 非法: %q", v)
		}
		duration = time.Duration(secs) * time.Second
	}
	st := newStore(t)
	ctx := context.Background()

	dir, err := os.MkdirTemp("", "lumo-scheduler-soak-")
	if err != nil {
		t.Fatalf("建临时目录失败: %v", err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("进程日志保留在 %s", dir)
			return
		}
		_ = os.RemoveAll(dir)
	})
	// 被测二进制默认现场从工作区构建；LUMO_MULTIPROC_SOAK_BIN 指向一个预先构建好的
	// 二进制时用它——拿旧版本跑同一套断言，是「这是不是本次改动引入的」的唯一判据。
	bin := os.Getenv("LUMO_MULTIPROC_SOAK_BIN")
	if bin == "" {
		bin = filepath.Join(dir, "scheduler")
		if out, err := exec.Command("go", "build", "-o", bin, "github.com/lumo-harness/platform/scheduler/cmd/scheduler").CombinedOutput(); err != nil {
			t.Fatalf("构建调度器失败: %v\n%s", err, out)
		}
	}

	// 调度器进程经时延转发器连库；本测试自己的观察与断言直连。
	procDSN, err := url.Parse(testDSN(t))
	if err != nil {
		t.Fatalf("解析 DSN 失败: %v", err)
	}
	procDSN.Host = soakDelayProxy(t, procDSN.Host, soakPGDelay)
	var commitTS string
	if err := st.Pool().QueryRow(ctx, `SHOW track_commit_timestamp`).Scan(&commitTS); err != nil {
		t.Fatalf("读 track_commit_timestamp 失败: %v", err)
	}

	cluster := &soakCluster3{t: t, bin: bin, dir: dir, dsn: procDSN.String()}
	t.Cleanup(cluster.stopAll)
	for slot := 0; slot < 3; slot++ {
		cluster.start(slot, freePort(t))
	}
	currentHolder := func() string {
		var holder string
		_ = st.Pool().QueryRow(ctx, `SELECT holder FROM scheduler_leader_lease
			WHERE id=1 AND expires_at > (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint`).Scan(&holder)
		return holder
	}
	waitFor(t, 15*time.Second, func() bool { return cluster.byInstance(currentHolder()) != nil })

	client := &http.Client{Timeout: 4 * time.Second}
	for i := 0; i < soakNodes; i++ {
		body := fmt.Sprintf(`{"node_id":"N%02d","cluster_id":%q,"capacity":%d,"capabilities":["llm"]}`, i, soakCluster, soakCapacity)
		if code, b, err := soakPost(client, cluster.ports()[0], "/v1/nodes", body); err != nil || code != http.StatusOK {
			t.Fatalf("登记节点失败: %d %s %v", code, b, err)
		}
	}

	// 任期观察者：轮询间隔远小于续租间隔（ttl/3），所以每个新 token 第一次被看到时
	// expires_at 还是接管语句写下的那个值，减去 ttl 就是接管时刻。若观察者被饿到续租
	// 之后才看到，得到的时刻只会偏晚——断言因此变弱，不会误报。
	stopObserve := make(chan struct{})
	var observeDone sync.WaitGroup
	var termsMu sync.Mutex
	var terms []termStart
	observeDone.Add(1)
	go func() {
		defer observeDone.Done()
		var last int64 = -1
		for {
			select {
			case <-stopObserve:
				return
			case <-time.After(20 * time.Millisecond):
			}
			var holder string
			var token, expires int64
			if err := st.Pool().QueryRow(ctx, `SELECT holder,fencing_token,expires_at FROM scheduler_leader_lease WHERE id=1`).Scan(&holder, &token, &expires); err != nil {
				continue
			}
			if token != last && expires > 0 {
				last = token
				termsMu.Lock()
				terms = append(terms, termStart{token: token, holder: holder, at: expires - soakTTL.Milliseconds()})
				termsMu.Unlock()
			}
		}
	}()

	// 负载：每个 task_id 由两个提交者同时发往不同副本（模拟调用方超时重试），各自重试到
	// 拿到 201 / 202 或到期。
	type ack struct {
		node    string
		attempt int
	}
	var acksMu sync.Mutex
	acks := map[string][]ack{}
	var submitted, accepted, queued, gaveUp atomic.Int64
	loadCtx, stopLoad := context.WithTimeout(ctx, duration)
	defer stopLoad()
	// 提交者在负载窗口结束后还有一段宽限把手上的任务重试完——否则最后一次换主期间
	// 提交的任务全算成「放弃」。
	submitDeadline := time.Now().Add(duration + 15*time.Second)
	submit := func(taskID string, first int) {
		body := fmt.Sprintf(`{"task_id":%q,"cluster_id":%q}`, taskID, soakCluster)
		for try := 0; time.Now().Before(submitDeadline); try++ {
			ports := cluster.ports()
			code, b, err := soakPost(client, ports[(first+try)%len(ports)], "/v1/placements", body)
			switch {
			case err == nil && code == http.StatusCreated:
				var p domain.Placement
				if json.Unmarshal(b, &p) != nil || p.NodeID == "" {
					// 201 也可能是「已在排队」的既有状态回放（无节点），按排队计。
					queued.Add(1)
					return
				}
				acksMu.Lock()
				acks[taskID] = append(acks[taskID], ack{node: p.NodeID, attempt: p.Attempt})
				acksMu.Unlock()
				accepted.Add(1)
				return
			case err == nil && code == http.StatusAccepted:
				queued.Add(1)
				return
			}
			time.Sleep(40 * time.Millisecond)
		}
		gaveUp.Add(1)
	}
	var load sync.WaitGroup
	for w := 0; w < soakWorkers; w++ {
		load.Add(1)
		go func(w int) {
			defer load.Done()
			for seq := 0; loadCtx.Err() == nil; seq++ {
				taskID := fmt.Sprintf("soak-w%02d-%06d", w, seq)
				submitted.Add(1)
				var pair sync.WaitGroup
				pair.Add(2)
				go func() { defer pair.Done(); submit(taskID, w) }()
				go func() { defer pair.Done(); submit(taskID, w+1) }()
				pair.Wait()
				time.Sleep(15 * time.Millisecond)
			}
		}(w)
	}

	// 故障：交替「强杀 leader 后原端口换一个新实例」与「冻结 leader 超过 TTL 再放开」。
	var kills, freezes int
	var frozenTakeover []time.Duration
	chaosDone := make(chan struct{})
	go func() {
		defer close(chaosDone)
		for round := 0; ; round++ {
			select {
			case <-loadCtx.Done():
				return
			case <-time.After(2500 * time.Millisecond):
			}
			leader := cluster.byInstance(currentHolder())
			if leader == nil {
				continue
			}
			if round%2 == 0 {
				_ = leader.cmd.Process.Kill()
				_, _ = leader.cmd.Process.Wait()
				_ = leader.log.Close()
				time.Sleep(300 * time.Millisecond)
				cluster.start(leader.slot, leader.port)
				kills++
				continue
			}
			// 冻结期间记下「别的实例多久之后拿到有效租约」：leader 是挂住而不是死掉时，
			// 它在途的事务还握着准入锁，接管要等它。
			frozenAt := time.Now()
			if err := leader.cmd.Process.Signal(syscall.SIGSTOP); err != nil {
				t.Errorf("冻结 leader %s: %v", leader.instance, err)
				return
			}
			took := time.Duration(-1)
			for time.Since(frozenAt) < soakFreeze {
				if h := currentHolder(); h != "" && h != leader.instance {
					took = time.Since(frozenAt)
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			if rest := soakFreeze - time.Since(frozenAt); rest > 0 {
				time.Sleep(rest)
			}
			if took < 0 {
				t.Errorf("leader %s 冻结 %s 后仍无副本接管（TTL %s）", leader.instance, soakFreeze, soakTTL)
			}
			if err := leader.cmd.Process.Signal(syscall.SIGCONT); err != nil {
				t.Errorf("解冻 leader %s: %v", leader.instance, err)
				return
			}
			frozenTakeover = append(frozenTakeover, took)
			freezes++
		}
	}()

	load.Wait()
	<-chaosDone
	// 让冻结过的旧 leader 把醒来后手上的请求处理完，再停进程、看最终状态。
	time.Sleep(2 * soakTTL)
	close(stopObserve)
	observeDone.Wait()
	cluster.stopAll()

	t.Logf("提交 %d 个任务（每个两路并发）：201=%d 202=%d 放弃=%d；强杀 %d 次，冻结 %d 次；观察到 %d 个任期",
		submitted.Load(), accepted.Load(), queued.Load(), gaveUp.Load(), kills, freezes, len(terms))
	t.Logf("leader 被冻结后别的实例拿到有效租约的耗时（-1 = 冻结 %s 期间始终没有）：%v；TTL=%s", soakFreeze, frozenTakeover, soakTTL)

	// 浸泡本身得真的发生过：没有换主、没有放置的一轮「全绿」不算数。
	if len(terms) < 3 {
		t.Fatalf("至少应观察到 3 个任期（发生过换主），实际 %d: %+v", len(terms), terms)
	}
	if kills == 0 || freezes == 0 {
		t.Fatalf("强杀与冻结都应至少发生一次: kills=%d freezes=%d", kills, freezes)
	}
	placedRows := rowCount(t, st, `SELECT count(*) FROM scheduler_task_attempts`)
	if placedRows < 200 {
		t.Fatalf("放置数过少，浸泡没有形成有效负载: %d", placedRows)
	}

	// 1. 同一 task_id 只派发一次。
	if n := rowCount(t, st, `SELECT count(*) FROM (SELECT task_id FROM scheduler_dispatch_outbox GROUP BY task_id HAVING count(*) > 1) d`); n != 0 {
		t.Errorf("%d 个任务被派发了不止一次（outbox 多行）", n)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_task_attempts WHERE attempt <> 1`); n != 0 {
		t.Errorf("%d 条 attempt 不是 1：没有任务完成过，不该有第二次 attempt", n)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks t WHERE state='PLACED'
		AND (SELECT count(*) FROM scheduler_dispatch_outbox o WHERE o.task_id=t.task_id AND o.node_id=t.node_id) <> 1`); n != 0 {
		t.Errorf("%d 个 PLACED 任务没有恰好一条指向其节点的派发", n)
	}

	// 2. 容量。
	if n := rowCount(t, st, fmt.Sprintf(`SELECT count(*) FROM (SELECT node_id FROM scheduler_tasks
		WHERE state IN ('PLACED','RUNNING','CANCELLING') GROUP BY node_id HAVING count(*) > %d) d`, soakCapacity)); n != 0 {
		t.Errorf("%d 个节点的活跃数超过容量 %d", n, soakCapacity)
	}

	// 3. 围栏：token=k 的放置不晚于任何更新任期（token>k）的起点。
	// attempt 行在放置事务里写入后没有别人改过（没有任务完成），xmin 就是放置事务。
	placedAt := `updated_at`
	if commitTS == "on" {
		placedAt = `(EXTRACT(EPOCH FROM pg_xact_commit_timestamp(xmin)) * 1000)::bigint`
		t.Log("围栏按提交时刻核对（track_commit_timestamp=on）")
	} else {
		t.Log("围栏按语句时刻核对（track_commit_timestamp=off）：比按提交时刻弱，见文件头")
	}
	sort.Slice(terms, func(i, j int) bool { return terms[i].token < terms[j].token })
	for i := 1; i < len(terms); i++ {
		var late int
		var worst int64
		if err := st.Pool().QueryRow(ctx, `SELECT count(*), COALESCE(max(placed_at) - $2, 0) FROM
			(SELECT fencing_token, `+placedAt+` AS placed_at FROM scheduler_task_attempts) a
			WHERE fencing_token < $1 AND placed_at > $2`, terms[i].token, terms[i].at).Scan(&late, &worst); err != nil {
			t.Fatalf("围栏核对失败: %v", err)
		}
		if late != 0 {
			t.Errorf("任期 token=%d（%s）开始之后仍有 %d 条旧任期的放置落库，最晚晚了 %dms",
				terms[i].token, terms[i].holder, late, worst)
		}
	}

	// 4. 调用方拿到过的 201 都在库里，且同一任务的 201 一致。
	rows, err := st.Pool().Query(ctx, `SELECT task_id, COALESCE(node_id,''), attempt, state FROM scheduler_tasks`)
	if err != nil {
		t.Fatalf("读任务失败: %v", err)
	}
	type dbTask struct {
		node    string
		attempt int
		state   string
	}
	db := map[string]dbTask{}
	for rows.Next() {
		var id string
		var d dbTask
		if err := rows.Scan(&id, &d.node, &d.attempt, &d.state); err != nil {
			t.Fatalf("读任务失败: %v", err)
		}
		db[id] = d
	}
	rows.Close()
	lost, split, mismatch := 0, 0, 0
	for id, got := range acks {
		row, ok := db[id]
		if !ok || row.state != "PLACED" {
			lost++
			continue
		}
		for _, a := range got {
			if a.node != got[0].node || a.attempt != got[0].attempt {
				split++
				break
			}
		}
		if row.node != got[0].node || row.attempt != got[0].attempt {
			mismatch++
		}
	}
	if lost != 0 {
		t.Errorf("%d 个已向调用方确认（201）的放置不在库里", lost)
	}
	if split != 0 {
		t.Errorf("%d 个任务的两路提交拿到了不同的放置", split)
	}
	if mismatch != 0 {
		t.Errorf("%d 个任务库里的放置与调用方拿到的不一致", mismatch)
	}
	// 重试到期仍没被接受的任务：换主窗口是有限的，放弃的应是极少数。
	if g := gaveUp.Load(); g*20 > submitted.Load()*2 {
		t.Errorf("放弃的提交过多（%d / %d 路）：换主期间服务没有恢复", g, submitted.Load()*2)
	}
}
