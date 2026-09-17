// Command session-control 是共享执行控制服务（§8.4，缺口 C5 的实现）：把
// pause / resume / stop / abort / approve / reject / replay / degrade 做成
// **可审计的一等事件**，并提供控制台所需的只读投影面。
//
// # 范围（本轮诚实声明）
//
// 已落地：状态机裁决（每个状态 × 每条指令的显式矩阵）、OPA 授权（fail-closed）、
// 同会话串行化（进程内队列 + 库端行锁 + 版本比较后交换）、审计（放行与拒绝都写）、
// 控制台读面（状态 + 每个按钮此刻可不可点 + 时间线 + 队列现场）。
//
// **未接线**：把已生效的指令下发到会话执行面（§8.1 的 suspend / `agent.inject()`）。
// 因此每条响应里的 `effectuation` 恒为 `recorded`——状态与审计是真的，会话那边还没
// 被动过。启动日志会明确警告这件事，响应里也带着它，不靠文档记（见 internal/control
// 包注释里「先落库再下发」那段取舍）。
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/heartbeat"
	"github.com/lumo-harness/platform/observability"

	"github.com/lumo-harness/platform/session-control/internal/control"
	"github.com/lumo-harness/platform/session-control/internal/policy"
	"github.com/lumo-harness/platform/session-control/internal/queue"
	"github.com/lumo-harness/platform/session-control/internal/server"
	"github.com/lumo-harness/platform/session-control/internal/store"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envOrDuration 解析时长。解析失败回落缺省：真正的把关在 validateConfig 里，
// 这里再报一次只会多一个不一致的错误出口。
func envOrDuration(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}

func envOrInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// 队列的两个时间上限都有缺省，但都由环境变量暴露：合适的 MaxHold 取决于 store 的
// 超时设置，配错了会变成「正常慢请求被误判为卡死」或「真卡死时队列被堵很久」。
const (
	defaultMaxHold   = 30 * time.Second
	defaultWaitLimit = 5 * time.Second
	defaultTick      = 10 * time.Second
)

// validateConfig 在连库之前把关。非法配置必须以退码 2 结束，而不是带着一个
// 「看起来配好了」的实例启动——那样症状会推迟到控制指令进来时才出现。
func validateConfig(maxHold, waitLimit, tick time.Duration) error {
	if maxHold < time.Second {
		return fmt.Errorf("MaxHold=%s 太小：单条控制脉冲的持有上限低于 1s 时，"+
			"正常请求也会被判定为卡死并被强制接管（上限的意义是兜住死锁，不是限制正常耗时）", maxHold)
	}
	if maxHold > 10*time.Minute {
		return fmt.Errorf("MaxHold=%s 太大：一条卡死的脉冲会把该会话的控制堵住这么久", maxHold)
	}
	if waitLimit <= 0 {
		return fmt.Errorf("WaitLimit=%s 必须为正：等待必须有上限，不允许「永远等下去」", waitLimit)
	}
	if tick <= 0 {
		return fmt.Errorf("Tick=%s 必须为正（后台清扫与指标发布的周期）", tick)
	}
	return nil
}

