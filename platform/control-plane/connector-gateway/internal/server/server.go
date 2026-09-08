// Package server 连接器网关的 HTTP 接入面。
//
// 身份由边缘/终端网关注入（与协作服务同一约定），本服务**不自行签发身份**，
// 也不接受客户端自报 realm —— realm 决定能看见哪些连接器，自报即越权。
package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/connector-gateway/internal/approval"
	"github.com/lumo-harness/platform/connector-gateway/internal/breaker"
	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
	"github.com/lumo-harness/platform/connector-gateway/internal/gateway"
	"github.com/lumo-harness/platform/connector-gateway/internal/oauth"
	"github.com/lumo-harness/platform/connector-gateway/internal/registry"
	"github.com/lumo-harness/platform/observability"
)

// Authenticator 从请求解析已认证身份；生产实现校验网关签名/JWT。
type Authenticator interface {
	Authenticate(r *http.Request) (domain.Caller, error)
}

// Server HTTP 接入。
type Server struct {
	gw        *gateway.Gateway
	reg       registry.Registry
	brk       *breaker.Group
	approvals *approval.Store
	oauth     *oauth.Manager
	auth      Authenticator
	log       *slog.Logger
	maxBody   int64
	// AdminRoles 允许注册/停用连接器的角色。
	AdminRoles []string
}

type Options struct {
	Gateway     *gateway.Gateway
	Registry    registry.Registry
	Breakers    *breaker.Group
	Approvals   *approval.Store
	OAuth       *oauth.Manager
	Auth        Authenticator
	Logger      *slog.Logger
	MaxBodyByte int64
	AdminRoles  []string
	// WebEgress 通用 web 出站配置（POST /web/fetch）。server 是配置汇合点：
	// 零值时补 DefaultWebEgress()，随后下发给网关（SetWebEgress）。
	WebEgress domain.WebEgress
}

func New(o Options) *Server {
	if o.MaxBodyByte <= 0 {
		o.MaxBodyByte = 4 << 20
	}
	if len(o.AdminRoles) == 0 {
		o.AdminRoles = []string{"admin"}
	}
	if o.WebEgress == (domain.WebEgress{}) {
		o.WebEgress = domain.DefaultWebEgress()
	}
	if o.Gateway != nil {
		o.Gateway.SetWebEgress(o.WebEgress)
	}
	return &Server{
		gw: o.Gateway, reg: o.Registry, brk: o.Breakers, approvals: o.Approvals, oauth: o.OAuth,
		auth: o.Auth, log: o.Logger,
		maxBody: o.MaxBodyByte, AdminRoles: o.AdminRoles,
	}
}

func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /metrics", handleMetrics)
	mux.HandleFunc("GET /connectors", s.handleList)
	mux.HandleFunc("GET /capabilities", s.handleCapabilities)
	mux.HandleFunc("GET /connectors/{id}/manifest", s.handleManifest)
	mux.HandleFunc("PUT /connectors/{id}", s.handleRegister)
	mux.HandleFunc("DELETE /connectors/{id}", s.handleDisable)
	mux.HandleFunc("POST /connectors/{id}/enable", s.handleEnable)
	mux.HandleFunc("POST /connectors/{id}/invoke", s.handleInvoke)
	mux.HandleFunc("GET /connectors/{id}/oauth", s.handleOAuthStatus)
	mux.HandleFunc("POST /connectors/{id}/oauth/start", s.handleOAuthStart)
	mux.HandleFunc("POST /connectors/{id}/oauth/callback", s.handleOAuthCallback)
	mux.HandleFunc("POST /connectors/{id}/oauth/refresh", s.handleOAuthRefresh)
	mux.HandleFunc("DELETE /connectors/{id}/oauth", s.handleOAuthDisconnect)
	mux.HandleFunc("GET /approvals", s.handleListApprovals)
	mux.HandleFunc("POST /approvals/{id}/approve", s.handleApprove)
	mux.HandleFunc("POST /approvals/{id}/reject", s.handleReject)
	mux.HandleFunc("POST /web/fetch", s.handleWebFetch)
	return mux
}

func handleMetrics(w http.ResponseWriter, _ *http.Request) {
	observability.Handler(w, nil)
}

func (s *Server) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]bool{"manage": hasAnyRole(caller.Roles, s.AdminRoles), "managedOAuth": s.oauth != nil})
}

