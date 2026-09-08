package server

import (
	"net/http"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
)

func (s *Server) createLocalUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req struct {
		ID            string `json:"id"`
		DisplayName   string `json:"display_name"`
		PrimaryDeptID string `json:"primary_dept_id"`
		Username      string `json:"username"`
		Password      string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	user, err := s.store.CreateLocalUser(r.Context(), store.LocalUser{
		User:     domain.User{ID: req.ID, Realm: c.realm, DisplayName: req.DisplayName, PrimaryDeptID: req.PrimaryDeptID},
		Username: req.Username, Password: req.Password,
	}, c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, user)
}

func (s *Server) userAccess(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	access, err := s.store.GetUserAccess(r.Context(), c.realm, r.PathValue("userID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, access)
}

func (s *Server) setUserCredentials(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.store.SetUserCredentials(r.Context(), c.realm, r.PathValue("userID"), req.Username, req.Password, c.userID); err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) revokeRole(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	if err := s.store.RevokeRole(r.Context(), c.realm, r.PathValue("userID"), r.PathValue("roleID"), c.userID); err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
