// usage-ledger：计量台账 RocketMQ 传输（§6.4 异步削峰的 Standalone+/Cluster 形态）。
//
// 两个互斥装配（设计说明 2026-08-26 §2）：
//   - Local-lite：TS 侧 drainOnce 直搬（无 RocketMQ）；
//   - Standalone+/Cluster：本服务——publisher（outbox → RocketMQ）+
//     consumer（RocketMQ → usage_ledger，幂等键兜底至少一次投递）。
//
// 本入口为最小装配：/healthz + /v1/metrics/pending（Task 3 接 publisher/consumer）。
package main

import (
	"log/slog"
	"net/http"
	"os"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	addr := os.Getenv("LUMO_LISTEN")
	if addr == "" {
		addr = ":8085"
	}
	log.Info("usage-ledger 启动", "addr", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Error("退出", "err", err)
		os.Exit(1)
	}
}
