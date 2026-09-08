package server

import "net/http"

func (s *Server) skillAccess(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	access, err := s.store.SkillAccess(r.Context(), c.realm, r.PathValue("skillID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, access)
}

func (s *Server) deleteSkillAccess(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	if err := s.store.DeleteSkillAccess(r.Context(), c.realm, r.PathValue("skillID"), r.PathValue("resource"), r.PathValue("accessID"), c.userID); err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
