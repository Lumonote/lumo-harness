// Command governance runs the Cluster-only organization, skill, and desktop
// node control plane. It starts in fail-closed mode unless deployment_mode is
// explicitly cluster and cluster_status is explicitly ready.
package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"

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
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

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

	srv := server.New(st, server.Config{DeploymentMode: mode, ClusterStatus: *clusterStatus}, log)
	mux := http.NewServeMux()
	srv.Register(mux)
	log.Info("governance started", "addr", *listen, "deployment_mode", mode, "cluster_status", *clusterStatus)
	if err := http.ListenAndServe(*listen, observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(mux))); err != nil {
		log.Error("governance stopped", "err", err)
		os.Exit(1)
	}
}
