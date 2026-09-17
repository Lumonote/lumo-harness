// Command edge-gateway 是边缘网关（§12.1 南北向的「门」、缺口 C3 的实现）。
//
// 它只干网关该干的四件事、不对业务语义负责：① 协议适配/接入（反向代理）
// ② 路由分发（声明式路由表 + 灰度）③ 横切治理（限流/体大小/连接数/CORS/基础 WAF）
// ④ 边界隔离（上游显式白名单）。门后才是真正能力。
package main

import (
	"context"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/lumo-harness/platform/edge-gateway/internal/gate"
	"github.com/lumo-harness/platform/edge-gateway/internal/routing"
	"github.com/lumo-harness/platform/edge-gateway/internal/server"
	"github.com/lumo-harness/platform/edge-gateway/internal/waf"
	"github.com/lumo-harness/platform/heartbeat"
	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/ratelimit"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envOrInt 同 envOr 但解析整数。解析失败回落缺省：真正的把关在路由表校验与
// Serve 之前的各显式检查，这里再报一次只会多一个不一致的错误出口。
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

func main() {
	var (
		pgDSN      = flag.String("pg", envOr("LUMO_PG_DSN", "postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN（心跳用）")
		listen     = flag.String("listen", envOr("LUMO_LISTEN", ":8080"), "HTTP 监听地址")
		routesPath = flag.String("routes", envOr("LUMO_EDGE_ROUTES", ""), "路由表 JSON 路径（声明式来源）")
		redisURL   = flag.String("redis", envOr("LUMO_EDGE_REDIS_URL", ""), "Redis URL（限流令牌桶；空=关闭限流）")
		globalRPM  = flag.Int("global-rpm", envOrInt("LUMO_EDGE_GLOBAL_RPM", 0), "全局每客户端配额（0=不限）")
		failOpen   = flag.Bool("limiter-fail-open", envOr("LUMO_EDGE_LIMITER_FAIL_OPEN", "") == "true",
			"限流器不可用时放行（默认拒绝：fail-closed）")
		maxBody     = flag.Int64("max-body-bytes", envOrInt64("LUMO_EDGE_MAX_BODY_BYTES", 1<<20), "请求体大小上限（0=不限）")
		maxConns    = flag.Int64("max-conns", envOrInt64("LUMO_EDGE_MAX_CONNS", 10000), "全局在途连接数上限（0=不限）")
		corsOrigins = flag.String("cors-origins", envOr("LUMO_EDGE_CORS_ORIGINS", ""), "允许的 CORS 来源（逗号分隔，* 通配）")
		corsMethods = flag.String("cors-methods", envOr("LUMO_EDGE_CORS_METHODS", ""), "允许的 CORS 方法（缺省一组默认）")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if _, err := observability.ConfigureOTelFromEnv(ctx, "lumo-edge-gateway"); err != nil {
		log.Error("invalid OpenTelemetry configuration", "err", err)
		os.Exit(2)
	}

	// 配置校验放在连库**之前**：路由表是边界网关的形状，非法配置（未知字段、
	// 重叠路由、未白名单上游、灰度权重非法）必须在营业前被拒绝。退出码 2 = 配置错误。
	if *routesPath == "" {
		log.Error("路由表路径未配置（--routes 或 LUMO_EDGE_ROUTES）", "err", "missing routes")
		os.Exit(2)
	}
	table, err := routing.LoadPath(*routesPath)
	if err != nil {
		log.Error("加载路由表失败", "path", *routesPath, "err", err)
		os.Exit(2)
	}
	if err := table.Validate(); err != nil {
		log.Error("路由表校验失败", "err", err)
		os.Exit(2)
	}
	compiled, err := table.Compile()
	if err != nil {
		log.Error("编译路由表失败", "err", err)
		os.Exit(2)
	}

	pool, err := pgxpool.New(ctx, *pgDSN)
	if err != nil {
		log.Error("连接 PostgreSQL 失败", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	// 限流：共享 Redis 令牌桶。Redis 未配置 → 限流整体关闭（大声说明），而不是
	// 静默放行；配置了但抖动 → 由 failOpen 决定 fail-open/closed（默认 closed）。
	var limiter gate.RateLimiter
	if *redisURL == "" {
		log.Warn("未配置 Redis：限流已关闭（所有流量不受限流保护）", "remedy", "设置 LUMO_EDGE_REDIS_URL 启用全局/路由限流")
	} else {
		ropt, err := redis.ParseURL(*redisURL)
		if err != nil {
			log.Error("解析 Redis URL 失败", "err", err)
			os.Exit(2)
		}
		rdb := redis.NewClient(ropt)
		defer rdb.Close()
		// 启动期只做一次可达性探测并大声告警；不退出——网关是入口，一个 Redis
		// 抖动不该让整站起不来，真正的取舍在请求期的 fail-open/closed 开关。
		if err := rdb.Ping(ctx).Err(); err != nil {
			log.Error("Redis 不可达：限流将按 fail-open 设置裁决请求", "failOpen", *failOpen, "err", err)
		}
		limiter = ratelimit.New(rdb)
	}

	// 代理出站的 http.Client **不设整体 Timeout**：ReverseProxy 会持续把上游响应
	// 流式拷贝给客户端，若 client.Timeout 非零，一个超过该时长的流式响应（如 LLM
	// 逐 chunk）会被中途切断。连接级超时交给下面的 Transport 拨号/空闲设置。
	proxyTransport := &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:   true,
		MaxIdleConns:        200,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
	}
	proxyClient := &http.Client{Transport: proxyTransport}

	srv := server.New(server.Options{
		Compiled:     compiled,
		ProxyClient:  proxyClient,
		Limiter:      limiter,
		GlobalRPM:    *globalRPM,
		FailOpen:     *failOpen,
		MaxBodyBytes: *maxBody,
		MaxConns:     *maxConns,
		CORSOrigins:  splitCSV(*corsOrigins),
		CORSMethods:  *corsMethods,
		WafRules:     waf.DefaultRules(),
		Logger:       log,
	})

	mux := http.NewServeMux()
	srv.Routes(mux)

	// 心跳上报：service 名 "edge-gateway"。放在初始化之后，避免尚不可用就报 ready。
	heartbeat.StartPg(ctx, pool, heartbeat.Options{Service: "edge-gateway", Logger: log, Depends: heartbeat.PgDependency(pool)})

	// 路由表热重载：收到 SIGHUP 重新加载并原子替换，无需重启进程。
	go reloadOnSIGHUP(ctx, log, *routesPath, srv)

	// TLS：可选终止，由 env 驱动。未配置时**显式**打日志说明现在跑的是明文 HTTP，
	// 不静默降级——运维必须意识到自己在裸奔，而不是从日志里猜。
	if os.Getenv("LUMO_TLS_CERT_FILE") == "" {
		log.Warn("未配置 TLS：边缘网关以明文 HTTP 运行，南北流量无传输层加密",
			"remedy", "设置 LUMO_TLS_CERT_FILE/LUMO_TLS_KEY_FILE/LUMO_TLS_CLIENT_CA_FILE 启用 mTLS 终止")
	}

	log.Info("edge-gateway 启动", "addr", *listen, "routes", *routesPath,
		"globalRPM", *globalRPM, "failOpen", *failOpen, "maxBody", *maxBody, "maxConns", *maxConns)

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

// reloadOnSIGHUP 监听 SIGHUP，重新加载路由表并原子替换。加载/校验失败时只告警、
// 保留旧表继续服务（一次坏配置不该让网关中断），这与「启动期配置错误退出」是
// 两种不同语义：启动时没有可服务的旧表，重载时有。
func reloadOnSIGHUP(ctx context.Context, log *slog.Logger, path string, srv *server.Server) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGHUP)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ch:
			table, err := routing.LoadPath(path)
			if err != nil {
				log.Error("SIGHUP 重载失败：保留旧路由表", "err", err)
				continue
			}
			if err := table.Validate(); err != nil {
				log.Error("SIGHUP 重载校验失败：保留旧路由表", "err", err)
				continue
			}
			compiled, err := table.Compile()
			if err != nil {
				log.Error("SIGHUP 重载编译失败：保留旧路由表", "err", err)
				continue
			}
			srv.Swap(compiled)
			log.Info("SIGHUP 路由表已热重载")
		}
	}
}

func splitCSV(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}
