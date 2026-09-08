package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
	"github.com/lumo-harness/platform/connector-gateway/internal/oauth"
)

func (s *Server) oauthCaller(w http.ResponseWriter, r *http.Request) (domain.Caller, bool) {
	w.Header().Set("Cache-Control", "no-store")
	caller, err := s.auth.Authenticate(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return caller, false
	}
	if !hasAnyRole(caller.Roles, s.AdminRoles) {
		writeErr(w, http.StatusForbidden, "connector administrator required")
		return caller, false
	}
	if s.oauth == nil {
		writeErr(w, http.StatusServiceUnavailable, "managed connector OAuth is not configured")
		return caller, false
	}
	return caller, true
}

func oauthError(w http.ResponseWriter, err error) {
	status, message := http.StatusServiceUnavailable, "connector OAuth service unavailable"
	switch {
	case errors.Is(err, domain.ErrNotFound):
		status, message = http.StatusNotFound, "connector not found"
	case errors.Is(err, domain.ErrForbidden):
		status, message = http.StatusForbidden, "connector OAuth egress or role policy denied"
	case errors.Is(err, oauth.ErrConflict), errors.Is(err, oauth.ErrAuthorization):
		status, message = http.StatusConflict, "connector OAuth state changed or authorization required"
	case errors.Is(err, oauth.ErrProvider):
		status, message = http.StatusBadGateway, "provider request failed; authorize again"
	}
	writeErr(w, status, message)
}

func (s *Server) handleOAuthStatus(w http.ResponseWriter, r *http.Request) {
	caller, ok := s.oauthCaller(w, r)
	if !ok {
		return
	}
	status, err := s.oauth.Status(r.Context(), caller, r.PathValue("id"))
	if err != nil {
		oauthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleOAuthStart(w http.ResponseWriter, r *http.Request) {
	caller, ok := s.oauthCaller(w, r)
	if !ok {
		return
	}
	var input struct {
		Browser string `json:"browser"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&input) != nil {
		writeErr(w, http.StatusBadRequest, "invalid OAuth request")
		return
	}
	result, err := s.oauth.Begin(r.Context(), caller, r.PathValue("id"), input.Browser)
	if err != nil {
		oauthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleOAuthCallback(w http.ResponseWriter, r *http.Request) {
	caller, ok := s.oauthCaller(w, r)
	if !ok {
		return
	}
	var input oauth.Callback
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&input) != nil {
		writeErr(w, http.StatusBadRequest, "invalid OAuth callback")
		return
	}
	if err := s.oauth.Complete(r.Context(), caller, r.PathValue("id"), input); err != nil {
		oauthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"connected": true})
}

func (s *Server) handleOAuthRefresh(w http.ResponseWriter, r *http.Request) {
	caller, ok := s.oauthCaller(w, r)
	if !ok {
		return
	}
	if err := s.oauth.Refresh(r.Context(), caller, r.PathValue("id")); err != nil {
		oauthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"refreshed": true})
}

func (s *Server) handleOAuthDisconnect(w http.ResponseWriter, r *http.Request) {
	caller, ok := s.oauthCaller(w, r)
	if !ok {
		return
	}
	if err := s.oauth.Disconnect(r.Context(), caller, r.PathValue("id")); err != nil {
		oauthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"disconnected": true, "vaultCleanupPending": true})
}