func (s *Server) handleManifest(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if !hasAnyRole(caller.Roles, s.AdminRoles) {
		writeErr(w, http.StatusForbidden, "读取连接器配置需要管理员角色")
		return
	}
	connectors, err := s.reg.ListAll(r.Context(), caller.Realm)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "连接器目录读取失败")
		return
	}
	for _, connector := range connectors {
		if string(connector.ID) == r.PathValue("id") {
			w.Header().Set("Cache-Control", "no-store")
			writeJSON(w, http.StatusOK, connector)
			return
		}
	}
	writeErr(w, http.StatusNotFound, "连接器不存在")
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "ok",
		"breakers": s.brk.Snapshot(),
	})
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	includeDisabled := r.URL.Query().Get("includeDisabled") == "true"
	if includeDisabled && !hasAnyRole(caller.Roles, s.AdminRoles) {
		writeErr(w, http.StatusForbidden, "查看已停用连接器需要管理员角色")
		return
	}
	var conns []domain.Connector
	if includeDisabled {
		conns, err = s.reg.ListAll(r.Context(), caller.Realm)
	} else {
		conns, err = s.reg.List(r.Context(), caller.Realm)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 只回工具面摘要：manifest 里有 credentialRef 与 egress 细节，不该给普通调用方
	out := make([]map[string]any, 0, len(conns))
	for _, c := range conns {
		ops := make([]map[string]any, 0, len(c.Operations))
		for name, op := range c.Operations {
			ops = append(ops, map[string]any{
				"name": name, "method": op.Method,
				"write": op.Write, "sensitivity": op.Sensitivity,
				"pathParams": placeholders(op.Path), "allowedQuery": op.AllowedQuery,
			})
		}
		out = append(out, map[string]any{
			"id": c.ID, "name": c.Name, "protocol": c.Protocol,
			"version": c.Version, "enabled": c.Enabled, "operations": ops,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"connectors": out})
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if !hasAnyRole(caller.Roles, s.AdminRoles) {
		writeErr(w, http.StatusForbidden, "注册连接器需要管理员角色")
		return
	}
	var c domain.Connector
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBody)).Decode(&c); err != nil {
		writeErr(w, http.StatusBadRequest, "manifest 解析失败: "+err.Error())
		return
	}
	// id/realm 以路径与身份为准，manifest 内的同名字段不可信
	c.ID = r.PathValue("id")
	c.Realm = caller.Realm

	if err := s.reg.Upsert(r.Context(), c); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": c.ID, "realm": c.Realm})
}

func (s *Server) handleDisable(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if !hasAnyRole(caller.Roles, s.AdminRoles) {
		writeErr(w, http.StatusForbidden, "停用连接器需要管理员角色")
		return
	}
	if err := s.reg.Disable(r.Context(), caller.Realm, r.PathValue("id")); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleEnable(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if !hasAnyRole(caller.Roles, s.AdminRoles) {
		writeErr(w, http.StatusForbidden, "恢复连接器需要管理员角色")
		return
	}
	if err := s.reg.Enable(r.Context(), caller.Realm, r.PathValue("id")); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "连接器不存在")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

const approvalTTL = 15 * time.Minute

type invokeRequest struct {
	domain.Invocation
	ApprovalID string `json:"approvalId,omitempty"`
}

func (s *Server) handleInvoke(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	// A caller never gets to self-assert approval in a request header. Only a
	// successfully consumed, request-bound approval record can flip this bit for
	// the single Gateway invocation below.
	caller.Approved = false

	var input invokeRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBody)).Decode(&input); err != nil {
		writeErr(w, http.StatusBadRequest, "请求解析失败: "+err.Error())
		return
	}
	inv := input.Invocation
	inv.ConnectorID = r.PathValue("id")
	if inv.CorrelationID == "" {
		inv.CorrelationID = r.Header.Get("X-Lumo-Correlation-Id")
	}
	if input.ApprovalID != "" {
		if s.approvals == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "审批存储未配置，拒绝执行高敏感写操作", "code": "approval_unavailable"})
			return
		}
		conn, lookupErr := s.reg.Lookup(r.Context(), caller.Realm, inv.ConnectorID)
		if lookupErr != nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "连接器不存在或不可用", "code": "connector_not_found"})
			return
		}
		if _, consumeErr := s.approvals.Consume(r.Context(), input.ApprovalID, caller, inv, conn.Version); consumeErr != nil {
			status := http.StatusConflict
			if !errors.Is(consumeErr, approval.ErrNotUsable) {
				status = http.StatusInternalServerError
			}
			writeJSON(w, status, map[string]any{"error": "审批不可用于本次调用", "code": "approval_invalid"})
			return
		}
		caller.Approved = true
	}

	result, err := s.gw.Invoke(r.Context(), caller, inv)
	if err != nil {
		status, code := classify(err)
		if errors.Is(err, domain.ErrApproval) && s.approvals != nil {
			conn, lookupErr := s.reg.Lookup(r.Context(), caller.Realm, inv.ConnectorID)
			if lookupErr != nil {
				writeJSON(w, http.StatusNotFound, map[string]any{"error": "连接器不存在或不可用", "code": "connector_not_found"})
				return
			}
			request, createErr := s.approvals.Create(r.Context(), caller, inv, conn.Version, approvalTTL)
			if createErr != nil {
				if s.log != nil {
					s.log.Error("创建连接器审批失败", "connector", inv.ConnectorID, "operation", inv.Operation, "err", createErr)
				}
				writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "审批记录暂不可创建，调用未执行", "code": "approval_unavailable"})
				return
			}
			writeJSON(w, status, map[string]any{"error": err.Error(), "code": code, "approval": request})
			return
		}
		s.log.Info("连接器调用被拒绝或失败",
			"connector", inv.ConnectorID, "operation", inv.Operation,
			"user", caller.UserID, "code", code, "err", err)
		writeJSON(w, status, map[string]any{"error": err.Error(), "code": code})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleListApprovals(w http.ResponseWriter, r *http.Request) {
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
	writeJSON(w, http.StatusOK, map[string]any{"approvals": requests})
}

