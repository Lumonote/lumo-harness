package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/lumo-harness/platform/governance/internal/store"
)

func (s *Server) registerUserSecurityRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/users/{userID}/security", s.userSecurity)
	mux.HandleFunc("GET /v1/users/{userID}/sessions", s.userSessions)
	mux.HandleFunc("GET /v1/users/{userID}/security-events", s.userSecurityEvents)
	mux.HandleFunc("DELETE /v1/users/{userID}/sessions", s.revokeUserSessions)
	mux.HandleFunc("DELETE /v1/users/{userID}/sessions/{sessionID}", s.revokeUserSessions)
}

func parseUserSecurityPage(query url.Values) (store.UserSecurityPageOptions, error) {
	options := store.UserSecurityPageOptions{Limit: 25}
	for key, values := range query {
		if (key != "limit" && key != "offset") || len(values) != 1 || values[0] == "" {
			return options, fmt.Errorf("%w: invalid pagination", store.ErrBadRequest)
		}
		for _, digit := range values[0] {
			if digit < '0' || digit > '9' {
				return options, fmt.Errorf("%w: invalid pagination", store.ErrBadRequest)
			}
		}
		value, err := strconv.Atoi(values[0])
		if err != nil || (key == "limit" && value == 0) {
			return options, fmt.Errorf("%w: invalid pagination", store.ErrBadRequest)
		}
		if key == "limit" {
			options.Limit = value
		} else {
			options.Offset = value
		}
	}
	return options, options.Normalize()
}

func (s *Server) userSecurity(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	result, err := s.store.UserSecurity(r.Context(), c.realm, r.PathValue("userID"), c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) userSessions(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	options, err := parseUserSecurityPage(r.URL.Query())
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	result, err := s.store.UserSessions(r.Context(), c.realm, r.PathValue("userID"), c.userID, options)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) userSecurityEvents(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	options, err := parseUserSecurityPage(r.URL.Query())
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	result, err := s.store.UserSecurityEvents(r.Context(), c.realm, r.PathValue("userID"), c.userID, options)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) revokeUserSessions(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&req) != nil || decoder.Decode(new(any)) != io.EOF {
		writeError(w, http.StatusBadRequest, "bad_request", "one revocation reason JSON body is required")
		return
	}
	count, err := s.store.RevokeUserSessions(r.Context(), c.realm, r.PathValue("userID"), r.PathValue("sessionID"), c.userID, req.Reason)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"revoked": count})
}
