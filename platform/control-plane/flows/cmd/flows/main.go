// Command flows 是第五类制品（用户自定义流程）服务（§11 后半：制品层——生命周期/
// FlowReview/定向分发/版本回滚；执行由 FlowEngine 提供最小 DAG 运行面。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/engine"
	"github.com/lumo-harness/platform/flows/internal/server"
	"github.com/lumo-harness/platform/flows/internal/store"
	"github.com/lumo-harness/platform/flows/internal/trigger"
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
	flowEngine := engine.New()
	bus.Subscribe("*", func(runCtx context.Context, event trigger.Event) error {
		bindings, err := st.ListEventBindings(runCtx, event.Realm, event.Name)
		if err != nil {
			return err
		}
		for _, binding := range bindings {
			definition, version, err := st.DefinitionSnapshot(runCtx, binding.FlowID, event.Realm)
			if err != nil {
				return err
			}
			var def domain.Definition
			if err := json.Unmarshal(definition, &def); err != nil {
				return err
			}
			shouldRun, err := st.StartTriggerRun(runCtx, event.ID, binding.AutomationID, binding.FlowID, version)
			if err != nil {
				return err
			}
			if !shouldRun {
				continue
			}
			result, err := flowEngine.Run(runCtx, &def, event.Payload)
			if err != nil {
				_ = st.FinishTriggerRun(runCtx, event.ID, binding.AutomationID, "failed", nil, err)
				return fmt.Errorf("automation %s: %w", binding.AutomationID, err)
			}
			output, err := json.Marshal(result)
			if err != nil {
				return err
			}
			if err := st.FinishTriggerRun(runCtx, event.ID, binding.AutomationID, "succeeded", output, nil); err != nil {
				return err
			}
			log.Info("flow trigger executed", "trigger_id", event.ID, "automation_id", binding.AutomationID, "flow_id", binding.FlowID, "event", event.Name)
		}
		return nil
	})
	worker := trigger.NewWorker(st, bus, envOr("LUMO_FLOW_WORKER_ID", "flows-worker"))
	worker.SetErrorHandler(func(err error) { log.Error("flow trigger worker error", "err", err) })
	go worker.Run(ctx)

	mux := http.NewServeMux()
	server.New(st, log).Register(mux)

	log.Info("flows 启动", "addr", *listen)
	if err := http.ListenAndServe(*listen, observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(mux))); err != nil {
		log.Error("退出", "err", err)
		os.Exit(1)
	}
}