func (s *Server) handleApprove(w http.ResponseWriter, r *http.Request) {
	s.decideApproval(w, r, "approved")
}

func (s *Server) handleReject(w http.ResponseWriter, r *http.Request) {
	s.decideApproval(w, r, "rejected")
}

func (s *Server) decideApproval(w http.ResponseWriter, r *http.Request, decision string) {
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
	request, err := s.approvals.Decide(r.Context(), r.PathValue("id"), string(caller.Realm), caller.UserID, decision)
	if errors.Is(err, approval.ErrNotApprovable) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "审批不存在、已过期、已处理或不可由申请人本人处理", "code": "approval_invalid"})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, request)
}

// handleWebFetch 通用 URL 出站（ctx.web fetch 的网关截面）。
// 与 handleInvoke 同构：鉴权 → 解析/校验 → 网关闸门链 → classify 错误。
// 成功响应在 InvokeResult 形状上加 url 回显（WebFetchResult.url 需要它）。
func (s *Server) handleWebFetch(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}

	var spec domain.WebFetchSpec
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBody)).Decode(&spec); err != nil {
		writeErr(w, http.StatusBadRequest, "请求解析失败: "+err.Error())
		return
	}
	if err := domain.ValidateWebFetch(spec); err != nil {
		status, code := classify(err)
		writeJSON(w, status, map[string]any{"error": err.Error(), "code": code})
		return
	}

	result, err := s.gw.WebFetch(r.Context(), caller, spec)
	if err != nil {
		status, code := classify(err)
		s.log.Info("web 出站被拒绝或失败", "url", spec.URL, "user", caller.UserID, "code", code, "err", err)
		writeJSON(w, status, map[string]any{"error": err.Error(), "code": code})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      result.Status,
		"url":         spec.URL,
		"headers":     result.Headers,
		"body":        result.Body,
		"encoding":    result.Encoding,
		"contentType": result.ContentType,
		"redacted":    result.Redacted,
		"durationMs":  result.DurationMS,
	})
}

// classify 把闸门错误映射成 HTTP 语义。每个闸都有自己的状态码，
// 前端与 agent 才能区分「没权限」「太快了」「上游挂了」「等审批」。
func classify(err error) (int, string) {
	switch {
	case errors.Is(err, domain.ErrNotFound):
		return http.StatusNotFound, "connector_not_found"
	case errors.Is(err, domain.ErrOperation):
		return http.StatusBadRequest, "operation_invalid"
	case errors.Is(err, domain.ErrApproval):
		// 428：需要先满足前置条件（人工批准）再重试，语义上正好
		return http.StatusPreconditionRequired, "approval_required"
	case errors.Is(err, domain.ErrForbidden), errors.Is(err, domain.ErrEgressBlocked):
		return http.StatusForbidden, "egress_denied"
	case errors.Is(err, domain.ErrRateLimited):
		return http.StatusTooManyRequests, "rate_limited"
	case errors.Is(err, domain.ErrCircuitOpen):
		return http.StatusServiceUnavailable, "circuit_open"
	case errors.Is(err, domain.ErrTooLarge):
		return http.StatusRequestEntityTooLarge, "payload_too_large"
	case errors.Is(err, domain.ErrCredential):
		return http.StatusBadGateway, "credential_error"
	case errors.Is(err, domain.ErrUpstream):
		return http.StatusBadGateway, "upstream_error"
	default:
		return http.StatusInternalServerError, "internal_error"
	}
}

func placeholders(path string) []string {
	var out []string
	rest := path
	for {
		open := strings.IndexByte(rest, '{')
		if open < 0 {
			return out
		}
		end := strings.IndexByte(rest[open:], '}')
		if end < 0 {
			return out
		}
		out = append(out, rest[open+1:open+end])
		rest = rest[open+end+1:]
	}
}

func hasAnyRole(have, want []string) bool {
	set := make(map[string]struct{}, len(want))
	for _, w := range want {
		set[strings.ToLower(strings.TrimSpace(w))] = struct{}{}
	}
	for _, h := range have {
		if _, ok := set[strings.ToLower(strings.TrimSpace(h))]; ok {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}
