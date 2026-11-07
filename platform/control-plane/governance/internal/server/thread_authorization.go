package server

import (
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

type threadAuthorizationRequest struct {
	OwnerUserID    string `json:"owner_user_id"`
	ProjectID      string `json:"project_id"`
	AgentID        string `json:"agent_id"`
	PresetRevision int    `json:"preset_revision"`
	Provider       string `json:"provider"`
	Model          string `json:"model"`
}

func (req threadAuthorizationRequest) valid() bool {
	for _, value := range []string{req.OwnerUserID, req.ProjectID, req.AgentID, req.Provider, req.Model} {
		if value == "" || value != strings.TrimSpace(value) || len(value) > 512 || strings.ContainsAny(value, "\x00\r\n") {
			return false
		}
	}
	return req.PresetRevision > 0
}

// runtimeThreadAuthorization authorizes a coordinating Thread's text round.
// It reads current facts on every call and creates no TaskRun: the Thread is a
// coordinator-owned child round, not a reassignment of the business task.
func (s *Server) runtimeThreadAuthorization(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	realm := r.Header.Get("X-Lumo-Realm")
	if realm == "" {
		writeError(w, http.StatusUnauthorized, "missing_realm", "X-Lumo-Realm required")
		return
	}
	var req threadAuthorizationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !req.valid() {
		writeError(w, http.StatusBadRequest, "bad_request", "exact owner, project, Agent, revision, provider and model are required")
		return
	}
	principal, err := s.store.RuntimeThreadPrincipal(r.Context(), realm, req.OwnerUserID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	c := caller{userID: principal.UserID, realm: principal.Realm, roles: map[string]bool{}}
	for _, role := range principal.Roles {
		c.roles[role] = true
	}
	task, err := s.store.GetDelegationTask(r.Context(), realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if task.ProjectID != req.ProjectID {
		writeError(w, http.StatusForbidden, "thread_project_mismatch", "Thread task must belong to its fixed project")
		return
	}
	access, err := s.store.TaskAccess(r.Context(), realm, task.ID, principal.UserID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if access != "contributor" {
		writeError(w, http.StatusForbidden, "forbidden", "current task contributor access required")
		return
	}
	decision, err := s.permissionDecision(r.Context(), c, actionDelegate, domain.PermissionResource{
		Kind: "task", ID: task.ID, ProjectID: task.ProjectID,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if !decision.Allowed {
		writeError(w, http.StatusForbidden, "forbidden", decision.Reason)
		return
	}
	if task.State == domain.DelegationCompleted || task.State == domain.DelegationFailed || task.State == domain.DelegationCancelled || task.State == domain.DelegationCancelling ||
		task.BusinessState == domain.BusinessDone || task.BusinessState == domain.BusinessRejected || task.BusinessState == domain.BusinessArchived {
		writeError(w, http.StatusConflict, "thread_task_inactive", "terminal or cancelling tasks cannot start a Thread round")
		return
	}
	preset, err := s.store.GetAgentPreset(r.Context(), realm, req.AgentID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if preset.Status != "active" || preset.OwnerUserID != principal.UserID || preset.ProjectID != req.ProjectID ||
		preset.Revision != req.PresetRevision || preset.Provider != req.Provider || preset.ModelRef != req.Model {
		writeError(w, http.StatusForbidden, "thread_preset_mismatch", "current Agent preset differs from the fixed Thread execution identity")
		return
	}
	if len(preset.ConnectorIDs) != 0 || len(preset.KnowledgeSpaceIDs) != 0 || preset.SystemPromptRef != "" || preset.MaxBudgetCents != 0 {
		writeError(w, http.StatusUnprocessableEntity, "thread_profile_unsupported", "Thread rounds currently support text only: connector, knowledge, protected prompt and monetary cap enforcement are unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"realm": realm, "user_id": principal.UserID, "project_id": task.ProjectID, "task_id": task.ID, "preset": preset,
		"current_authorization": map[string]any{
			"user_status": "active", "roles": principal.Roles, "task_access": access, "permission": decision,
			"task_state": task.State, "business_state": task.BusinessState, "checked_at": time.Now().UTC(),
		},
	})
}
