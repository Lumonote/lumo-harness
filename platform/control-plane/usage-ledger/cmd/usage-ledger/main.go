// usage-ledger：计量台账 RocketMQ 传输（§6.4 异步削峰的 Standalone+/Cluster 形态）。
//
// 两个互斥装配（设计说明 2026-08-26 §2）：
//   - Local-lite：TS 侧 drainOnce 直搬（无 RocketMQ）；
//   - Standalone+/Cluster：本服务——publisher（outbox → RocketMQ）+
//     consumer（RocketMQ → usage_ledger，幂等键兜底至少一次投递）。
//
// 装配约束（实测，2026-08-26）：
//   - producer 必须以全闭集 topic 构造（WithTopics）——零 topic 的生产者永远卡在
//     sync settings；
//   - 6 个 usage-events-* topic 必须先于本服务存在（部署期 mqadmin 预建，
//     autoCreateTopicEnable 只救发送不救启动期路由查询）。
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	rmq "github.com/apache/rocketmq-clients/golang/v5"
	"github.com/apache/rocketmq-clients/golang/v5/credentials"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/heartbeat"
	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/usage-ledger/internal/analytics"
	"github.com/lumo-harness/platform/usage-ledger/internal/ledger"
	"github.com/lumo-harness/platform/usage-ledger/internal/rmqconsume"
	"github.com/lumo-harness/platform/usage-ledger/internal/rmqpublish"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if _, err := observability.ConfigureOTelFromEnv(ctx, "lumo-usage-ledger"); err != nil {
		log.Error("invalid OpenTelemetry configuration", "err", err)
		os.Exit(2)
	}

	dsn := os.Getenv("LUMO_PG_DSN")
	if dsn == "" {
		log.Error("缺 LUMO_PG_DSN")
		os.Exit(1)
	}
	endpoint := envOr("LUMO_RMQ_ENDPOINT", "127.0.0.1:8081")
	group := envOr("LUMO_RMQ_GROUP", "usage-ledger")
	prefix := envOr("LUMO_TOPIC_PREFIX", rmqpublish.TopicPrefixDefault)
	rmq.EnableSsl = envOr("LUMO_RMQ_SSL", "false") == "true" // 本地 proxy TLS permissive；生产随 helm

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Error("PG 连接失败", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	if err := ledger.Init(ctx, pool); err != nil {
		log.Error("台账初始化失败", "err", err)
		os.Exit(1)
	}

	topics, err := rmqpublish.Topics(prefix)
	if err != nil {
		log.Error("闭集 topic 构造失败", "err", err)
		os.Exit(1)
	}
	producer, err := rmq.NewProducer(&rmq.Config{
		Endpoint:    endpoint,
		Credentials: &credentials.SessionCredentials{AccessKey: envOr("LUMO_RMQ_AK", ""), AccessSecret: envOr("LUMO_RMQ_SK", "")},
	}, rmq.WithTopics(topics...))
	if err != nil {
		log.Error("producer 构造失败", "err", err)
		os.Exit(1)
	}
	if err := producer.Start(); err != nil {
		log.Error("producer 启动失败（usage-events-* topic 未预建？）", "err", err)
		os.Exit(1)
	}
	defer producer.GracefulStop()

	subs, err := rmqconsume.SubscriptionExpressions(prefix)
	if err != nil {
		log.Error("订阅构造失败", "err", err)
		os.Exit(1)
	}
	sc, err := rmq.NewSimpleConsumer(&rmq.Config{
		Endpoint:      endpoint,
		ConsumerGroup: group,
		Credentials:   &credentials.SessionCredentials{AccessKey: envOr("LUMO_RMQ_AK", ""), AccessSecret: envOr("LUMO_RMQ_SK", "")},
	},
		rmq.WithSimpleAwaitDuration(5*time.Second),
		rmq.WithSimpleSubscriptionExpressions(subs),
	)
	if err != nil {
		log.Error("consumer 构造失败", "err", err)
		os.Exit(1)
	}
	if err := sc.Start(); err != nil {
		log.Error("consumer 启动失败", "err", err)
		os.Exit(1)
	}
	defer sc.GracefulStop()

	// 双 goroutine 全开（Standalone 最小形态）；Cluster 由同镜像多实例按消费组
	// 拆分——SKIP LOCKED 保证多 publisher 不重发（重了也有幂等兜底）。
	go func() {
		if err := rmqpublish.New(pool, producer, prefix, log).Run(ctx, 0); err != nil {
			log.Info("publisher 退出", "err", err)
		}
	}()
	go func() {
		if err := rmqconsume.New(pool, sc, log).Run(ctx); err != nil {
			log.Info("consumer 退出", "err", err)
		}
	}()

	// 用量查询面（A5）：只读 PG 台账。
	//
	// 曾经设想的是「PG → 列存 cube → 查询」三段式，已移除：它要求额外组件、一个投影
	// worker 与位点，还引入了一类只能靠约定维持的一致性（重放不得双计），而收益只是
	// 把一次分组下推。台账是 append-only 的权威表，日聚合直接分组即可。
	analyticsService, err := analytics.NewService(analytics.NewPgSource(pool))
	if err != nil {
		log.Error("用量查询服务构造失败", "err", err)
		os.Exit(2)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /metrics", observability.Handler)
	mux.Handle("GET /v1/usage/aggregate", analyticsService.AggregateHandler())
	// 仪表化积压（§20/§21 已立指标）：outbox 未发布数。发布后未消费的积压在
	// broker 侧，不在 PG 可见——此处是 publisher 侧的天花板告警口径。
	mux.HandleFunc("GET /v1/metrics/pending", func(w http.ResponseWriter, r *http.Request) {
		var pending int64
		if err := pool.QueryRow(r.Context(),
			`SELECT count(*) FROM usage_event_outbox WHERE published_at IS NULL`).Scan(&pending); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"pending_unpublished":%d}`, pending)
	})

	// 心跳上报：集群就绪态由心跳新鲜度与自报依赖派生（E4/D6），不再只看
	// LUMO_CLUSTER_STATUS 这个静态声明。放在初始化之后，避免服务尚不可用就报 ready。
	heartbeat.StartPg(ctx, pool, heartbeat.Options{Service: "usage-ledger", Logger: log, Depends: heartbeat.PgDependency(pool)})

	addr := envOr("LUMO_LISTEN", ":8085")
	log.Info("usage-ledger 启动", "addr", addr, "rmq", endpoint, "group", group, "topics", len(topics))
	httpSrv := &http.Server{Addr: addr, Handler: observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(mux)), ReadHeaderTimeout: 10 * time.Second}
	if err := observability.Serve(httpSrv); err != nil {
		log.Error("退出", "err", err)
		os.Exit(1)
	}
}
