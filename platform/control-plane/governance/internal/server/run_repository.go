package server

import (
	"net/http"
	"strings"
)

func (s *Server) authorizeRepositoryPublication(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !s.requireDelegationAuthority(w, r, c) {
		return
	}
	if _, ok = s.taskParticipant(w, r, c); !ok {
		return
	}
	permit, err := s.store.AuthorizeRepositoryPublication(r.Context(), c.realm, r.PathValue("taskID"), r.PathValue("runID"), c.userID, isRealmAdmin(c))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, permit)
}
func (s *Server) completeRepositoryPublication(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !s.requireDelegationAuthority(w, r, c) {
		return
	}
	if _, ok = s.taskParticipant(w, r, c); !ok {
		return
	}
	var req struct {
		ManifestDigest string `json:"manifest_digest"`
		URL            string `json:"url"`
	}
	if !decodeRunReview(w, r, &req) {
		return
	}
	if !strings.HasPrefix(req.URL, "https://github.com/") || strings.ContainsAny(req.URL, "\r\n") {
		writeError(w, 400, "bad_request", "invalid draft publication URL")
		return
	}
	if err := s.store.CompleteRepositoryPublication(r.Context(), c.realm, r.PathValue("taskID"), r.PathValue("runID"), r.PathValue("publicationID"), req.ManifestDigest, req.URL, c.userID, isRealmAdmin(c)); err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"status": "draft", "url": req.URL})
}
func (s *Server) claimRepositoryPublication(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !s.requireDelegationAuthority(w, r, c) {
		return
	}
	if _, ok = s.taskParticipant(w, r, c); !ok {
		return
	}
	var req struct {
		ManifestDigest string `json:"manifest_digest"`
	}
	if !decodeRunReview(w, r, &req) {
		return
	}
	claimed, err := s.store.ClaimRepositoryPublication(r.Context(), c.realm, r.PathValue("taskID"), r.PathValue("runID"), r.PathValue("publicationID"), req.ManifestDigest, c.userID, isRealmAdmin(c))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, claimed)
}

func (s *Server) repositoryPublicationStatus(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !s.requireDelegationAuthority(w, r, c) {
		return
	}
	if _, ok = s.taskParticipant(w, r, c); !ok {
		return
	}
	out, err := s.store.RepositoryPublicationStatus(r.Context(), c.realm, r.PathValue("taskID"), r.PathValue("runID"), c.userID, isRealmAdmin(c))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}
func (s *Server) prepareRepositoryReconciliation(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !s.requireDelegationAuthority(w, r, c) {
		return
	}
	if _, ok = s.taskParticipant(w, r, c); !ok {
		return
	}
	var req struct{}
	if !decodeRunReview(w, r, &req) {
		return
	}
	out, err := s.store.PrepareRepositoryReconciliation(r.Context(), c.realm, r.PathValue("taskID"), r.PathValue("runID"), c.userID, isRealmAdmin(c))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}
func (s *Server) recordRepositoryReconciliation(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !s.requireDelegationAuthority(w, r, c) {
		return
	}
	if _, ok = s.taskParticipant(w, r, c); !ok {
		return
	}
	var req struct {
		ManifestDigest string `json:"manifest_digest"`
		Revision       int64  `json:"revision"`
		Outcome        string `json:"outcome"`
		Reason         string `json:"reason"`
		URL            string `json:"url"`
	}
	if !decodeRunReview(w, r, &req) {
		return
	}
	out, err := s.store.RecordRepositoryReconciliation(r.Context(), c.realm, r.PathValue("taskID"), r.PathValue("runID"), r.PathValue("publicationID"), req.ManifestDigest, c.userID, isRealmAdmin(c), req.Revision, req.Outcome, req.Reason, req.URL)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}
