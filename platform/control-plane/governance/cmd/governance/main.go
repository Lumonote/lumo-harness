// Command governance runs the Cluster-only organization, skill, and desktop
// node control plane.
//
// The management surface is fail-closed. It opens only when the deployment is
// explicitly a cluster, the operator explicitly declared it ready, and the
// derived readiness from service heartbeats actually holds. A declaration alone
// is not enough: it used to be, which meant a cluster whose scheduler had died
// kept serving its management APIs.
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

	authcrypto "github.com/lumo-harness/platform/governance/internal/auth"
	"github.com/lumo-harness/platform/governance/internal/device"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/readiness"
	"github.com/lumo-harness/platform/governance/internal/server"
	"github.com/lumo-harness/platform/governance/internal/store"
	"github.com/lumo-harness/platform/heartbeat"
	"github.com/lumo-harness/platform/observability"
)

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil || value < 1 {
		return fallback
	}
	return value
}

func envSeconds(key string, fallback int) time.Duration {
	return time.Duration(envInt(key, fallback)) * time.Second
}

func envBool(key string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean: %w", key, err)
	}
	return value, nil
}

func main() {
	modeDefault := strings.ToLower(envOr("LUMO_DEPLOYMENT_MODE", "standalone"))
	statusDefault := envOr("LUMO_CLUSTER_STATUS", "not_ready")
	pgDSN := flag.String("pg", envOr("LUMO_PG_DSN", "postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN")
	listen := flag.String("listen", envOr("LUMO_LISTEN", ":8089"), "HTTP listen address")
	deploymentMode := flag.String("deployment-mode", modeDefault, "local | standalone | cluster")
	clusterStatus := flag.String("cluster-status", statusDefault, "ready enables cluster-only APIs")
	flag.Parse()

	mode := domain.DeploymentMode(*deploymentMode)
	if mode != domain.ModeLocal && mode != domain.ModeStandalone && mode != domain.ModeCluster {
		slog.Error("unsupported deployment mode", "mode", mode)
		os.Exit(2)
	}
	requireUV, err := envBool("LUMO_AUTH_WEBAUTHN_REQUIRE_USER_VERIFICATION", true)
	if err != nil {
		slog.Error("invalid WebAuthn configuration", "err", err)
		os.Exit(2)
	}
	origins := []string{}
	if rawOrigins := strings.TrimSpace(os.Getenv("LUMO_AUTH_WEBAUTHN_ORIGINS")); rawOrigins != "" {
		origins = strings.Split(rawOrigins, ",")
	}
	webauthnConfig, err := authcrypto.NewWebAuthnConfig(
		os.Getenv("LUMO_AUTH_WEBAUTHN_RP_ID"),
		os.Getenv("LUMO_AUTH_WEBAUTHN_RP_NAME"),
		origins,
		requireUV,
	)
	if err != nil {
		slog.Error("invalid WebAuthn configuration", "err", err)
		os.Exit(2)
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	oidcSignup, err := envBool("LUMO_AUTH_OIDC_ALLOW_SIGNUP", false)
	if err != nil {
		log.Error("invalid OIDC configuration", "err", err)
		os.Exit(2)
	}
	oidcLoopback, err := envBool("LUMO_AUTH_OIDC_ALLOW_LOOPBACK_HTTP", false)
	if err != nil {
		log.Error("invalid OIDC configuration", "err", err)
		os.Exit(2)
	}
	oidcConfig := authcrypto.OIDCConfig{
		Issuer: os.Getenv("LUMO_AUTH_OIDC_ISSUER"), ClientID: os.Getenv("LUMO_AUTH_OIDC_CLIENT_ID"),
		ClientSecret: os.Getenv("LUMO_AUTH_OIDC_CLIENT_SECRET"), RedirectURL: os.Getenv("LUMO_AUTH_OIDC_REDIRECT_URL"),
		Realm: os.Getenv("LUMO_AUTH_OIDC_REALM"), DepartmentClaim: os.Getenv("LUMO_AUTH_OIDC_DEPARTMENT_CLAIM"),
		DefaultDepartment: os.Getenv("LUMO_AUTH_OIDC_DEFAULT_DEPARTMENT"), AllowSignup: oidcSignup, AllowLoopbackHTTP: oidcLoopback,
	}
	if err := oidcConfig.Validate(); err != nil {
		log.Error("invalid OIDC configuration", "err", err)
		os.Exit(2)
	}
	if oidcConfig.Enabled() && mode != domain.ModeCluster {
		log.Error("OIDC requires cluster deployment mode")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if _, err := observability.ConfigureOTelFromEnv(ctx, "lumo-governance"); err != nil {
		log.Error("invalid OpenTelemetry configuration", "err", err)
		os.Exit(2)
	}

	pool, err := pgxpool.New(ctx, *pgDSN)
	if err != nil {
		log.Error("connect PostgreSQL", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	st := store.New(pool)
	if err := st.Init(ctx); err != nil {
		log.Error("initialize governance", "err", err)
		os.Exit(1)
	}
	// The readiness watcher runs regardless of the declared mode. Readiness is
	// what an operator checks *before* declaring LUMO_CLUSTER_STATUS=ready, so
	// gating the watcher on that declaration would remove the ability to look.
	requiredServices, err := heartbeat.ParseRequiredServices(os.Getenv("LUMO_REQUIRED_SERVICES"))
	if err != nil {
		log.Error("invalid required service set", "err", err)
		os.Exit(2)
	}
	watcher := heartbeat.NewWatcher(pool, heartbeat.WatcherOptions{
		Required: requiredServices,
		MaxAge:   envSeconds("LUMO_HEARTBEAT_MAX_AGE_SECONDS", 45),
		Refresh:  envSeconds("LUMO_HEARTBEAT_REFRESH_SECONDS", 10),
		Logger:   log,
	})
	// Evaluate before serving, so the startup log states what the cluster is
	// rather than what an empty cache defaults to.
	watcher.RefreshOnce(ctx)
	readinessSource := readiness.New(watcher)
	go watcher.Run(ctx)
	go heartbeat.PruneLoop(ctx, pool, envSeconds("LUMO_HEARTBEAT_PRUNE_SECONDS", 600), 0, log)

	bootstrapUsername := strings.TrimSpace(os.Getenv("LUMO_AUTH_BOOTSTRAP_USERNAME"))
	bootstrapPassword := os.Getenv("LUMO_AUTH_BOOTSTRAP_PASSWORD")
	if (bootstrapUsername == "") != (bootstrapPassword == "") {
		log.Error("bootstrap authentication requires both username and password")
		os.Exit(2)
	}
	if bootstrapUsername != "" {
		bootstrapUserID := envOr("LUMO_AUTH_BOOTSTRAP_USER_ID", bootstrapUsername)
		if err := st.EnsureBootstrapAuthUser(ctx, store.BootstrapAuthUser{
			Realm:       envOr("LUMO_AUTH_BOOTSTRAP_REALM", "dev"),
			UserID:      bootstrapUserID,
			Username:    bootstrapUsername,
			Password:    bootstrapPassword,
			DisplayName: envOr("LUMO_AUTH_BOOTSTRAP_DISPLAY_NAME", bootstrapUsername),
			Department:  envOr("LUMO_AUTH_BOOTSTRAP_DEPARTMENT", "platform"),
			Roles:       strings.Split(envOr("LUMO_AUTH_BOOTSTRAP_ROLES", "platform_admin,operator"), ","),
		}); err != nil {
			log.Error("initialize bootstrap user", "err", err)
			os.Exit(1)
		}
		log.Info("bootstrap user ready", "realm", envOr("LUMO_AUTH_BOOTSTRAP_REALM", "dev"), "user_id", bootstrapUserID)
	}

	var deviceGateway *device.Gateway
	if os.Getenv("LUMO_DESKTOP_GATEWAY_ENABLED") == "true" {
		// The desktop gateway is a cluster-only component, so its startup check is
		// a configuration check against the declared intent. Per-request access is
		// still gated on derived health by the server.
		if !domain.IntentIsCluster(mode, *clusterStatus) {
			log.Error("desktop gateway requires Cluster ready")
			os.Exit(2)
		}
		deviceGateway, err = device.New(device.Options{Store: st, Listen: envOr("LUMO_DESKTOP_GATEWAY_LISTEN", ":8090"), PublicURL: os.Getenv("LUMO_DESKTOP_GATEWAY_PUBLIC_URL"),
			RegistryURL: os.Getenv("LUMO_REGISTRY_URL"), ControlToken: os.Getenv("LUMO_CONTROL_PLANE_TOKEN"), ServerCertFile: os.Getenv("LUMO_DESKTOP_GATEWAY_CERT_FILE"), ServerKeyFile: os.Getenv("LUMO_DESKTOP_GATEWAY_KEY_FILE"),
			IssuerCertFile: os.Getenv("LUMO_DESKTOP_ISSUER_CERT_FILE"), IssuerKeyFile: os.Getenv("LUMO_DESKTOP_ISSUER_KEY_FILE"), AllowedScopes: strings.Split(envOr("LUMO_DESKTOP_ALLOWED_SCOPES", "skills:use,kb:query"), ","),
			ProcessRuntime: os.Getenv("LUMO_DESKTOP_PROCESS_RUNTIME") == "true", PolicyURL: os.Getenv("LUMO_DESKTOP_POLICY_URL")})
		if err != nil {
			log.Error("invalid desktop gateway configuration", "err", err)
			os.Exit(2)
		}
		go func() {
			if err := deviceGateway.Serve(ctx); err != nil {
				log.Error("desktop gateway stopped", "err", err)
				stop()
			}
		}()
	}
	// 心跳上报：governance 既是就绪态的使用者，也是必需服务清单里的一项，
	// 所以它自己也要上报 —— 否则它会把自己算成缺失，集群永远不就绪。
	heartbeat.StartPg(ctx, pool, heartbeat.Options{
		Service: "governance", Logger: log, Depends: heartbeat.PgDependency(pool),
	})

	srv, err := server.New(st, server.Config{
		DeploymentMode:    mode,
		ClusterStatus:     *clusterStatus,
		Health:            readinessSource,
		SchedulerURL:      envOr("LUMO_SCHEDULER_URL", ""),
		ClusterID:         envOr("LUMO_CLUSTER_ID", ""),
		ControlPlaneToken: os.Getenv("LUMO_CONTROL_PLANE_TOKEN"),
		AuthMaxAttempts:   envInt("LUMO_AUTH_MAX_ATTEMPTS", 5),
		AuthLockFor:       envSeconds("LUMO_AUTH_LOCK_SECONDS", 300),
		AuthSessionTTL:    envSeconds("LUMO_AUTH_SESSION_TTL_SECONDS", 86400),
		AuthCaptchaTTL:    envSeconds("LUMO_AUTH_CAPTCHA_TTL_SECONDS", 120),
		AuthMFAKey:        os.Getenv("LUMO_AUTH_MFA_KEY"),
		WebAuthn:          webauthnConfig,
		OIDC:              oidcConfig,
		DeviceGateway:     deviceGateway,
	}, log)
	if err != nil {
		log.Error("initialize governance server", "err", err)
		os.Exit(2)
	}
	mux := http.NewServeMux()
	srv.Register(mux)
	schedulingCtx, cancelScheduling := context.WithCancel(ctx)
	schedulingDone := make(chan struct{})
	go func() { defer close(schedulingDone); srv.RunScheduling(schedulingCtx) }()
	defer func() { cancelScheduling(); <-schedulingDone }()
	// Log the resolved gate, not the declaration: "cluster_status=ready" in the
	// logs must mean the management surface is actually open.
	gate := domain.ResolveGate(mode, *clusterStatus, readinessSource.Health())
	log.Info("governance started", "addr", *listen, "deployment_mode", mode,
		"cluster_status_declared", gate.Intent, "cluster_status", gate.Effective,
		"cluster_ready", gate.Ready, "cluster_not_ready_reason", gate.Reason,
		"cluster_unready_services", gate.Unready)
	httpSrv := &http.Server{Addr: *listen, Handler: observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(mux)), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdown)
	}()
	if err := observability.Serve(httpSrv); err != nil {
		if errors.Is(err, http.ErrServerClosed) {
			return
		}
		log.Error("governance stopped", "err", err)
		os.Exit(1)
	}
}
