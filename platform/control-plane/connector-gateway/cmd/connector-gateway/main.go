// Command connector-gateway 是连接器网关（§10.1 / §12.1「南北向的门」）。
//
// 四道闸：路由 + 鉴权（Vault 凭证 / OPA egress）+ 限速 + 熔断 + PII 脱敏 + 审计。
// 所有外部调用都从这里出去，杜绝组件直连外部系统。
//
// 启动：connector-gateway -pg <dsn> -redis <addr> -listen :8082
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/lumo-harness/platform/connector-gateway/internal/approval"
	"github.com/lumo-harness/platform/connector-gateway/internal/audit"
	"github.com/lumo-harness/platform/connector-gateway/internal/breaker"
	"github.com/lumo-harness/platform/connector-gateway/internal/credentials"
	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
	"github.com/lumo-harness/platform/connector-gateway/internal/gateway"
	"github.com/lumo-harness/platform/connector-gateway/internal/policy"
	"github.com/lumo-harness/platform/connector-gateway/internal/ratelimit"
	"github.com/lumo-harness/platform/connector-gateway/internal/registry"
	"github.com/lumo-harness/platform/connector-gateway/internal/server"
	"github.com/lumo-harness/platform/observability"
)

// headerAuth 从网关注入的头解析身份（与协作服务同一约定）。
//
// 生产形态：边缘/终端网关完成认证后注入这些头，下游链路走 mTLS；
// 本服务不自行签发凭证，也不信任客户端自报的 realm/roles —— 那些头必须由
// 网关覆写，网关之外的来源应被网络层挡在门外。
type headerAuth struct{}

func (headerAuth) Authenticate(r *http.Request) (domain.Caller, error) {
	uid := r.Header.Get("X-Lumo-User")
	realm := r.Header.Get("X-Lumo-Realm")
	if uid == "" || realm == "" {
		return domain.Caller{}, errors.New("缺少网关注入的身份头")
	}
	return domain.Caller{
		UserID:    uid,
		Realm:     domain.RealmID(realm),
		Roles:     splitCSV(r.Header.Get("X-Lumo-Roles")),
		SessionID: r.Header.Get("X-Lumo-Session"),
		ProjectID: r.Header.Get("X-Lumo-Project"),
		// 审批结论只来自本服务消费的一次性审批记录，不能由调用方请求头自报。
		Approved: false,
		// 计量归因元数据头：可空 —— 缺省在网关 buildMeter 处补（'unknown'/'system' + 告警），
		// 而不是在这里 400。理由：既有 TS 客户端今天只发 User/Realm/Roles/Project 已在跑，
		// 把归因改成必填会立刻打破现有链路。
		DeptID:      r.Header.Get("X-Lumo-Dept"),
		Role:        r.Header.Get("X-Lumo-Role"),
		AgentID:     r.Header.Get("X-Lumo-Agent"),
		ComponentID: r.Header.Get("X-Lumo-Component"),
		Feature:     r.Header.Get("X-Lumo-Feature"),
		TraceID:     r.Header.Get("X-Lumo-Trace"),
	}, nil
}

