package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/store"
)

func (s *Server) managementRole(w http.ResponseWriter, r *http.Request, projectID string, c caller) (string, bool, bool) {
	role, active, err := s.store.ManagementProjectRole(r.Context(), projectID, c.realm, c.user)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "project membership required"})
		return "", false, false
	}
	if err != nil {
		s.log.Error("read flow management membership", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return "", false, false
	}
	return role, active, true
}

func flowReviewer(c caller) bool { return c.hasRole("manager") || c.hasRole("admin") }

func (s *Server) listManaged(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("pid")
	role, _, ok := s.managementRole(w, r, projectID, c)
	if !ok {
		return
	}
	flows, err := s.store.ListManagedFlows(r.Context(), projectID, c.realm, c.user, flowReviewer(c))
	if err != nil {
		s.log.Error("list managed flows", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	changes, err := s.store.ManagedChangeStates(r.Context(), projectID, c.realm, c.user, flowReviewer(c))
	if err != nil {
		s.writeManagementError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"flows": flows, "changes": changes, "yourRole": role})
}

func (s *Server) managedFlow(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	f, err := s.store.GetFlow(r.Context(), r.PathValue("id"), c.realm)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": "flow unavailable"})
		return
	}
	role, active, ok := s.managementRole(w, r, f.ProjectID, c)
	if !ok {
		return
	}
	if !canSee(f, c) && !(f.Status == domain.StatusSubmitted && flowReviewer(c)) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "flow not found"})
		return
	}
	change, err := s.store.FlowChangeDraft(r.Context(), f.ID, c.realm, c.user, flowReviewer(c))
	if err != nil {
		s.writeManagementError(w, err)
		return
	}
	canAuthor := active && f.Author == c.user && (role == domain.RoleOwner || role == domain.RoleEditor)
	published := active && (f.Status == domain.StatusPublished || f.Status == domain.StatusTargeted)
	editable := canAuthor && (f.Status == domain.StatusDraft || (published && change != nil && change.Status == domain.StatusDraft))
	if r.Method == http.MethodPatch {
		if !editable {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the draft author can edit"})
			return
		}
		var req struct {
			Name              string          `json:"name"`
			ExpectedUpdatedAt time.Time       `json:"expectedUpdatedAt"`
			ChangeID          string          `json:"changeId"`
			ChangeRevision    int64           `json:"changeRevision"`
			Definition        json.RawMessage `json:"definition"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil || (change == nil && req.ExpectedUpdatedAt.IsZero()) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name, definition and expectedUpdatedAt required"})
			return
		}
		req.Name = strings.TrimSpace(req.Name)
		definition, _, err := parseDefinition(req.Definition)
		if err != nil || req.Name == "" || len([]rune(req.Name)) > 160 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid flow name or definition"})
			return
		}
		if change != nil {
			if req.Name != f.Name {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a version change cannot rename the published flow"})
				return
			}
			err = s.store.ApplyFlowChange(r.Context(), f.ID, c.realm, c.user, flowReviewer(c), store.FlowChangeCommand{Command: "save", ID: req.ChangeID, Revision: req.ChangeRevision, Definition: definition})
			if err != nil {
				s.writeManagementError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
			return
		}
		updated, err := s.store.UpdateManagedDraft(r.Context(), f.ID, c.realm, c.user, req.Name, req.ExpectedUpdatedAt, definition)
		if err != nil {
			if errors.Is(err, store.ErrEditConflict) || errors.Is(err, store.ErrNameTaken) {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			s.log.Error("update managed flow draft", "err", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
			return
		}
		writeJSON(w, http.StatusOK, updated)
		return
	}
	definition, err := s.store.ManagedDefinition(r.Context(), f.ID, c.realm, c.user, flowReviewer(c))
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "flow not found"})
		return
	}
	if err != nil {
		s.log.Error("read managed flow definition", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "definition unavailable"})
		return
	}
	if change != nil {
		definition = change.Definition
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"flow": f, "definition": definition, "change": change, "capabilities": map[string]bool{
		"edit": editable, "submit": editable,
		"review":        active && flowReviewer(c) && f.Author != c.user && (f.Status == domain.StatusSubmitted || (published && change != nil && change.Status == domain.StatusSubmitted)),
		"target":        published && role == domain.RoleOwner,
		"rollback":      published && role == domain.RoleOwner && f.Version > 0,
		"createChange":  canAuthor && published && change == nil,
		"discardChange": canAuthor && published && change != nil,
	}})
}

func (s *Server) writeManagementError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrEditConflict), errors.Is(err, store.ErrOnlyDraft), errors.Is(err, store.ErrNameTaken):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, store.ErrManagementForbidden):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
	default:
		s.log.Error("flow management failed", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
	}
}

func (s *Server) changeFlow(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var req struct {
		Command  string `json:"command"`
		ID       string `json:"changeId"`
		Revision int64  `json:"revision"`
		Approve  bool   `json:"approve"`
		Comment  string `json:"comment"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "change command required"})
		return
	}
	switch req.Command {
	case "create":
		id, err := newFlowID()
		if err != nil {
			s.writeManagementError(w, err)
			return
		}
		req.ID = id
	case "submit", "review", "discard":
		if req.Revision < 1 || req.ID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "changeId and revision required"})
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown change command"})
		return
	}
	if len([]rune(req.Comment)) > 1000 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "review comment exceeds 1000 characters"})
		return
	}
	err := s.store.ApplyFlowChange(r.Context(), r.PathValue("id"), c.realm, c.user, flowReviewer(c), store.FlowChangeCommand{
		Command: req.Command, ID: req.ID, Revision: req.Revision, Approve: req.Approve, Comment: strings.TrimSpace(req.Comment),
	})
	if err != nil {
		s.writeManagementError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}
