// Command projects 是项目工作区服务（§11.1 首切片：项目实体/生命周期/成员角色/
// 并行预算树种子/用量聚合——N3 拍板 B 的治理面）。
//
// 装配：身份由边缘/终端网关注入（X-Lumo-User / X-Lumo-Realm）；预算执法不在本
// 服务——双树同事务扣减在 TS 侧 metering commit()（既成事实已测），本服务只负责
// 项目树的存在（创建即种子 budget_trees kind='project' 行）。
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

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/projects/internal/server"
	"github.com/lumo-harness/platform/projects/internal/store"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envOrInt(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func main() {
	var (
		pgDSN  = flag.String("pg", envOr("LUMO_PG_DSN", "postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN")
		listen = flag.String("listen", envOr("LUMO_LISTEN", ":8086"), "HTTP 监听地址")
		defBud = flag.Int64("default-budget", envOrInt("LUMO_PROJECT_DEFAULT_BUDGET", 1_000_000_000), "新项目预算种子（缺省视为不限额）")
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

	st := store.New(pool, *defBud)
	if err := st.Init(ctx); err != nil {
		log.Error("初始化失败", "err", err)
		os.Exit(1)
	}

	srv := server.New(st, log)
	mux := http.NewServeMux()
	srv.Register(mux)

	log.Info("projects 启动", "addr", *listen)
	if err := http.ListenAndServe(*listen, mux); err != nil {
		log.Error("退出", "err", err)
		os.Exit(1)
	}
}
