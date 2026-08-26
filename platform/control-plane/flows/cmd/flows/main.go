// Command flows 是第五类制品（用户自定义流程）服务（§11 后半：制品层——生命周期/
// FlowReview/定向分发/版本回滚；执行是 FlowEngine，P2）。
package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/flows/internal/server"
	"github.com/lumo-harness/platform/flows/internal/store"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	var (
		pgDSN  = flag.String("pg", envOr("LUMO_PG_DSN", "postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN")
		listen = flag.String("listen", envOr("LUMO_LISTEN", ":8087"), "HTTP 监听地址")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

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

	mux := http.NewServeMux()
	server.New(st, log).Register(mux)

	log.Info("flows 启动", "addr", *listen)
	if err := http.ListenAndServe(*listen, mux); err != nil {
		log.Error("退出", "err", err)
		os.Exit(1)
	}
}
