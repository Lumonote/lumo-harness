// Command terminal-gateway 是终端网关（§8.2 的「多端」落地、缺口 C4 的实现）：终端无关事件汇
// （订阅 session/event + replay 历史 + live push）、能力协商（web 给图表 / CLI 给表格 /
// mobile 给卡片）、Presence（谁在某 session 在线、以什么能力在线）、敏感动作签名 + OPA 校验。
//
// 明确范围（§8.4.3）：本网关只做「看 + presence + 能力协商 + replay」，**不实现控制状态机**，
// 也不处理 pause/resume/stop/abort/approve——那是并行开发的 session-control 服务的事。
package main

import (
	"context"
	"flag"
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
	"github.com/lumo-harness/platform/terminal-gateway/internal/events"
	"github.com/lumo-harness/platform/terminal-gateway/internal/policy"
	"github.com/lumo-harness/platform/terminal-gateway/internal/presence"
	"github.com/lumo-harness/platform/terminal-gateway/internal/server"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envOrInt 同 envOr 但解析整数。解析失败回落缺省：真正的把关在各子包校验里，这里再报一次
// 只会多一个不一致的错误出口。
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

func envOrInt64(key string, def int64) int64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return def
	}
	return n
}

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

func main() {
	var (
		pgDSN       = flag.String("pg", envOr("LUMO_PG_DSN", "postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN（心跳用）")
		listen      = flag.String("listen", envOr("LUMO_LISTEN", ":8090"), "HTTP/WS 监听地址")
		opaURL      = flag.String("opa-url", envOr("LUMO_OPA_URL", ""), "OPA 基址（空=未配置→敏感动作 fail-closed）")
		signSecret  = flag.String("sign-secret", envOr("LUMO_TERMINAL_SIGNING_SECRET", ""), "敏感动作签名密钥（空=未配置→fail-closed）")
		presenceTTL = flag.Duration("presence-ttl", envOrDuration("LUMO_PRESENCE_TTL", 30*time.Second), "presence 过期时长（靠时间判定，不靠断开回调）")
		maxFrame    = flag.Int("max-frame", envOrInt("LUMO_WS_MAX_FRAME", 1<<20), "单帧 payload 硬上限（字节）")
		// 历史事件源：默认是复制式会话日志（PG）。`--mem-events` 换成内存实现，只用于
		// 测试/演示（进程重启即丢，不持久化）。
		memEvents = flag.Bool("mem-events", envOr("LUMO_TERMINAL_MEM_EVENTS", "") == "true", "改用内存事件源（仅测试/演示；生产用 PG 会话日志）")
		// 实时推送的轮询周期。轮询而不是引入消息总线是刻意的：代价是一个周期的延迟，
		// 换来的是不必再维护第二个必须与日志保持一致的真相源。0 或负值由 events 包
		// 夹到 1s（它会自己兜底，不在这里复制一遍默认值）。
		pollInterval = flag.Duration("poll-interval", envOrDuration("LUMO_TERMINAL_POLL_INTERVAL", time.Second), "实时事件轮询周期")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if _, err := observability.ConfigureOTelFromEnv(ctx, "lumo-terminal-gateway"); err != nil {
		log.Error("invalid OpenTelemetry configuration", "err", err)
		os.Exit(2)
	}

	pool, err := pgxpool.New(ctx, *pgDSN)
	if err != nil {
		log.Error("连接 PostgreSQL 失败", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	// 历史事件源 = 复制式会话日志（`session_log`，PG 是真相源）。
	//
	// 读它是**只读**的，因此不违反那张表的单写者 + fencing 约束：约束管的是写侧（外部
	// 进程直插会撞 `(session_ref, seq)` 主键并把日志变成分叉），而 SELECT 既不取租约也
	// 不写任何行，任意多个网关实例可以同时读。把这两件事混为一谈，会得出「终端必须由
	// 承载节点自己代理」这个不必要的结论。
	//
	// 仍未配置来源时保持 nil，让 WS 接入诚实返回 503 —— 但那个分支现在只剩一个入口
	// （`--mem-events` 之外还有池都建不起来的情况），不再是默认形态。
	var source events.EventSource
	switch {
	case *memEvents:
		source = events.NewMemory()
		log.Warn("使用内存事件源（演示/测试用；生产应当用 PG 会话日志）")
	default:
		pgSource, err := events.NewPg(events.Options{Pool: pool, Interval: *pollInterval, Logger: log})
		if err != nil {
			// 走到这里说明连接池不可用，而上文刚用它建过池 —— 属于不可能的形态，
			// 所以不当场降级：降级会得到一个「进程健康但永远 503」的部署。
			log.Error("构造 PG 事件源失败", "err", err)
			os.Exit(1)
		}
		source = pgSource
		log.Info("事件源：PG 会话日志", "interval", pollInterval.String())
	}

	pres := presence.NewStore(*presenceTTL, nil)
	// NewAuthorizer 永远返回非 nil：OPA 未配置时 eval=nil，鉴权器仍可用，只是任何敏感动作
	// 都会 fail-closed 拒绝（见 internal/policy）。
	auth := policy.NewAuthorizer(*signSecret, *opaURL)

	srv := server.New(server.Options{
		Source:   source,
		Presence: pres,
		Auth:     auth,
		Logger:   log,
		MaxFrame: *maxFrame,
	})
	mux := http.NewServeMux()
	srv.Routes(mux)

	// presence 指标导出：定期整体替换，让维度消失可被观测（见 internal/presence）。
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				pres.PublishMetrics()
			}
		}
	}()

	// 心跳上报：service 名 "terminal-gateway"。放在初始化之后，避免尚不可用就报 ready。
	heartbeat.StartPg(ctx, pool, heartbeat.Options{Service: "terminal-gateway", Logger: log, Depends: heartbeat.PgDependency(pool)})

	log.Info("terminal-gateway 启动", "addr", *listen, "presenceTTL", *presenceTTL, "maxFrame", *maxFrame)
	httpSrv := &http.Server{
		Addr:              *listen,
		Handler:           observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(mux)),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := observability.Serve(httpSrv); err != nil {
		log.Error("退出", "err", err)
		os.Exit(1)
	}
}