func main() {
	var (
		pgDSN      = flag.String("pg", envOr("LUMO_PG_DSN", "postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN")
		redisAddr  = flag.String("redis", envOr("LUMO_REDIS_ADDR", "localhost:56379"), "Redis 地址（限流令牌桶）")
		listen     = flag.String("listen", envOr("LUMO_LISTEN", ":8082"), "HTTP 监听地址")
		credPrefix = flag.String("cred-prefix", envOr("LUMO_CRED_PREFIX", "LUMO_CRED_"), "Local-lite 凭证环境变量前缀")
		adminRoles = flag.String("admin-roles", envOr("LUMO_ADMIN_ROLES", "admin"), "可注册/停用连接器的角色（逗号分隔）")
		failOpen   = flag.Bool("limiter-fail-open", envOr("LUMO_LIMITER_FAIL_OPEN", "") == "true",
			"限流器不可用时放行（默认拒绝）")

		// ── 通用 web 出站（POST /web/fetch）──
		webRPM    = flag.Int("web-rpm", envOrInt("LUMO_WEB_RPM", 60), "web 出站每用户每分钟配额（0=不限）")
		webBurst  = flag.Int("web-burst", envOrInt("LUMO_WEB_BURST", 10), "web 出站突发配额")
		webMaxRes = flag.Int64("web-max-resp-bytes", envOrInt64("LUMO_WEB_MAX_RESP_BYTES", 8<<20), "web 出站响应上限（≤0 用 8MiB）")
		webPriv   = flag.Bool("web-allow-private", envOr("LUMO_WEB_ALLOW_PRIVATE", "") == "true",
			"web 出站允许内网/环回目标（默认 false=仅公网）")
		webNoRedact = flag.Bool("web-no-redact", envOr("LUMO_WEB_NO_REDACT", "") == "true",
			"关闭 web 响应 PII 脱敏（默认开）")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	shutdownOTel, telemetryErr := observability.ConfigureOTelFromEnv(ctx, "lumo-connector-gateway")
	if telemetryErr != nil {
		log.Error("invalid OpenTelemetry configuration", "err", telemetryErr)
		os.Exit(2)
	}

	pool, err := pgxpool.New(ctx, *pgDSN)
	if err != nil {
		log.Error("连接 PostgreSQL 失败", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	rdb := redis.NewClient(&redis.Options{Addr: *redisAddr})
	defer rdb.Close()
	if err := rdb.Ping(ctx).Err(); err != nil {
		// 限流是闸门不是装饰：Redis 不通就不该启动，否则等于裸奔
		log.Error("连接 Redis 失败（限流不可用，拒绝启动）", "addr", *redisAddr, "err", err)
		os.Exit(1)
	}

	reg := registry.NewPg(pool, 10*time.Second)
	if err := reg.Init(ctx); err != nil {
		log.Error("初始化连接器目录失败", "err", err)
		os.Exit(1)
	}
	sink := audit.NewPg(pool)
	if err := sink.Init(ctx); err != nil {
		log.Error("初始化审计表失败", "err", err)
		os.Exit(1)
	}
	approvals := approval.NewPg(pool)
	if err := approvals.Init(ctx); err != nil {
		log.Error("初始化连接器审批存储失败", "err", err)
		os.Exit(1)
	}

	var credStore credentials.Store = credentials.NewEnvStore(*credPrefix)
	if vaultAddr := os.Getenv("LUMO_VAULT_ADDR"); vaultAddr != "" {
		credStore = credentials.NewVaultStore(vaultAddr, os.Getenv("LUMO_VAULT_TOKEN"))
		log.Info("启用 Vault 凭证存储")
	}
	creds := credentials.NewCaching(credStore, 60*time.Second)
	brk := breaker.NewGroup(breaker.DefaultConfig())
	policyImpl := policy.Policy(policy.DefaultRules())
	if opaAddr := os.Getenv("LUMO_OPA_ADDR"); opaAddr != "" {
		policyImpl = policy.NewOPAClient(opaAddr, os.Getenv("LUMO_OPA_POLICY"))
		log.Info("启用 OPA 策略存储")
	}

	gw := gateway.New(gateway.Options{
		Registry: reg,
		Creds:    creds,
		Policy:   policyImpl,
		Limiter:  ratelimit.New(rdb),
		Breakers: brk,
		Audit:    sink,
		Logger:   log,
	})
	gw.FailOpenOnLimiterError = *failOpen

	// web 出站配置：缺省值从 DefaultWebEgress() 来（响应脱敏默认开），
	// 命令行/环境变量只能显式覆盖 —— server 是配置汇合点，下发给网关。
	webEgress := domain.DefaultWebEgress()
	webEgress.RequestsPerMinute = *webRPM
	webEgress.Burst = *webBurst
	webEgress.MaxResponseBytes = *webMaxRes
	webEgress.AllowPrivateNetwork = *webPriv
	if *webNoRedact {
		webEgress.RedactResponse = false
	}

	srv := &http.Server{
		Addr: *listen,
		Handler: observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(server.New(server.Options{
			Gateway:    gw,
			Registry:   reg,
			Approvals:  approvals,
			Breakers:   brk,
			Auth:       headerAuth{},
			Logger:     log,
			AdminRoles: splitCSV(*adminRoles),
			WebEgress:  webEgress,
		}).Routes())),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("连接器网关启动", "listen", *listen,
			"credentials", "env:"+*credPrefix, "limiterFailOpen", *failOpen,
			"webEgress", fmt.Sprintf("rpm=%d burst=%d maxResp=%d allowPrivate=%t redact=%t",
				webEgress.RequestsPerMinute, webEgress.Burst, webEgress.MaxResponseBytes,
				webEgress.AllowPrivateNetwork, webEgress.RedactResponse))
		log.Warn("当前为 Local-lite 形态：凭证读环境变量、策略走进程内规则",
			"remedy", "Standalone+ 换 Vault Store 与 OPA Policy 实现同一接口（architecture §13.2）")
		if err := observability.Serve(srv); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("HTTP 服务异常退出", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("收到停机信号，开始优雅关闭")
	shutCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		log.Error("关闭 HTTP 服务失败", "err", err)
	}
	if err := shutdownOTel(shutCtx); err != nil {
		log.Warn("flush OpenTelemetry failed", "err", err)
	}
	log.Info("连接器网关已停止")
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

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envOrInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func envOrInt64(key string, fallback int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return fallback
}
