// Package server 把 ws / capability / events / presence / policy 五件套装配成一个可运行
// 的终端网关：HTTP 路由（/healthz、/metrics、presence 只读查询）、WebSocket 接入与
// 「replay 历史 + live push」、能力协商、presence 注册、以及 presence 敏感动作的签名+OPA 校验。
//
// 范围边界（§8.4.3）：本网关只做「看 + presence + 能力协商 + replay」，**不实现控制状态机**，
// 也不处理 pause/resume/stop/abort/approve——那是并行开发的 session-control 服务的事。终端发来
// 非敏感的控制指令时，我们只回「本网关不处理」然后忽略，绝不偷偷落地一个状态机。
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/terminal-gateway/internal/capability"
	"github.com/lumo-harness/platform/terminal-gateway/internal/events"
	"github.com/lumo-harness/platform/terminal-gateway/internal/policy"
	"github.com/lumo-harness/platform/terminal-gateway/internal/presence"
	"github.com/lumo-harness/platform/terminal-gateway/internal/ws"
)

const defaultMaxFrame = 1 << 20

// Options 装配网关所需的全部依赖与阈值。
type Options struct {
	// Source 历史事件源，可为 nil（未配置 → WS 接入返回 503，绝不伪造空历史）。
	Source events.EventSource
	// Presence presence 存储；nil 时内部建默认（30s TTL）。
	Presence *presence.Store
	// Auth 敏感动作鉴权器（签名 + OPA）；nil 时任何敏感动作一律拒绝。
	Auth *policy.Authorizer
	// Logger 用于告警/错误日志；nil 回落 slog.Default。
	Logger *slog.Logger
	// MaxFrame 单帧 payload 硬上限（字节）；<=0 回落 1 MiB。
	MaxFrame int
}

// Server 持有依赖并 expose 路由。无内部状态，可并发处理多连接。
type Server struct {
	opts Options
	log  *slog.Logger
}

// New 构造 Server，补默认值。
func New(opts Options) *Server {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.MaxFrame <= 0 {
		opts.MaxFrame = defaultMaxFrame
	}
	if opts.Presence == nil {
		opts.Presence = presence.NewStore(30*time.Second, nil)
	}
	return &Server{opts: opts, log: opts.Logger}
}

// Routes 把路由注册到给定 mux。
func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/metrics", observability.Handler)
	mux.HandleFunc("/v1/terminals/", s.handleTerminal)
}

func (s *Server) handleTerminal(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/terminals/")
	rest = strings.Trim(rest, "/")
	if strings.HasSuffix(rest, "/presence") {
		s.handlePresence(w, strings.TrimSuffix(rest, "/presence"))
		return
	}
	s.handleWS(w, r, rest)
}

// handlePresence 只读查询某会话当前在线的 presence（已过滤过期）。
func (s *Server) handlePresence(w http.ResponseWriter, sessionRef string) {
	entries := s.opts.Presence.Snapshot(sessionRef)
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, map[string]any{
			"session_ref": sessionRef,
			"terminal_id": e.TerminalID,
			"kind":        string(e.Kind),
			"renderers":   e.Renderers,
		})
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{"session_ref": sessionRef, "presence": out})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request, sessionRef string) {
	// 未配置历史事件源 → 诚实 503，绝不伪造空历史让终端以为「这个会话本来就没有事件」
	// （§8.2「未配置真实来源时要诚实」）。
	if s.opts.Source == nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":   "no_event_source",
			"message": "终端网关未配置 session/event 历史源，无法提供 replay；请检查部署接线",
		})
		return
	}
	// 游标：出现且非法 → 400，不让坏游标被静默当成 0。
	cursor := int64(0)
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("cursor 必须是非负整数"))
			return
		}
		cursor = n
	}
	// 先校验握手（失败在劫持之前以 HTTP 错误返回），再劫持。
	if err := ws.ValidateUpgrade(r); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(err.Error()))
		return
	}
	hj, err := ws.Hijack(w, r, s.opts.MaxFrame)
	if err != nil {
		s.log.Error("WebSocket 劫持失败", "session", sessionRef, "err", err)
		return
	}
	s.serveConn(r.Context(), hj, sessionRef, cursor)
}

