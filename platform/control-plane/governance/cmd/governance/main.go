// Command governance runs the Cluster-only organization, skill, and desktop
// node control plane. It starts in fail-closed mode unless deployment_mode is
// explicitly cluster and cluster_status is explicitly ready.
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
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	authcrypto "github.com/lumo-harness/platform/governance/internal/auth"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/server"
	"github.com/lumo-harness/platform/governance/internal/store"
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

	srv := server.New(st, server.Config{
		DeploymentMode:    mode,
		ClusterStatus:     *clusterStatus,
		SchedulerURL:      envOr("LUMO_SCHEDULER_URL", ""),
		ClusterID:         envOr("LUMO_CLUSTER_ID", ""),
		ControlPlaneToken: os.Getenv("LUMO_CONTROL_PLANE_TOKEN"),
		AuthMaxAttempts:   envInt("LUMO_AUTH_MAX_ATTEMPTS", 5),
		AuthLockFor:       envSeconds("LUMO_AUTH_LOCK_SECONDS", 300),
		AuthSessionTTL:    envSeconds("LUMO_AUTH_SESSION_TTL_SECONDS", 86400),
		AuthCaptchaTTL:    envSeconds("LUMO_AUTH_CAPTCHA_TTL_SECONDS", 120),
		AuthMFAKey:        os.Getenv("LUMO_AUTH_MFA_KEY"),
		WebAuthn:          webauthnConfig,
	}, log)
	mux := http.NewServeMux()
	srv.Register(mux)
	log.Info("governance started", "addr", *listen, "deployment_mode", mode, "cluster_status", *clusterStatus)
	httpSrv := &http.Server{Addr: *listen, Handler: observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(mux)), ReadHeaderTimeout: 10 * time.Second}
	if err := observability.Serve(httpSrv); err != nil {
		log.Error("governance stopped", "err", err)
		os.Exit(1)
	}
}
