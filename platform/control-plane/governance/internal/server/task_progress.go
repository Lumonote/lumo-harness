package server

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
)

func (s *Server) taskProgress(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !s.requireDelegationAuthority(w, r, c) {
		return
	}
	if r.Method == http.MethodPut {
		if _, ok := s.taskParticipant(w, r, c); !ok {
			return
		}
		if !s.requireExecutionReporter(w, r, c) {
			return
		}
		var update domain.TaskProgressUpdate
		if !decodeJSON(w, r, &update) {
			return
		}
		progress, err := s.store.RecordTaskProgress(r.Context(), c.realm, r.PathValue("taskID"), update, c.userID)
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, progress)
		return
	}
	task, ok := s.taskViewer(w, r, c)
	if !ok {
		return
	}
	view, err := s.store.TaskProgress(r.Context(), c.realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if view.CanUpdate && !isRealmAdmin(c) {
		access, err := s.store.TaskAccess(r.Context(), c.realm, r.PathValue("taskID"), c.userID)
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		view.CanUpdate = access == "contributor"
	}
	if view.CanUpdate {
		view.CanUpdate, err = s.store.TaskProgressRoleAllowed(r.Context(), c.realm, c.userID)
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
	}
	if view.CanUpdate {
		decision, err := s.permissionDecision(r.Context(), c, actionExecutionUpdate, domain.PermissionResource{Kind: "task", ID: task.ID, ProjectID: task.ProjectID})
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		view.CanUpdate = decision.Allowed
	}
	writeJSON(w, http.StatusOK, view)
}

// Workforce summaries cover every authorized row matching the filters, before
// pagination. Snapshot rows and the same permission decisions feed both views.
func (s *Server) workforceProgress(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !s.requireDelegationAuthority(w, r, c) {
		return
	}
	allowedParameters := map[string]bool{"scope": true, "limit": true, "cursor": true, "q": true, "risk": true, "worker_kind": true}
	for key, values := range r.URL.Query() {
		if !allowedParameters[key] || len(values) != 1 {
			writeError(w, http.StatusBadRequest, "invalid_filter", "unknown or repeated workforce parameter")
			return
		}
	}
	scope := strings.TrimSpace(r.URL.Query().Get("scope"))
	if scope == "" {
		scope = "mine"
	}
	all, department := false, false
	switch scope {
	case "mine":
	case "all":
		if !isRealmAdmin(c) {
			writeError(w, http.StatusForbidden, "forbidden", "realm administration is required for all workforce tasks")
			return
		}
		all = true
	case "department":
		if !c.roles["dept_manager"] && !isRealmAdmin(c) {
			writeError(w, http.StatusForbidden, "forbidden", "department manager role required")
			return
		}
		department = true
	default:
		writeError(w, http.StatusBadRequest, "invalid_scope", "scope must be mine, department or all")
		return
	}
	limit := 50
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 200 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit must be between 1 and 200")
			return
		}
		limit = parsed
	}
	filter := domain.WorkforceProgressFilter{Query: r.URL.Query().Get("q"), Risk: r.URL.Query().Get("risk"), WorkerKind: r.URL.Query().Get("worker_kind")}
	filter.Normalize()
	after, encode, err := store.WorkforceProgressCursor(c.realm, c.userID, scope, filter, r.URL.Query().Get("cursor"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	items, err := s.store.WorkforceProgressSnapshot(r.Context(), c.realm, c.userID, all, department, isRealmAdmin(c))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	visible := make([]domain.WorkforceProgressItem, 0, len(items))
	for _, item := range items {
		if !filter.Matches(item) {
			continue
		}
		task := item.Task
		decision, err := s.permissionDecision(r.Context(), c, actionDelegate, domain.PermissionResource{Kind: "task", ID: task.ID, ProjectID: task.ProjectID})
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		if decision.Allowed {
			visible = append(visible, item)
		}
	}
	writeJSON(w, http.StatusOK, store.BuildWorkforceProgressPage(visible, filter, limit, after, encode))
}

func (s *Server) runtimeTaskProgress(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	realm := strings.TrimSpace(r.Header.Get("X-Lumo-Realm"))
	if realm == "" {
		writeError(w, http.StatusUnauthorized, "missing_realm", "X-Lumo-Realm required")
		return
	}
	run, err := s.store.GetTaskRun(r.Context(), realm, r.PathValue("runID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if r.Method == http.MethodGet {
		identity := domain.TaskResult{TaskID: run.TaskID, RunID: run.ID, NodeID: r.URL.Query().Get("node_id"), SessionRef: r.URL.Query().Get("session_ref")}
		if !runtimeResultMatches(run, identity) {
			writeError(w, http.StatusForbidden, "execution_mismatch", "progress does not match its durable execution identity")
			return
		}
		view, err := s.store.TaskProgress(r.Context(), realm, run.TaskID)
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		// A runtime sees only its own checkpoint, not another worker's prior attempts.
		view.History = []domain.TaskProgress{}
		if view.CurrentRunID != run.ID {
			writeError(w, http.StatusConflict, "stale_run", "run is no longer current")
			return
		}
		writeJSON(w, http.StatusOK, view)
		return
	}
	var input struct {
		domain.TaskProgressUpdate
		NodeID     string `json:"node_id"`
		SessionRef string `json:"session_ref"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.RunID != run.ID {
		writeError(w, http.StatusBadRequest, "invalid_run", "run_id must match the route")
		return
	}
	progress, err := s.store.RecordRuntimeTaskProgress(r.Context(), realm, run.TaskID, input.TaskProgressUpdate, input.NodeID, input.SessionRef)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, progress)
}
