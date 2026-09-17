// Command llm-gateway 是模型访问面（§12 网关四门之一，P2a 起始项）：
// OpenAI 兼容入口 + 计量单截面跨网（emitter=llm-gateway）+ 双树预算执法镜像。
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
	"github.com/lumo-harness/platform/llm-gateway/internal/batch"
	"github.com/lumo-harness/platform/llm-gateway/internal/gateway"
	"github.com/lumo-harness/platform/llm-gateway/internal/server"
	"github.com/lumo-harness/platform/llm-gateway/internal/store"
	"github.com/lumo-harness/platform/observability"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envOrInt 同 envOr，但把值解析成整数。解析失败时**回落到缺省**而不是报错：
// 真正的把关在 batch.Config.Validate，那里能点名变量；这里再报一次会让同一条
// 配置错误有两个出口、两种文案。
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

// envOrInt64 同 envOrInt，给 flag.Int64 用（毫秒窗口）。
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

func main() {
	var (
		pgDSN  = flag.String("pg", envOr("LUMO_PG_DSN", "postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN")
		listen = flag.String("listen", envOr("LUMO_LISTEN", ":8088"), "HTTP 监听地址")

		// 批处理汇聚（§7.2）。默认**关闭**：拿 TTFT 换吞吐是部署决策，集群形态
		// 与单机形态的最优解不同，代码不替用户拍板。
		batchWindowMs = flag.Int64("batch-window-ms", envOrInt64("LUMO_LLM_BATCH_WINDOW_MS", 0),
			"批处理汇聚窗口（毫秒）：0 = 关闭（请求直通）；>0 时每个请求最多被延迟这么久以对齐上游批")
		batchMax = flag.Int("batch-max", envOrInt("LUMO_LLM_BATCH_MAX", batch.DefaultMaxBatch),
			"单批请求数上限：达到即放行，不必等窗口走完（窗口开启时必为正）")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if _, err := observability.ConfigureOTelFromEnv(ctx, "lumo-llm-gateway"); err != nil {
		log.Error("invalid OpenTelemetry configuration", "err", err)
		os.Exit(2)
	}

	// 配置校验放在连库**之前**：一个非法阈值不该等到 PG 连上才被发现，否则
	// 「配错了」和「数据库连不上」在启动日志里长得一样。退出码 2 = 配置错误。
	coalescer, err := batch.New(batch.Config{
		Window:   time.Duration(*batchWindowMs) * time.Millisecond,
		MaxBatch: *batchMax,
	})
	if err != nil {
		log.Error("批处理汇聚配置非法", "err", err)
		os.Exit(2)
	}
	defer coalescer.Close()

	pool, err := pgxpool.New(ctx, *pgDSN)
	if err != nil {
		log.Error("PG 连接失败", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	st := store.New(pool)
	if err := st.Init(ctx); err != nil {
		log.Error("初始化失败", "err", err)
		os.Exit(1)
	}

	client := observability.ConfiguredHTTPClient(10 * time.Minute) // 流式长连接：总时长上限
	gw := gateway.New(client, func(format string, args ...any) {
		log.Warn("网关告警: "+format, args...)
	})
	srv := server.New(st, gw, log, server.WithCoalescer(coalescer))
	log.Info("批处理汇聚", "enabled", coalescer.Config().Enabled(),
		"window_ms", *batchWindowMs, "max_batch", *batchMax)

	mux := http.NewServeMux()
	srv.Register(mux)

	// 心跳上报：集群就绪态由心跳新鲜度与自报依赖派生（E4/D6），不再只看
	// LUMO_CLUSTER_STATUS 这个静态声明。放在初始化之后，避免服务尚不可用就报 ready。
	heartbeat.StartPg(ctx, pool, heartbeat.Options{Service: "llm-gateway", Logger: log, Depends: heartbeat.PgDependency(pool)})

	log.Info("llm-gateway 启动", "addr", *listen)
	httpSrv := &http.Server{Addr: *listen, Handler: observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(mux)), ReadHeaderTimeout: 10 * time.Second}
	if err := observability.Serve(httpSrv); err != nil {
		log.Error("退出", "err", err)
		os.Exit(1)
	}
}
