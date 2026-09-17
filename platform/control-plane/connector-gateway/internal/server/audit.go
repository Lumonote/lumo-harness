package server

import (
	"context"
	"net/http"
	"strconv"

	"github.com/lumo-harness/platform/connector-gateway/internal/audit"
)

// 审计查询面（§10.1「所有外部调用记 session 事件供审计」的读取侧）。
//
// 与 approvals 同规：realm 只来自已认证身份；非管理员只看得见自己的调用，
// 管理员用 all=true 看整个 realm。审计行带 target_host 与 operation，
// 跨用户可见性属管理能力，不能由查询参数自行放宽。

// auditReader 审计读取面。用接口而非具体类型，让 handler 契约测试不需要数据库
// —— 与 llm-gateway 的 providerRegistry 同一取舍。
type auditReader interface {
	Query(ctx context.Context, f audit.QueryFilter) (audit.Page, error)
}

func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request) {
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if s.audit == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "审计查询未配置", "code": "audit_unavailable"})
		return
	}

	query := r.URL.Query()
	decision, err := audit.ParseDecision(query.Get("decision"))
	if err != nil {
		// 未知 decision 一律报错：静默退化成「不过滤」会把一次「只看被拒绝的调用」
		// 悄悄变成「全部调用」，合规查询不能这样被放宽。
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "decision 只接受 allowed 或 denied", "code": "invalid_decision"})
		return
	}
	beforeID, err := parseBeforeID(query.Get("beforeId"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "beforeId 必须是非负整数", "code": "invalid_cursor"})
		return
	}
	limit, err := parseLimit(query.Get("limit"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "limit 必须是正整数", "code": "invalid_limit"})
		return
	}

	filter := audit.QueryFilter{
		Realm:       string(caller.Realm),
		UserID:      caller.UserID,
		SessionID:   query.Get("sessionId"),
		ConnectorID: query.Get("connectorId"),
		Decision:    decision,
		BeforeID:    beforeID,
		Limit:       limit,
	}
	if all := query.Get("all"); all == "true" || all == "1" {
		if !hasAnyRole(caller.Roles, s.AdminRoles) {
			writeErr(w, http.StatusForbidden, "查看整个 realm 的审计需要管理员角色")
			return
		}
		filter.UserID = ""
	}

	page, err := s.audit.Query(r.Context(), filter)
	if err != nil {
		// 读取面失败不回显 err：SQL 错误里可能带 realm 与查询条件。
		s.log.Error("审计查询失败", "realm", caller.Realm, "err", err)
		writeErr(w, http.StatusInternalServerError, "审计查询失败")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, page)
}

// parseLimit 解析页大小。缺省与超上限都由 audit.Reader 兜底，这里只拒绝
// 无法解析或非正的值 —— 显式传了个坏值应该报错，而不是被当成没传。
func parseLimit(raw string) (int, error) {
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, strconv.ErrSyntax
	}
	return value, nil
}

// parseBeforeID 解析 keyset 游标；空串表示从最新开始。
func parseBeforeID(raw string) (int64, error) {
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return 0, strconv.ErrSyntax
	}
	return value, nil
}
