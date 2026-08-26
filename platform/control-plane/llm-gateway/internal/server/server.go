// Package server LLM 网关 HTTP 接入面（设计说明 §4 请求生命周期）。
//
// 归因头：X-Lumo-User/Realm/Dept/Role/Project 必填（缺 400——归因不完整的账是脏账，
// 宁可拒）；Agent/Component/Feature/Session/Trace 可选带缺省。reserve 在转发前
// （TTFT 预算不含执法时间？含——执法是同步前置，§21.1 的 p50 预算覆盖它）。
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/lumo-harness/platform/llm-gateway/internal/domain"
	"github.com/lumo-harness/platform/llm-gateway/internal/gateway"
	"github.com/lumo-harness/platform/llm-gateway/internal/store"
)

// Emitter 计量事件发出方标识（§6.4：发出方命名显式化）。
const Emitter = "llm-gateway"

type Server struct {
	store *store.Store
	gw    *gateway.Gateway
	log   *slog.Logger
}

func New(st *store.Store, gw *gateway.Gateway, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{store: st, gw: gw, log: log}
}

func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/chat/completions", s.chat)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
}

// attribution 归因解析：必填五头缺一 400（带缺哪个——调用方能自修）；可选五头带
// 网关缺省（trace 缺省网关铸——截面处的请求必须可追溯）。
func attribution(r *http.Request) (domain.Attribution, string, bool) {
	required := map[string]string{
		"X-Lumo-User":    r.Header.Get("X-Lumo-User"),
		"X-Lumo-Dept":    r.Header.Get("X-Lumo-Dept"),
		"X-Lumo-Role":    r.Header.Get("X-Lumo-Role"),
		"X-Lumo-Project": r.Header.Get("X-Lumo-Project"),
	}
	for k, v := range required {
		if v == "" {
			return domain.Attribution{}, k, false
		}
	}
	def := func(k, d string) string {
		if v := r.Header.Get(k); v != "" {
			return v
		}
		return d
	}
	trace := def("X-Lumo-Trace", "")
	if trace == "" {
		b := make([]byte, 8)
		_, _ = rand.Read(b)
		trace = "gw-" + hex.EncodeToString(b)
	}
	a := domain.Attribution{
		UserID:      required["X-Lumo-User"],
		DeptID:      required["X-Lumo-Dept"],
		Role:        required["X-Lumo-Role"],
		ProjectID:   required["X-Lumo-Project"],
		AgentID:     def("X-Lumo-Agent", "system"),
		ComponentID: def("X-Lumo-Component", "llm-gateway"),
		Feature:     def("X-Lumo-Feature", "llm.chat"),
		SessionRef:  def("X-Lumo-Session", "system"),
	}
	return a, trace, true
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": msg})
}

func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Lumo-Realm") == "" {
		writeErr(w, http.StatusUnauthorized, "missing_realm", "X-Lumo-Realm required")
		return
	}
	a, trace, ok := attribution(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "missing_attribution", "required header "+trace+" is empty")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil || len(body) == 0 {
		writeErr(w, http.StatusBadRequest, "invalid_body", "request body required")
		return
	}
	var req struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Model == "" {
		writeErr(w, http.StatusBadRequest, "invalid_body", "model required")
		return
	}

	// ② reserve：双树四态（estimate 未给——OpenAI 请求无先验 token 数，判「余额
	// 是否还有」；大调用的封顶靠事后扣负补救，与 TS 无 estimate 的路径同语义）
	res, err := s.store.Reserve(r.Context(), a, 0)
	if err != nil {
		if isUndefinedTable(err) {
			writeErr(w, http.StatusServiceUnavailable, "metering_not_ready", "budget tables not initialized")
			return
		}
		s.log.Error("reserve 失败", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "reserve failed")
		return
	}
	if !res.Approved {
		// 402 Payment Required：语义就是「钱」，不是权限（403）也不是速率（429）
		writeErr(w, http.StatusPaymentRequired, res.Reason,
			"budget state="+res.State+" (user/project tree)")
		return
	}

	// ③ 路由
	p, err := s.store.Provider(r.Context(), req.Model)
	if err != nil {
		if errors.Is(err, store.ErrUnknownModel) {
			writeErr(w, http.StatusNotFound, "unknown_model", req.Model)
			return
		}
		s.log.Error("路由失败", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "provider lookup failed")
		return
	}

	// ④ 注入 stream_options（流式时）：计量完整性不依赖调用方善意
	if req.Stream {
		var raw map[string]any
		if json.Unmarshal(body, &raw) == nil {
			so, _ := raw["stream_options"].(map[string]any)
			if so == nil {
				so = map[string]any{}
			}
			so["include_usage"] = true
			raw["stream_options"] = so
			if nb, err := json.Marshal(raw); err == nil {
				body = nb
			}
		}
	}

	// ⑥ commit：流结束时一次落账（qty=tokens=input+output；costUsd 按费率）
	up := gateway.Upstream{BaseURL: p.UpstreamBaseURL, APIKey: p.APIKey}
	meter := func(ctx context.Context, usage *domain.Usage, model string) {
		if model == "" {
			model = req.Model
		}
		var tokens, input, output int64
		if usage != nil {
			input, output = usage.PromptTokens, usage.CompletionTokens
			tokens = input + output
			if usage.TotalTokens > tokens {
				tokens = usage.TotalTokens // 上游显式给了 total 以它为准
			}
		}
		cost := (float64(input)*p.PriceInPerMtok + float64(output)*p.PriceOutPerMtok) / 1e6
		e := domain.CostEvent{
			Context:  a,
			CostType: "llm.tokens",
			Qty:      float64(tokens),
			Unit:     "tokens",
			TraceID:  trace,
			Emitter:  Emitter,
			CostUSD:  cost,
			Tokens:   &tokens,
			Model:    model,
		}
		if err := s.store.Commit(ctx, e); err != nil {
			// 计量失败不毁响应（响应已经/即将交给客户端）——但必须响亮告警：
			// 这是账缺口，不是噪音
			s.log.Error("计量落账失败（账缺口！）", "err", err, "trace", trace, "tokens", tokens)
		}
	}

	if req.Stream {
		if err := s.gw.ChatStream(r.Context(), up, body, w, meter); err != nil {
			s.log.Warn("流式转发异常收尾", "err", err, "trace", trace)
		}
		return
	}
	if err := s.gw.Chat(r.Context(), up, body, w, meter); err != nil {
		writeErr(w, http.StatusBadGateway, "upstream_error", err.Error())
	}
}

// isUndefinedTable PG 42P01（metering 表未初始化）。
func isUndefinedTable(err error) bool {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "42P01"
	}
	return false
}
