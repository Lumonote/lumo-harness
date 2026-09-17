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
		// 历史事件源：本进程默认无真实来源，必须显式开启；未开启则 WS 接入返回 503（诚实）。
		// 只提供内存实现用于演示/测试；生产应接线真实来源（PG / 消息总线）。
		memEvents = flag.Bool("mem-events", envOr("LUMO_TERMINAL_MEM_EVENTS", "") == "true", "启用内存事件源（仅测试/演示；生产应当接线真实来源）")
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

	// 历史事件源：未配置真实来源时保持 nil，让 WS 接入诚实返回 503，绝不伪造空历史。
	var source events.EventSource
	if *memEvents {
		source = events.NewMemory()
		log.Warn("使用内存事件源（演示/测试用；生产应当接线真实 session/event 来源）")
	} else {
		log.Warn("未配置 session/event 历史源：终端网关将返回 503 直至部署接线（不伪造空历史）")
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
