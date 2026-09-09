package server

import (
	"net/http"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func (s *Server) collaborationProgress(w http.ResponseWriter, r *http.Request) {
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
	progress, err := s.store.CollaborationProgress(r.Context(), c.realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, progress)
}

func (s *Server) taskResult(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		if _, ok := s.taskParticipant(w, r, c); !ok {
			return
		}
		result, err := s.store.GetTaskResult(r.Context(), c.realm, r.PathValue("taskID"), r.PathValue("runID"))
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	if !requireExecutionReporter(w, c) {
		return
	}
	var result domain.TaskResult
	if !decodeJSON(w, r, &result) {
		return
	}
	result.TaskID, result.RunID = r.PathValue("taskID"), r.PathValue("runID")
	stored, err := s.store.RecordTaskResult(r.Context(), c.realm, result, c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, stored)
}

func requiresRequesterReview(event string) bool {
	return event == "complete" || event == "reject" || event == "archive"
}

func executionBusinessEvent(event string) bool {
	return event == "" || event == "start" || event == "verify" || event == "submit_review"
}
