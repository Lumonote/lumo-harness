package server

import (
	"net/http"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func (s *Server) setDesktopNodeState(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req struct {
		Status domain.DesktopNodeStatus `json:"status"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.store.SetDesktopNodeState(r.Context(), c.realm, r.PathValue("nodeID"), req.Status, c.userID); err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