// serveConn 驱动一条已建立的 WebSocket 连接：读能力声明 → 注册 presence → 回协商结果 →
// replay 历史 → 转 live，并负责读客户端帧（ping/pong、业务消息）。
func (s *Server) serveConn(parent context.Context, hj *ws.Conn, sessionRef string, cursor int64) {
	ctx, cancel := context.WithCancel(parent)
	// defer 顺序（LIFO）：先 cancel 停掉 live 推送 goroutine，再关连接。
	defer cancel()
	defer hj.Close()

	decl, err := s.readCapabilities(hj)
	if err != nil {
		hj.CloseWith("无法解析终端能力声明: " + err.Error())
		return
	}
	terminalID := decl.TerminalID
	// 显式 Leave 只是尽力而为（连接正常关闭时）；即使永远不调用，TTL 也会把过期条目收敛掉。
	defer s.opts.Presence.Leave(sessionRef, terminalID)

	// 注册 presence（带时刻；过期靠 TTL，不靠断开回调）。
	s.opts.Presence.Touch(presence.Entry{
		SessionRef: sessionRef,
		TerminalID: terminalID,
		Kind:       decl.Cap.Kind,
		Renderers:  decl.Cap.Renderers,
	})

	// 回协商结果，让终端知道它会被如何渲染。
	neg, _ := json.Marshal(map[string]any{
		"type":        "capability_negotiated",
		"terminal_id": terminalID,
		"kind":        string(decl.Cap.Kind),
		"renderers":   decl.Cap.Renderers,
	})
	if err := hj.WriteFrame(ws.Frame{OpCode: ws.OpText, Payload: neg}); err != nil {
		return
	}

	// 先 replay 历史（按游标增量），再转 live。两者间存在极小竞态窗口
	// （History 之后、Subscribe 之前追加的事件可能漏掉）；本网关是「看」的视图层，
	// 漏一条不影响正确性——重连 replay 会补回，且这里不做精确去重。
	hist, err := s.opts.Source.History(ctx, sessionRef, cursor)
	if err != nil {
		hj.CloseWith("历史回放失败: " + err.Error())
		return
	}
	for _, ev := range hist {
		if err := s.pushEvent(hj, decl.Cap, ev); err != nil {
			return
		}
	}

	sub, err := s.opts.Source.Subscribe(ctx, sessionRef)
	if err != nil {
		hj.CloseWith("订阅实时事件失败: " + err.Error())
		return
	}
	// 实时推送 goroutine：从 sub 读到就推给客户端。
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-sub:
				if !ok {
					return
				}
				if err := s.pushEvent(hj, decl.Cap, ev); err != nil {
					cancel()
					return
				}
			}
		}
	}()

	// 主循环：处理客户端帧。
	for {
		f, err := hj.ReadFrame()
		if err != nil {
			hj.CloseWith(ws.CloseReason(err))
			return
		}
		switch f.OpCode {
		case ws.OpPing:
			if err := hj.WriteFrame(ws.Frame{OpCode: ws.OpPong, Payload: f.Payload}); err != nil {
				return
			}
		case ws.OpClose:
			return
		case ws.OpText, ws.OpBinary:
			s.handleClientMessage(ctx, hj, f.Payload)
		}
	}
}

