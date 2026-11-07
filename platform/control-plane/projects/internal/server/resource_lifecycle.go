package server

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/lumo-harness/platform/projects/internal/domain"
)

var resourceIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

func validResourceID(value string) bool {
	return value != "." && value != ".." && resourceIDPattern.MatchString(value)
}

func (s *Server) renameSpace(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionEdit); !ok {
		return
	}
	var req struct {
		Name         string  `json:"name"`
		ExpectedName *string `json:"expectedName"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	name, valid := projectName(req.Name)
	if !valid || req.ExpectedName == nil {
		http.Error(w, `{"error":"valid name and expectedName required"}`, 400)
		return
	}
	space, err := s.store.RenameSpace(r.Context(), id, r.PathValue("spaceID"), name, *req.ExpectedName)
	if err != nil {
		if !s.projectWriteError(w, err) {
			s.log.Error("rename space", "err", err)
			http.Error(w, `{"error":"internal"}`, 500)
		}
		return
	}
	writeJSON(w, 200, space)
}
func (s *Server) deleteSpace(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionEdit); !ok {
		return
	}
	var req struct {
		ExpectedName *string `json:"expectedName"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ExpectedName == nil {
		http.Error(w, `{"error":"expectedName required"}`, 400)
		return
	}
	if err := s.store.DeleteSpace(r.Context(), id, r.PathValue("spaceID"), *req.ExpectedName); err != nil {
		if !s.projectWriteError(w, err) {
			s.log.Error("detach space", "err", err)
			http.Error(w, `{"error":"internal"}`, 500)
		}
		return
	}
	w.WriteHeader(204)
}

func expectedRevision(w http.ResponseWriter, r *http.Request, required bool) (*int64, bool) {
	raw := r.URL.Query().Get("expectedRevision")
	if raw == "" && !required {
		return nil, true
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 {
		http.Error(w, `{"error":"positive expectedRevision required"}`, 400)
		return nil, false
	}
	return &value, true
}

type automationWrite struct {
	ID               string `json:"automationId"`
	TriggerKind      string `json:"triggerKind"`
	TriggerSpec      string `json:"triggerSpec"`
	FlowRef          string `json:"flowRef"`
	Enabled          *bool  `json:"enabled"`
	ExpectedRevision *int64 `json:"expectedRevision"`
}

func (a automationWrite) valid() bool {
	if a.TriggerKind != "cron" && a.TriggerKind != "event" && a.TriggerKind != "webhook" {
		return false
	}
	if strings.TrimSpace(a.TriggerSpec) == "" || len(a.TriggerSpec) > 2048 || strings.TrimSpace(a.FlowRef) == "" || len(a.FlowRef) > 512 {
		return false
	}
	for _, r := range a.TriggerSpec + a.FlowRef {
		if unicode.IsControl(r) {
			return false
		}
	}
	return a.TriggerKind != "cron" || len(strings.Fields(a.TriggerSpec)) == 5
}
func (a automationWrite) domain(projectID, id string) domain.Automation {
	enabled := true
	if a.Enabled != nil {
		enabled = *a.Enabled
	}
	return domain.Automation{ID: id, ProjectID: projectID, TriggerKind: a.TriggerKind, TriggerSpec: strings.TrimSpace(a.TriggerSpec), FlowRef: strings.TrimSpace(a.FlowRef), Enabled: enabled}
}
func (s *Server) createAutomation(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionEdit); !ok {
		return
	}
	var req automationWrite
	if !decodeJSON(w, r, &req) {
		return
	}
	req.ID = strings.TrimSpace(req.ID)
	if !req.valid() || !validResourceID(req.ID) || req.ExpectedRevision != nil {
		http.Error(w, `{"error":"valid automationId, triggerKind, triggerSpec and flowRef required"}`, 400)
		return
	}
	saved, err := s.store.CreateAutomation(r.Context(), req.domain(id, strings.TrimSpace(req.ID)))
	if err != nil {
		if !s.projectWriteError(w, err) {
			s.log.Error("create automation", "err", err)
			http.Error(w, `{"error":"internal"}`, 500)
		}
		return
	}
	writeJSON(w, 201, saved)
}
func (s *Server) patchAutomation(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionEdit); !ok {
		return
	}
	var req automationWrite
	if !decodeJSON(w, r, &req) {
		return
	}
	if !req.valid() || req.ID != "" || req.ExpectedRevision == nil || *req.ExpectedRevision < 1 || req.Enabled == nil {
		http.Error(w, `{"error":"complete rule and positive expectedRevision required"}`, 400)
		return
	}
	saved, err := s.store.UpdateAutomation(r.Context(), req.domain(id, r.PathValue("automationId")), *req.ExpectedRevision)
	if err != nil {
		if !s.projectWriteError(w, err) {
			s.log.Error("update automation", "err", err)
			http.Error(w, `{"error":"internal"}`, 500)
		}
		return
	}
	writeJSON(w, 200, saved)
}

func (s *Server) deleteArtifact(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionEdit); !ok {
		return
	}
	var req struct {
		ExpectedVersion *string `json:"expectedVersion"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ExpectedVersion == nil || *req.ExpectedVersion == "" {
		http.Error(w, `{"error":"expectedVersion required"}`, 400)
		return
	}
	if err := s.store.DeleteArtifact(r.Context(), id, r.PathValue("kind"), r.PathValue("name"), *req.ExpectedVersion); err != nil {
		if !s.projectWriteError(w, err) {
			s.log.Error("detach artifact", "err", err)
			http.Error(w, `{"error":"internal"}`, 500)
		}
		return
	}
	w.WriteHeader(204)
}