func main() {
	var (
		pgDSN = flag.String("pg", envOr("LUMO_PG_DSN",
			"postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN（状态行 + 审计）")
		// 缺省 8092 而不是 8091：控制面服务的宿主端口按「18000 + 容器端口」映射
		// （18080-18093 那一带），而 18091 已被 terminal-gateway 占用、18090 留给了
		// 可选设备网关 overlay。8092 ↔ 18092 是这段里唯一还成立的对应关系，
		// 换成 8091 就得让端口规则再破一次例（terminal-gateway 那次已经是一处例外）。
		listen = flag.String("listen", envOr("LUMO_LISTEN", ":8092"), "HTTP 监听地址")
		opaURL = flag.String("opa-url", envOr("LUMO_OPA_URL", ""),
			"OPA 基址（空=未配置 → 控制指令 fail-closed 全拒）")
		opaPolicy = flag.String("opa-policy", envOr("LUMO_OPA_POLICY", ""),
			"OPA 策略路径（空=用政策包 lumo/session_control）")
		maxHold   = flag.Duration("max-hold", envOrDuration("LUMO_SESSION_CONTROL_HOLD", defaultMaxHold), "单条控制脉冲的持有上限（超过后他人可强制接管）")
		waitLimit = flag.Duration("wait-limit", envOrDuration("LUMO_SESSION_CONTROL_WAIT", defaultWaitLimit), "控制指令在本实例队列里的最长等待")
		tick      = flag.Duration("tick", envOrDuration("LUMO_SESSION_CONTROL_TICK", defaultTick), "后台清扫 + 指标发布周期")
		attempts  = flag.Int("max-attempts", envOrInt("LUMO_SESSION_CONTROL_ATTEMPTS", 3), "版本冲突后的重读重试上限")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if _, err := observability.ConfigureOTelFromEnv(ctx, "lumo-session-control"); err != nil {
		log.Error("invalid OpenTelemetry configuration", "err", err)
		os.Exit(2)
	}
	// 配置校验放在连库之前：这样「配错了」与「库连不上」是两条不同的退出码/日志，
	// 运维不必先修好数据库才能发现自己把时长写反了。
	if err := validateConfig(*maxHold, *waitLimit, *tick); err != nil {
		log.Error("控制面配置非法", "err", err)
		os.Exit(2)
	}

	pool, err := pgxpool.New(ctx, *pgDSN)
	if err != nil {
		log.Error("连接 PostgreSQL 失败", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	persistence := store.New(pool)
	if err := persistence.Init(ctx); err != nil {
		log.Error("初始化控制面表失败", "err", err)
		os.Exit(1)
	}

	// 未配置 OPA 时 New 仍返回可用对象，只是任何请求都得到 ErrUnavailable ——
	// 控制指令因此**全拒**（fail-closed）。这不是降级，是设计：见 internal/policy。
	auth := policy.New(*opaURL, *opaPolicy)
	if *opaURL == "" {
		log.Warn("未配置 LUMO_OPA_URL：控制指令将全部被拒（fail-closed），" +
			"响应里会明确写 policy_unavailable 而不是 policy_denied")
	}

	pulses := queue.NewManager(queue.Options{MaxHold: *maxHold, WaitLimit: *waitLimit})
	// 强制接管既是「有人在卡住」的唯一历史证据，也必须能被告警，所以队列回调直接
	// 接到指标累积器上（而不是让调用方去轮询）。
	pulses.OnForceRelease(control.ObserveForcedRelease)

	controller := control.New(control.Options{
		Store: persistence, Auth: auth, Queue: pulses,
		// Dispatcher 故意留空：会话执行面的下发尚未接线（见本文件包注释）。
		Logger: log, MaxAttempts: *attempts,
	})

	srv := server.New(server.Options{
		Execute: controller.Execute,
		Store:   persistence,
		Queue:   pulses,
		Logger:  log,
	})
	mux := http.NewServeMux()
	srv.Routes(mux)

	// 后台周期：① 强制接管持有超限的脉冲（空转会话没有下一个请求，只靠准入时的
	// 清扫会把「队列被堵」这个事实一直挂着）；② 把进程内累积的指标发布出去。
	// 两条都在同一个 tick 里，不与抓取路径共享任何状态。
	go func() {
		ticker := time.NewTicker(*tick)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				for _, forced := range pulses.Sweep() {
					log.Warn("控制脉冲持有超限，已被强制接管",
						"session", forced.SessionRef, "correlationId", forced.CorrelationID,
						"held", forced.Held.String(), "maxHold", maxHold.String())
				}
				control.PublishMetrics(pulses.Totals)
			}
		}
	}()

	// 心跳：service 名 "session-control"。放在初始化之后，避免尚不可用就报 ready。
	heartbeat.StartPg(ctx, pool, heartbeat.Options{
		Service: "session-control", Logger: log, Depends: heartbeat.PgDependency(pool),
	})

	log.Info("session-control 启动", "addr", *listen, "opaConfigured", *opaURL != "",
		"maxHold", maxHold.String(), "waitLimit", waitLimit.String(), "maxAttempts", *attempts)
	log.Warn("控制指令下发（§8.1 suspend / agent.inject）尚未接线：" +
		"指令会被裁决并记入审计，响应里的 effectuation 恒为 recorded")

	httpSrv := &http.Server{
		Addr: *listen,
		Handler: observability.Middleware(
			observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(mux)),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := observability.Serve(httpSrv); err != nil {
		log.Error("退出", "err", err)
		os.Exit(1)
	}
}
