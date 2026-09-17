package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
)

// oidcConfigured answers a configuration question, not a health question: it
// follows the declared deployment mode so that a degraded cluster still offers
// the login path an operator needs to fix it.
func (s *Server) oidcConfigured(realm string) bool {
	return s.cfg.OIDC.Enabled() && s.cfg.OIDC.Realm == realm && s.cfg.OIDC.Validate() == nil &&
		domain.IntentIsCluster(s.cfg.DeploymentMode, s.cfg.ClusterStatus)
}

func (s *Server) authOIDCStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.oidcConfigured(r.URL.Query().Get("realm")) {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "issuer": s.cfg.OIDC.Issuer, "redirect_url": s.cfg.OIDC.RedirectURL})
}

func (s *Server) authOIDCStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Realm   string `json:"realm"`
		Browser string `json:"browser"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !s.oidcConfigured(req.Realm) {
		writeError(w, http.StatusServiceUnavailable, "oidc_unavailable", "企业登录尚未配置")
		return
	}
	if len(req.Browser) != 43 {
		writeError(w, http.StatusBadRequest, "invalid_oidc_request", "Invalid login request")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	metadata, err := s.cfg.OIDC.Discover(ctx)
	if err != nil {
		s.log.Warn("OIDC discovery failed")
		writeError(w, http.StatusServiceUnavailable, "oidc_unavailable", "企业身份服务暂时不可用")
		return
	}
	flow, err := s.store.BeginOIDCLogin(ctx, req.Browser, s.cfg.OIDC.Fingerprint())
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"authorization_url": s.cfg.OIDC.AuthorizationURL(metadata, flow.State, flow.Nonce, flow.Verifier), "redirect_url": s.cfg.OIDC.RedirectURL, "expires_in": int(store.OIDCFlowTTL.Seconds())})
}

func (s *Server) authOIDCCallback(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Realm   string `json:"realm"`
		State   string `json:"state"`
		Browser string `json:"browser"`
		Code    string `json:"code"`
		Issuer  string `json:"issuer"`
		Error   string `json:"error"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if !s.oidcConfigured(req.Realm) {
		writeError(w, http.StatusServiceUnavailable, "oidc_unavailable", "企业登录尚未配置")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	flow, err := s.store.ConsumeOIDCLogin(ctx, req.State, req.Browser, s.cfg.OIDC.Fingerprint())
	if errors.Is(err, store.ErrInvalidLogin) {
		writeError(w, http.StatusUnauthorized, "invalid_oidc_login", "企业登录已失效，请重试")
		return
	}
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if req.Error != "" || req.Code == "" || len(req.Code) > 8192 || (req.Issuer != "" && req.Issuer != s.cfg.OIDC.Issuer) {
		writeError(w, http.StatusUnauthorized, "invalid_oidc_login", "企业身份验证未完成")
		return
	}
	identity, err := s.cfg.OIDC.Exchange(ctx, req.Code, flow.Verifier, flow.Nonce)
	if err != nil {
		s.log.Warn("OIDC exchange rejected")
		writeError(w, http.StatusUnauthorized, "invalid_oidc_login", "企业身份验证未完成")
		return
	}
	result, err := s.store.CompleteOIDCLogin(ctx, s.cfg.OIDC, identity, r.Header.Get("X-Lumo-Client-IP"), s.cfg.AuthSessionTTL)
	if errors.Is(err, store.ErrInvalidLogin) || errors.Is(err, store.ErrBadRequest) || errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusForbidden, "oidc_access_denied", "此企业账号尚未获准登录")
		return
	}
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": result.Token, "expires_at": result.Principal.SessionExpiresAt, "principal": result.Principal})
}

func (s *Server) authOIDCLink(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	if r.Method == http.MethodDelete {
		if err := s.store.UnlinkOIDCUser(r.Context(), c.realm, r.PathValue("userID"), c.userID); err != nil {
			s.respondStoreError(w, err)
			return
		}
	} else {
		if !s.oidcConfigured(c.realm) {
			writeError(w, http.StatusServiceUnavailable, "oidc_unavailable", "企业登录尚未配置")
			return
		}
		var req struct {
			Subject string `json:"subject"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		if err := s.store.LinkOIDCUser(r.Context(), c.realm, r.PathValue("userID"), s.cfg.OIDC.Issuer, req.Subject, c.userID); err != nil {
			s.respondStoreError(w, err)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
