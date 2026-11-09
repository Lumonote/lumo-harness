package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	bg "github.com/lumo-harness/platform/governance/internal/breakglass"
	"github.com/lumo-harness/platform/governance/internal/store"
)

func (s *Server) registerRecoveryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/recovery-requests", s.recoveryRequests)
	mux.HandleFunc("POST /v1/recovery-requests", s.recoveryRequests)
	mux.HandleFunc("GET /v1/recovery-requests/{requestID}", s.recoveryRequest)
	for _, action := range []string{"approve", "revoke", "execute", "receipt"} {
		mux.HandleFunc("POST /v1/recovery-requests/{requestID}/"+action, s.recoveryAction)
	}
}
func (s *Server) recoveryCaller(w http.ResponseWriter, r *http.Request) (caller, bool) {
	if !s.requireCluster(w) {
		return caller{}, false
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return c, false
	}
	return c, true
}
func (s *Server) recoveryRequests(w http.ResponseWriter, r *http.Request) {
	c, ok := s.recoveryCaller(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		requests, err := s.store.ListRecoveries(r.Context(), c.realm, c.userID)
		if err != nil {
			s.recoveryError(w, err)
			return
		}
		scopes := []bg.TargetScope{}
		for _, scope := range s.cfg.RecoveryProvider.Scopes {
			if scope.Realm == c.realm {
				scopes = append(scopes, scope)
			}
		}
		writeJSON(w, 200, map[string]any{"requests": requests, "actor": map[string]string{"user_id": c.userID, "realm": c.realm}, "provider": map[string]any{"enabled": s.cfg.RecoveryProvider.Enabled(), "id": s.cfg.RecoveryProvider.ID, "operations": s.cfg.RecoveryProvider.Operations, "scopes": scopes}})
		return
	}
	var req struct {
		bg.Target
		Reason    string    `json:"reason"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if !decodeRolePolicyJSON(w, r, &req) {
		return
	}
	if !s.cfg.RecoveryProvider.Enabled() {
		writeError(w, 503, "recovery_provider_unavailable", "未配置受信恢复执行服务，请先完成部署配置")
		return
	}
	if !s.cfg.RecoveryProvider.Allows(c.realm, req.Target) {
		writeError(w, 403, "recovery_target_forbidden", "该操作或目标不在部署授权范围内")
		return
	}
	created, err := s.store.CreateRecovery(r.Context(), bg.DurableRequest{Realm: c.realm, Target: req.Target, Reason: req.Reason, RequestedBy: c.userID, ExpiresAt: req.ExpiresAt, ProviderID: s.cfg.RecoveryProvider.ID, PolicyDigest: s.cfg.RecoveryProvider.Digest()})
	if err != nil {
		s.recoveryError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}
func (s *Server) recoveryRequest(w http.ResponseWriter, r *http.Request) {
	c, ok := s.recoveryCaller(w, r)
	if !ok {
		return
	}
	request, audit, err := s.store.GetRecovery(r.Context(), c.realm, r.PathValue("requestID"), c.userID)
	if err != nil {
		s.recoveryError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"request": request, "audit": audit})
}
func (s *Server) recoveryAction(w http.ResponseWriter, r *http.Request) {
	c, ok := s.recoveryCaller(w, r)
	if !ok {
		return
	}
	var req struct {
		ExpectedRevision int64  `json:"expected_revision"`
		RequestDigest    string `json:"request_digest"`
	}
	if !decodeRolePolicyJSON(w, r, &req) {
		return
	}
	id := r.PathValue("requestID")
	action := ""
	// Action is selected from the registered literal suffix, never a forwarded URL.
	for _, candidate := range []string{"approve", "revoke", "execute", "receipt"} {
		if r.Pattern == "POST /v1/recovery-requests/{requestID}/"+candidate {
			action = candidate
			break
		}
	}
	current, _, err := s.store.GetRecovery(r.Context(), c.realm, id, c.userID)
	if err != nil {
		s.recoveryError(w, err)
		return
	}
	if req.RequestDigest == "" || req.RequestDigest != current.RequestDigest {
		writeError(w, 409, "recovery_changed", "请求摘要不一致，请重新读取并核对目标")
		return
	}
	if action == "approve" || action == "revoke" {
		result, err := s.store.ChangeRecovery(r.Context(), c.realm, id, c.userID, action, req.ExpectedRevision)
		if err != nil {
			s.recoveryError(w, err)
			return
		}
		if result.Status == bg.WorkflowExpired {
			writeJSON(w, 409, map[string]any{"error": "recovery_expired", "request": result})
			return
		}
		writeJSON(w, 200, result)
		return
	}
	if !s.cfg.RecoveryProvider.Enabled() || !s.cfg.RecoveryProvider.Allows(c.realm, current.Target) {
		writeError(w, 503, "recovery_provider_unavailable", "恢复执行服务尚未配置或当前目标已被部署策略撤销")
		return
	}
	policy := s.cfg.RecoveryProvider.Digest()
	if action == "receipt" && current.ProviderProtocol == bg.LegacyProtocolVersion {
		policy = s.cfg.RecoveryProvider.DigestForVersion(bg.LegacyProtocolVersion)
	}
	claim, err := s.store.ClaimRecovery(r.Context(), c.realm, id, c.userID, req.ExpectedRevision, s.cfg.RecoveryProvider.ID, policy, action)
	if err != nil {
		s.recoveryError(w, err)
		return
	}
	if claim.Replayed {
		writeJSON(w, 200, claim.Request)
		return
	}
	if claim.Request.Status == bg.WorkflowExpired {
		writeJSON(w, 409, map[string]any{"error": "recovery_expired", "request": claim.Request})
		return
	}
	// Once a claim is persisted we finish it even if the browser disconnects.
	// Provider transport is bounded; a lost response becomes uncertain, never a
	// fabricated rejection or success. Retrying always keeps the execution ID.
	callCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 12*time.Second)
	defer cancel()
	receipt, callErr := s.cfg.RecoveryProvider.Call(callCtx, claim.Request.Execution(action))
	var proof *bg.Receipt
	if callErr == nil {
		proof = &receipt
	}
	finishCtx, finishCancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer finishCancel()
	result, finishErr := s.store.FinishRecovery(finishCtx, claim, proof, "provider_unavailable")
	if finishErr != nil {
		s.recoveryError(w, finishErr)
		return
	}
	if callErr != nil {
		writeJSON(w, 503, map[string]any{"error": "recovery_provider_unavailable", "message": "结果尚未确认，请使用同一请求核对回执", "request": result})
		return
	}
	status := 200
	if result.Status == bg.Uncertain {
		status = 202
	}
	writeJSON(w, status, result)
}
func (s *Server) recoveryError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrRecoveryChanged):
		writeError(w, 409, "recovery_changed", "请求版本或部署策略已变化，请重新读取后核对")
	case errors.Is(err, store.ErrRecoveryState):
		writeError(w, 409, "recovery_state", "当前状态不允许该动作；审批人与请求人、执行人必须不同，结果待确认时不能撤销")
	case errors.Is(err, store.ErrRecoveryClaim):
		writeError(w, 409, "recovery_claim_lost", "执行租约已失效，旧结果未覆盖当前状态，请核对回执")
	default:
		s.respondStoreError(w, err)
	}
}
