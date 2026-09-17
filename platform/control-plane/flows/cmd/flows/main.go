// Command flows 是第五类制品（用户自定义流程）服务（§11 后半：制品层——生命周期/
// FlowReview/定向分发/版本回滚；执行由 FlowEngine 提供最小 DAG 运行面。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/engine"
	"github.com/lumo-harness/platform/flows/internal/lineage"
	"github.com/lumo-harness/platform/flows/internal/schedule"
	"github.com/lumo-harness/platform/flows/internal/server"
	"github.com/lumo-harness/platform/flows/internal/store"
	"github.com/lumo-harness/platform/flows/internal/trigger"
	"github.com/lumo-harness/platform/heartbeat"
	"github.com/lumo-harness/platform/observability"
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
	if _, err := observability.ConfigureOTelFromEnv(ctx, "lumo-flows"); err != nil {
		log.Error("invalid OpenTelemetry configuration", "err", err)
		os.Exit(2)
	}

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

	bus := trigger.New()
	flowEngine := engine.New(engine.RuntimeConfig{
		LLMURL: os.Getenv("LUMO_LLM_GATEWAY_URL"), ConnectorURL: os.Getenv("LUMO_CONNECTOR_GATEWAY_URL"),
		KnowledgeURL: os.Getenv("LUMO_KNOWLEDGE_SEAM_URL"), ControlToken: os.Getenv("LUMO_CONTROL_PLANE_TOKEN"),
		IdentitySecret: envOr("LUMO_IDENTITY_ASSERTION_SECRET", os.Getenv("LUMO_CONTROL_PLANE_TOKEN")),
	})
	bus.Subscribe("*", func(runCtx context.Context, event trigger.Event) error {
		bindings, err := st.PrepareTriggerBindings(runCtx, event.ID, event.Realm)
		if err != nil {
			return err
		}
		for _, binding := range bindings {
			// Run the binding snapshot selected at delivery time. In particular, a
			// replay must never drift to a current rollback target or automation edit.
			definition, _, err := st.GetVersion(runCtx, binding.FlowID, binding.FlowVersion)
			if err != nil {
				return err
			}
			var def domain.Definition
			if err := json.Unmarshal(definition, &def); err != nil {
				return err
			}
			shouldRun, err := st.StartTriggerRun(runCtx, event.ID, binding.AutomationID, binding.FlowID, binding.FlowVersion)
			if err != nil {
				return err
			}
			if !shouldRun {
				continue
			}
			identity, identityErr := st.AutomationIdentity(runCtx, event.Realm, binding.FlowID)
			var result *engine.Result
			if identityErr != nil {
				err = identityErr
			} else {
				executionCtx, cancel := context.WithTimeout(runCtx, store.RunTimeout)
				result, err = flowEngine.Run(engine.WithIdentity(executionCtx, identity), &def, event.Payload)
				cancel()
			}
			if err != nil {
				if finishErr := st.FinishTriggerRun(runCtx, event.ID, binding.AutomationID, "failed", nil, err); finishErr != nil {
					return finishErr
				}
				// Execution failure is a terminal ledger entry, not a delivery error.
				// Ack the source event so only an authorized explicit replay creates a
				// new business attempt; continue independent bindings on this event.
				log.Warn("flow trigger failed", "trigger_id", event.ID, "automation_id", binding.AutomationID,
					"flow_id", binding.FlowID, "replay_of_run_id", event.ReplayOfRunID, "err", err)
				continue
			}
			output, err := json.Marshal(result)
			if err != nil {
				return err
			}
			if err := st.FinishTriggerRun(runCtx, event.ID, binding.AutomationID, "succeeded", output, nil); err != nil {
				return err
			}
			log.Info("flow trigger executed", "trigger_id", event.ID, "automation_id", binding.AutomationID,
				"flow_id", binding.FlowID, "event", event.Name, "replay_of_run_id", event.ReplayOfRunID)
		}
		return nil
	})
	worker := trigger.NewWorker(st, bus, envOr("LUMO_FLOW_WORKER_ID", "flows-worker"))
	worker.SetErrorHandler(func(err error) { log.Error("flow trigger worker error", "err", err) })
	go worker.Run(ctx)

	// cron 调度生产者：把 project_automations 里到期的 cron 自动化变成持久触发。
	// 多个副本同时跑是安全的——推进游标用的是 CAS，抢先的赢、后到的什么都不做，
	// 所以不需要选主，也不需要额外的 claim 列。
	cronLocation, cronErr := time.LoadLocation(envOr("LUMO_FLOW_CRON_TZ", "UTC"))
	if cronErr != nil {
		log.Error("LUMO_FLOW_CRON_TZ 不是合法时区", "err", cronErr)
		os.Exit(2)
	}
	producer := schedule.NewProducer(st, cronLocation)
	producer.SetErrorHandler(func(err error) { log.Error("flow cron producer error", "err", err) })
	log.Info("flows cron 调度启动", "default_tz", cronLocation.String())
	go producer.Run(ctx)

	// 血缘投影（缺口 C7）：Nebula 仅作呈现层，未配置时整体关闭——不写 outbox、不起投影器、
	// 启动日志与 /metrics 都说清楚，绝不伪造成功。
	nebulaURL := os.Getenv("LUMO_FLOW_NEBULA_URL")
	if nebulaURL == "" {
		st.SetLineageEnabled(false)
		observability.SetGaugeWithLabels("lumo_flow_lineage_projector_enabled", 0,
			map[string]string{"reason": "nebula_not_configured"})
		log.Warn("flow lineage projector disabled: LUMO_FLOW_NEBULA_URL 未配置；血缘捕获与图投影均未启用",
			"note", "血缘只读查询面将返回明确的「不可用」原因，不会以空列表冒充无血缘")
	} else {
		st.SetLineageEnabled(true)
		observability.SetGaugeWithLabels("lumo_flow_lineage_projector_enabled", 1, nil)
		adapter := lineage.NewHTTPAdapter(nebulaURL, os.Getenv("LUMO_FLOW_NEBULA_API_KEY"))
		projector := lineage.NewProjector(st, adapter, log)
		projector.SetErrorHandler(func(err error) { log.Error("flow lineage projector error", "err", err) })
		go projector.Run(ctx)
		log.Info("flow lineage projector 启动", "nebula", nebulaURL)
	}

	mux := http.NewServeMux()
	server.New(st, log, flowEngine).Register(mux)

	// 心跳上报：集群就绪态由心跳新鲜度与自报依赖派生（E4/D6），不再只看
	// LUMO_CLUSTER_STATUS 这个静态声明。放在初始化之后，避免服务尚不可用就报 ready。
	heartbeat.StartPg(ctx, pool, heartbeat.Options{Service: "flows", Logger: log, Depends: heartbeat.PgDependency(pool)})

	log.Info("flows 启动", "addr", *listen)
	httpSrv := &http.Server{Addr: *listen, Handler: observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(mux)), ReadHeaderTimeout: 10 * time.Second}
	if err := observability.Serve(httpSrv); err != nil {
		log.Error("退出", "err", err)
		os.Exit(1)
	}
}
