package server

import (
	"net/http"
	"strings"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func (s *Server) taskCollaborators(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	task, ok := s.taskViewer(w, r, c)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		items, err := s.store.ListTaskCollaborators(r.Context(), c.realm, task.ID)
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"collaborators": items, "can_manage": isRealmAdmin(c) || task.RequesterUserID == c.userID})
		return
	}
	if r.Method != http.MethodPut {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if !isRealmAdmin(c) && task.RequesterUserID != c.userID {
		writeError(w, http.StatusForbidden, "forbidden", "only the requester or realm administrator can manage task collaborators")
		return
	}
	var req struct {
		Collaborators []domain.TaskCollaborator `json:"collaborators"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.store.ReplaceTaskCollaborators(r.Context(), c.realm, task.ID, c.userID, req.Collaborators); err != nil {
		s.respondStoreError(w, err)
		return
	}
	items, err := s.store.ListTaskCollaborators(r.Context(), c.realm, task.ID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"collaborators": items, "can_manage": true})
}

func (s *Server) taskArtifacts(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	var task domain.DelegatedTask
	if r.Method == http.MethodGet {
		task, ok = s.taskViewer(w, r, c)
	} else {
		task, ok = s.taskParticipant(w, r, c)
	}
	if !ok {
		return
	}
	runID := strings.TrimSpace(r.PathValue("runID"))
	if r.Method == http.MethodGet {
		items, err := s.store.ListTaskArtifacts(r.Context(), c.realm, task.ID, runID)
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"artifacts": items})
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	var req struct {
		Name        string `json:"name"`
		ContentType string `json:"content_type"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	artifact, err := s.store.ReserveTaskArtifact(r.Context(), domain.TaskArtifact{
		ID: newID("artifact"), Realm: c.realm, TaskID: task.ID, RunID: runID,
		Name: req.Name, ContentType: req.ContentType, CreatedBy: c.userID,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, artifact)
}

func (s *Server) completeTaskArtifact(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	if _, ok := s.taskParticipant(w, r, c); !ok {
		return
	}
	var req struct {
		StorageKey string `json:"storage_key"`
		SHA256     string `json:"sha256"`
		SizeBytes  int64  `json:"size_bytes"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	artifact, err := s.store.CompleteTaskArtifact(r.Context(), c.realm, r.PathValue("taskID"), r.PathValue("runID"), r.PathValue("artifactID"), req.StorageKey, req.SHA256, req.SizeBytes)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, artifact)
}

// taskArtifactStorage is only used by the Lumo host while streaming an
// artifact. Browser-facing Lumo routes never proxy this response.
func (s *Server) taskArtifactStorage(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	if r.URL.Query().Get("access") == "contributor" {
		if _, ok := s.taskParticipant(w, r, c); !ok {
			return
		}
	} else if _, ok := s.taskViewer(w, r, c); !ok {
		return
	}
	artifact, err := s.store.GetTaskArtifact(r.Context(), c.realm, r.PathValue("taskID"), r.PathValue("runID"), r.PathValue("artifactID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"storage_key": artifact.StorageKey, "sha256": artifact.SHA256, "size_bytes": artifact.SizeBytes,
		"name": artifact.Name, "content_type": artifact.ContentType,
	})
}
