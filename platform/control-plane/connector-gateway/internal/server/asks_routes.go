package server

// 统一 Ask 接口（P0-1）。旧 /approvals 路由与 428 approval_required 保持不变；
// 这里在同一存储上提供统一形状，并增加 SSE 事件流。

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/connector-gateway/internal/approval"
	"github.com/lumo-harness/platform/connector-gateway/internal/asks"
)

func (s *Server) registerAskRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /asks", s.handleListAsks)
	mux.HandleFunc("GET /asks/events", s.handleAskEvents)
	mux.HandleFunc("POST /asks/{id}/answer", s.handleAnswerAsk)
	mux.HandleFunc("POST /asks/{id}/cancel", s.handleCancelAsk)
}

func (s *Server) handleListAsks(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if s.approvals == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "审批存储未配置", "code": "approval_unavailable"})
		return
	}
	requests, err := s.approvals.List(r.Context(), string(caller.Realm), caller.UserID, hasAnyRole(caller.Roles, s.AdminRoles))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	status := r.URL.Query().Get("status")
	out := make([]asks.Ask, 0, len(requests))
	for _, req := range requests {
		a := asks.FromApproval(req)
		if status != "" && a.Status != status {
			continue
		}
		out = append(out, a)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"asks": out})
}

type answerInput struct {
	Value   string `json:"value"`
	Comment string `json:"comment,omitempty"`
}

func (s *Server) handleAnswerAsk(w http.ResponseWriter, r *http.Request) {
	var in answerInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "请求解析失败: "+err.Error())
		return
	}
	switch strings.TrimSpace(in.Value) {
	case "approve":
		s.decideAsk(w, r, "approved")
	case "reject":
		s.decideAsk(w, r, "rejected")
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "审批类 ask 仅接受 approve / reject", "code": "ask_answer_invalid"})
	}
}

// handleCancelAsk：申请人撤回自己仍待处理的连接器审批（迁移 048 让 CHECK 允许
// 'cancelled'）。只有申请人本人可撤回；管理员不走这里（管理员用 answer=reject）。
// 已决议、已过期或非本人：409 approval_invalid（与 decide 同一错误码，幂等安全）。
func (s *Server) handleCancelAsk(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if s.approvals == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "审批存储未配置", "code": "approval_unavailable"})
		return
	}
	id, ok := asks.ParseConnectorID(r.PathValue("id"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid ask id")
		return
	}
	request, err := s.approvals.Cancel(r.Context(), id, string(caller.Realm), caller.UserID)
	if errors.Is(err, approval.ErrNotApprovable) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "ask 不存在、已过期、已处理或不是本人发起", "code": "approval_invalid"})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a := asks.FromApproval(request)
	s.publishAsk(a)
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) decideAsk(w http.ResponseWriter, r *http.Request, decision string) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if !hasAnyRole(caller.Roles, s.AdminRoles) {
		writeErr(w, http.StatusForbidden, "处理高敏感连接器审批需要管理员角色")
		return
	}
	if s.approvals == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "审批存储未配置", "code": "approval_unavailable"})
		return
	}
	id, ok := asks.ParseConnectorID(r.PathValue("id"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid ask id")
		return
	}
	request, err := s.approvals.Decide(r.Context(), id, string(caller.Realm), caller.UserID, decision)
	if errors.Is(err, approval.ErrNotApprovable) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "ask 不存在、已过期、已处理或不可由申请人本人处理", "code": "approval_invalid"})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a := asks.FromApproval(request)
	s.publishAsk(a)
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) publishAsk(a asks.Ask) {
	typ := "ask." + a.Status
	if a.Status == "pending" {
		typ = "ask.created"
	}
	if a.SourceStatus == "consumed" {
		typ = "ask.consumed"
	}
	s.askEvents.Publish(typ, a)
}

func (s *Server) handleAskEvents(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok || s.askEvents == nil {
		writeErr(w, http.StatusNotImplemented, "事件流不可用，请轮询 GET /asks")
		return
	}
	admin := hasAnyRole(caller.Roles, s.AdminRoles)
	ch, cancel := s.askEvents.Subscribe(string(caller.Realm))
	defer cancel()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case ev, open := <-ch:
			if !open {
				return
			}
			// 与 List 同一可见性：非管理员只看自己发起的 ask。
			if !admin && ev.Ask.RequesterUserID != caller.UserID {
				continue
			}
			raw, _ := json.Marshal(ev)
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, raw)
			flusher.Flush()
		}
	}
}
