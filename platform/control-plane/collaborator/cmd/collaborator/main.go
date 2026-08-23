// Command collaborator 是知识库文档实时协作服务（§5.4.7）。
//
// 平台唯一的有状态业务服务：内存持活跃 CRDT 文档，WAL 先行保证 RPO 0，
// 归属哈希保证「每个活跃文档由唯一一个实例持有」。
//
// 启动：collaborator -pg <dsn> -redis <addr> -listen :8081 -instance <id>
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/lumo-harness/platform/collaborator/internal/crdt"
	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/hub"
	"github.com/lumo-harness/platform/collaborator/internal/ownership"
	"github.com/lumo-harness/platform/collaborator/internal/server"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

// headerAuth 从网关注入的头解析身份。
//
// 生产形态：边缘/终端网关完成认证后注入这些头，并对下游链路做 mTLS；
// 协作服务不自行签发凭证（§6.3 单一策略点）。
type headerAuth struct{}

func (headerAuth) Authenticate(r *http.Request) (server.Identity, error) {
	uid := r.Header.Get("X-Lumo-User")
	realm := r.Header.Get("X-Lumo-Realm")
	if uid == "" || realm == "" {
		return server.Identity{}, errors.New("缺少网关注入的身份头")
	}
	return server.Identity{
		UserID:  uid,
		Display: r.Header.Get("X-Lumo-Display"),
		Realm:   domain.RealmID(realm),
	}, nil
}

func main() {
	var (
		pgDSN     = flag.String("pg", envOr("LUMO_PG_DSN", "postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN")
		redisAddr = flag.String("redis", envOr("LUMO_REDIS_ADDR", "localhost:56379"), "Redis 地址（WAL 热层）")
		listen    = flag.String("listen", envOr("LUMO_LISTEN", ":8081"), "HTTP 监听地址")
		instance  = flag.String("instance", envOr("LUMO_INSTANCE", "collaborator-0"), "本实例标识（归属哈希用）")
		peers     = flag.String("peers", os.Getenv("LUMO_PEERS"), "实例列表（逗号分隔；生产由 Nacos watch 下发）")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, *pgDSN, *redisAddr)
	if err != nil {
		log.Error("连接存储失败", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	if err := st.Init(ctx); err != nil {
		log.Error("初始化表结构失败", "err", err)
		os.Exit(1)
	}

	limits := domain.DefaultLimits()
	h := hub.New(st, limits)

	ring := ownership.NewRing(*instance)
	if *peers != "" {
		ring.SetInstances(strings.Split(*peers, ","))
	}

	// CRDT 合并内核：FFI 内核就位前用占位实现，并显式告警（不静默降级）
	var merger crdt.Merger = crdt.AppendOnlyMerger{}
	log.Warn("CRDT 合并内核为占位实现，不可用于生产",
		"kernel", merger.Name(),
		"remedy", "接入 y-crdt (Rust) FFI —— 见 architecture §12.3 例外条款")

	srv := &http.Server{
		Addr:              *listen,
		Handler:           server.New(h, st, ring, headerAuth{}, log).Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// 周期任务：快照落库 + 闲置回收
	go func() {
		snapTicker := time.NewTicker(limits.SnapshotInterval)
		evictTicker := time.NewTicker(time.Minute)
		defer snapTicker.Stop()
		defer evictTicker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-snapTicker.C:
				if err := h.Snapshot(ctx, merger.Merge); err != nil {
					log.Error("快照落库失败", "err", err)
				}
			case <-evictTicker.C:
				if n := h.EvictIdle(ctx); n > 0 {
					log.Info("闲置文档回收", "count", n)
				}
			}
		}
	}()

	go func() {
		log.Info("协作服务启动", "listen", *listen, "instance", *instance,
			"maxDocs", limits.MaxDocsPerInstance, "maxEditorsPerDoc", limits.MaxEditorsPerDoc)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("HTTP 服务异常退出", "err", err)
			stop()
		}
	}()

	<-ctx.Done()

	// 优雅停机：先排空（等连接自然结束），再落最终快照，最后关闭
	log.Info("收到停机信号，开始优雅排空")
	drainCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := h.Drain(drainCtx, 25*time.Second); err != nil {
		log.Warn("排空未完成", "err", err)
	}
	if err := h.Snapshot(drainCtx, merger.Merge); err != nil {
		log.Error("最终快照失败", "err", err)
	}
	if err := srv.Shutdown(drainCtx); err != nil {
		log.Error("关闭 HTTP 服务失败", "err", err)
	}
	log.Info("协作服务已停止")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
