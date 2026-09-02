// Command scheduler 是全局任务调度服务（§6.2 / §7.4.1，评审 N1）。
//
// leader 选举基于 PG 单行租约（spec 决策：fencing 与写路径同源），
// 放置写入事务内 fencing 校验；派发走 PG outbox（§13.2 本地替代 RocketMQ）。
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
	"github.com/lumo-harness/platform/scheduler/internal/server"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

func main() {
	var (
		pgDSN    = flag.String("pg", envOr("LUMO_PG_DSN", "postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN")
		listen   = flag.String("listen", envOr("LUMO_LISTEN", ":8083"), "HTTP 监听地址")
		instance = flag.String("instance", envOr("LUMO_INSTANCE", "scheduler-0"), "本实例标识（租约 holder，重启后不得与旧进程重复）")
		ttlMs    = flag.Int64("ttl-ms", envOrInt("LUMO_TTL_MS", 10000), "租约 TTL（毫秒）")
		drainMs  = flag.Int64("drain-ms", envOrInt("LUMO_DRAIN_MS", 1000), "drain loop 周期（毫秒）")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	shutdownOTel, telemetryErr := observability.ConfigureOTelFromEnv(ctx, "lumo-scheduler")
	if telemetryErr != nil {
		log.Error("invalid OpenTelemetry configuration", "err", telemetryErr)
		os.Exit(2)
	}

	st, err := store.New(ctx, *pgDSN)
	if err != nil {
		log.Error("连接存储失败", "err", err)
		os.Exit(1)
	}
	defer st.Close()
	if err := st.Init(ctx); err != nil {
		log.Error("初始化表结构失败", "err", err)
		os.Exit(1)
	}

	var cat catalog.Catalog = &catalog.Pg{Pool: st.Pool()}
	if nacosAddr := os.Getenv("LUMO_NACOS_ADDR"); nacosAddr != "" {
		cat = catalog.NewNacos(nacosAddr, os.Getenv("LUMO_NACOS_SERVICE"), os.Getenv("LUMO_NACOS_GROUP"))
		log.Info("使用 Nacos 节点目录", "addr", nacosAddr)
	}
	elec := &election.State{}

	// 选主循环：acquire + 续租（TTL/3）
	electionCtx, cancelElection := context.WithCancel(ctx)
	go election.Run(electionCtx, elec, st, *instance,
		time.Duration(*ttlMs)*time.Millisecond, func(isLeader bool) {
			log.Info("领导权变更", "leader", isLeader, "instance", *instance)
		})

	// drain loop：leader 时把 PENDING 任务接续放置（非 leader 空转，不查库）
	go func() {
		ticker := time.NewTicker(time.Duration(*drainMs) * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !elec.IsLeader() {
					continue
				}
				if _, err := st.RequeueStaleDispatch(ctx, *ttlMs*2); err != nil {
					log.Warn("回收过期派发失败", "err", err)
				}
				drainOnce(ctx, st, cat, elec.Current(), log)
			}
		}
	}()

	srv := &http.Server{
		Addr:              *listen,
		Handler:           observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(server.New(st, elec, cat, log, os.Getenv("LUMO_SUBAGENT_HOST_TOKEN")).Routes())),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Info("调度服务启动", "listen", *listen, "instance", *instance, "ttl_ms", *ttlMs)
		if err := observability.Serve(srv); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("HTTP 服务异常退出", "err", err)
			stop()
		}
	}()

	<-ctx.Done()

	// 优雅停机顺序（spec §2）：
	// ① 停选主循环——先停止续租，否则 Release 之后一轮续租会把租约「复活」；
	// ② 排空 HTTP——在途放置仍有效（租约尚未过期）；
	// ③ 释放租约（expires_at=0）——备节点零等待接管；
	// ④ 关池（defer st.Close）。
	log.Info("收到停机信号，开始优雅排空")
	cancelElection()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("排空失败", "err", err)
	}
	if err := shutdownOTel(shutdownCtx); err != nil {
		log.Warn("flush OpenTelemetry failed", "err", err)
	}
	if err := st.Release(context.Background(), *instance); err != nil {
		log.Warn("释放租约失败", "err", err)
	}
	log.Info("调度服务已停止")
}

// drainOnce 一轮接续：取 PENDING → 规划 → 放置。任何一处失败仅记录并等下一轮。
func drainOnce(ctx context.Context, st *store.Store, cat catalog.Catalog, lease *domain.Lease, log *slog.Logger) {
	pending, err := st.PendingTasks(ctx, 32)
	if err != nil {
		log.Error("取排队任务失败", "err", err)
		return
	}
	if len(pending) == 0 {
		return
	}
	nodes, err := cat.List(ctx)
	if err != nil {
		log.Error("列节点失败", "err", err)
		return
	}
	active, err := st.ActiveCounts(ctx)
	if err != nil {
		log.Error("活跃计数失败", "err", err)
		return
	}
	for _, task := range planner.OrderPending(pending, time.Now()) {
		n := planner.Pick(task, nodes, active)
		if n == nil {
			break // 剩余任务同样无候选，等下一轮
		}
		if err := st.SyncNodeSnapshot(ctx, *n); err != nil {
			log.Error("同步节点快照失败", "node_id", n.NodeID, "err", err)
			continue
		}
		if _, err := st.PlaceTask(ctx, lease, task, n.NodeID); err != nil {
			var ncap *domain.NoCapacityError
			if errors.As(err, &ncap) {
				break
			}
			log.Error("drain 放置失败", "task_id", task.TaskID, "err", err)
			continue
		}
		active[n.NodeID]++
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envOrInt(key string, fallback int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return fallback
}