// pushEvent 把一个 session 事件推给终端，并按能力协商选出的 renderer 标注投递形态。
// 终端无法渲染该节点时改用 renderer="raw"——仍推原始 payload，让终端自行决定如何呈现，
// 而不是静默丢弃或伪造一个它不认识的形态。
func (s *Server) pushEvent(hj *ws.Conn, cap capability.Capabilities, ev events.Event) error {
	// 本进程所有节点先按「全集」暴露 renderer，协商再按终端收窄（见 capability 包）。
	node := capability.NodeView{Kind: ev.NodeKind, Renderers: []capability.RendererKey{
		capability.RendererChart, capability.RendererTable, capability.RendererCard, capability.RendererJSON,
	}}
	renderer, ok := capability.SelectRenderer(cap, node)
	renderStr := string(renderer)
	if !ok {
		renderStr = "raw"
	}
	payload, err := json.Marshal(map[string]any{
		"type":     "session_event",
		"event":    ev,
		"renderer": renderStr,
	})
	if err != nil {
		return err
	}
	return hj.WriteFrame(ws.Frame{OpCode: ws.OpText, Payload: payload})
}

type clientDecl struct {
	TerminalID string                  `json:"terminal_id"`
	Cap        capability.Capabilities `json:"capabilities"`
}

// readCapabilities 读首帧并解析能力声明。首帧必须是 text 的 JSON 能力声明。
func (s *Server) readCapabilities(hj *ws.Conn) (clientDecl, error) {
	f, err := hj.ReadFrame()
	if err != nil {
		return clientDecl{}, err
	}
	if f.OpCode != ws.OpText {
		return clientDecl{}, errors.New("首帧必须是 text 的能力声明")
	}
	var d clientDecl
	if err := json.Unmarshal(f.Payload, &d); err != nil {
		return clientDecl{}, err
	}
	if d.TerminalID == "" {
		return clientDecl{}, errors.New("缺少 terminal_id")
	}
	if d.Cap.Kind == "" {
		return clientDecl{}, errors.New("缺少终端类型（kind）")
	}
	return d, nil
}

type clientMessage struct {
	Action     string `json:"action"`
	SessionRef string `json:"session_ref"`
	Claimant   string `json:"claimant"`
	Realm      string `json:"realm"`
	Role       string `json:"role"`
	User       string `json:"user"`
	Signature  string `json:"signature"`
}

// handleClientMessage 处理客户端发来的业务消息。
//   - action="claim_control"：presence 相关敏感动作，走签名+OPA 校验（§8.2），结果回写。
//   - 其它/未知 action：本网关只渲染视图、不实现控制状态机（§8.4.3），明确回绝而非静默落地。
func (s *Server) handleClientMessage(ctx context.Context, hj *ws.Conn, body []byte) {
	var msg clientMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		hj.CloseWith("消息 JSON 非法")
		return
	}
	switch msg.Action {
	case "claim_control":
		if s.opts.Auth == nil {
			s.writeJSON(hj, map[string]any{"type": "control_claim_result", "allowed": false, "reason": "鉴权未配置（fail-closed）"})
			return
		}
		claim := policy.ControlClaim{
			SessionRef:    msg.SessionRef,
			Claimant:      msg.Claimant,
			CredentialKey: policy.CredentialKey{Realm: msg.Realm, Role: msg.Role, User: msg.User},
			Signature:     msg.Signature,
		}
		dec, _ := s.opts.Auth.AuthorizeControlClaim(ctx, claim)
		// 校验通过即「动作皆成 session 事件」（§8.2）：本视图网关只做准入判定与回执，
		// 真实事件落库由 session-control 负责，故此处不自行写 session/event。
		s.writeJSON(hj, map[string]any{"type": "control_claim_result", "allowed": dec.Allow, "reason": dec.Reason})
	default:
		s.writeJSON(hj, map[string]any{
			"type":    "error",
			"message": "本网关只渲染视图与发送控制事件，不处理控制指令（" + msg.Action + "）",
		})
	}
}

func (s *Server) writeJSON(hj *ws.Conn, v any) {
	payload, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = hj.WriteFrame(ws.Frame{OpCode: ws.OpText, Payload: payload})
}
