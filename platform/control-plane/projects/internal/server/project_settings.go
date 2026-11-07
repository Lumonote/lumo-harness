package server

import (
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/lumo-harness/platform/projects/internal/domain"
	"github.com/lumo-harness/platform/projects/internal/store"
)

func projectName(raw string) (string, bool) {
	name := strings.TrimSpace(raw)
	if name == "" || utf8.RuneCountInString(name) > 120 {
		return name, false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return name, false
		}
	}
	return name, true
}

func (s *Server) projectWriteError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, store.ErrWriteForbidden):
		http.Error(w, `{"error":"current membership does not authorize this write"}`, http.StatusForbidden)
	case errors.Is(err, store.ErrArchived):
		http.Error(w, `{"error":"archived project is read-only"}`, http.StatusConflict)
	case errors.Is(err, store.ErrNameTaken):
		http.Error(w, `{"error":"name taken in realm"}`, http.StatusConflict)
	case errors.Is(err, store.ErrResourceStale):
		http.Error(w, `{"error":"resource changed; reload before updating"}`, http.StatusConflict)
	case errors.Is(err, store.ErrNameStale):
		http.Error(w, `{"error":"project name changed; reload before renaming"}`, http.StatusConflict)
	case errors.Is(err, store.ErrResourceConflict):
		http.Error(w, `{"error":"resource conflicts with project scope or existing name"}`, http.StatusConflict)
	case errors.Is(err, store.ErrNotFound):
		http.Error(w, `{"error":"resource not found"}`, http.StatusNotFound)
	case errors.Is(err, store.ErrInvalidResource):
		http.Error(w, `{"error":"invalid project resource"}`, http.StatusBadRequest)
	default:
		return false
	}
	return true
}

func (s *Server) rename(w http.ResponseWriter, r *http.Request) {
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
		http.Error(w, `{"error":"valid name (1–120 characters) and expectedName are required"}`, http.StatusBadRequest)
		return
	}
	p, err := s.store.RenameProject(r.Context(), id, name, *req.ExpectedName)
	if err != nil {
		if !s.projectWriteError(w, err) {
			s.log.Error("rename project", "err", err)
			http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		}
		return
	}
	writeJSON(w, http.StatusOK, p)
}
