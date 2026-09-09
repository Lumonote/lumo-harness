package server

import (
	"net/http"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func (s *Server) workerNodes(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	realm := r.Header.Get("X-Lumo-Realm")
	if realm == "" {
		writeError(w, http.StatusUnauthorized, "missing_realm", "X-Lumo-Realm required")
		return
	}
	workerID := r.PathValue("workerID")
	nodes, err := s.store.WorkerNodes(r.Context(), realm, workerID, r.URL.Query().Get("project_id"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"realm": realm, "worker_id": workerID, "node_ids": nodes})
}

func (s *Server) reportWorkerRuntime(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	realm := r.Header.Get("X-Lumo-Realm")
	if realm == "" {
		writeError(w, http.StatusUnauthorized, "missing_realm", "X-Lumo-Realm required")
		return
	}
	var report domain.WorkerRuntimeReport
	if !decodeJSON(w, r, &report) {
		return
	}
	if err := s.store.ReportWorkerRuntime(r.Context(), realm, r.PathValue("workerID"), report); err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "accepted", "expires_in_seconds": 30})
}

func (s *Server) runtimeAgentPreset(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	realm := r.Header.Get("X-Lumo-Realm")
	if realm == "" {
		writeError(w, http.StatusUnauthorized, "missing_realm", "X-Lumo-Realm required")
		return
	}
	preset, err := s.store.GetAgentPreset(r.Context(), realm, r.PathValue("presetID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preset)
}

// A service-authenticated receipt may survive preset changes and runtime
// expiry. Its authorization is the exact durable Run/node/session binding,
// rather than the current employee or Agent configuration.
func (s *Server) runtimeTaskResult(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	realm := r.Header.Get("X-Lumo-Realm")
	if realm == "" {
		writeError(w, http.StatusUnauthorized, "missing_realm", "X-Lumo-Realm required")
		return
	}
	var result domain.TaskResult
	if !decodeJSON(w, r, &result) {
		return
	}
	if result.RunID != r.PathValue("runID") || result.NodeID == "" || result.SessionRef == "" {
		writeError(w, http.StatusBadRequest, "invalid_result_identity", "Run, node and session references are required")
		return
	}
	run, err := s.store.GetTaskRun(r.Context(), realm, result.RunID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if !runtimeResultMatches(run, result) {
		writeError(w, http.StatusForbidden, "execution_mismatch", "result does not match its durable execution identity")
		return
	}
	stored, err := s.store.RecordTaskResult(r.Context(), realm, result, run.WorkerID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, stored)
}

func runtimeResultMatches(run domain.TaskRun, result domain.TaskResult) bool {
	return run.ID == result.RunID && run.TaskID == result.TaskID && run.SchedulerTaskID == run.ID &&
		run.AssignedNodeID != "" && run.AssignedNodeID == result.NodeID &&
		run.SessionRef != "" && run.SessionRef == result.SessionRef
}
