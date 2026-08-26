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
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/llm-gateway/internal/gateway"
	"github.com/lumo-harness/platform/llm-gateway/internal/server"
	"github.com/lumo-harness/platform/llm-gateway/internal/store"
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
		listen = flag.String("listen", envOr("LUMO_LISTEN", ":8088"), "HTTP 监听地址")
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

	client := &http.Client{Timeout: 10 * time.Minute} // 流式长连接：总时长上限
	gw := gateway.New(client, func(format string, args ...any) {
		log.Warn("网关告警: "+format, args...)
	})
	srv := server.New(st, gw, log)

	mux := http.NewServeMux()
	srv.Register(mux)

	log.Info("llm-gateway 启动", "addr", *listen)
	if err := http.ListenAndServe(*listen, mux); err != nil {
		log.Error("退出", "err", err)
		os.Exit(1)
	}
}
