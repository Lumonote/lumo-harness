package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/lumo-harness/platform/collaborator/internal/store"
)

func (s *Server) handleSpaceGrants(w http.ResponseWriter, r *http.Request) {
	if s.auth == nil {
		http.Error(w, "identity source unavailable", 503)
		return
	}
	ident, err := s.auth.Authenticate(r)
	if err != nil || ident.UserID == "" || ident.Realm == "" {
		http.Error(w, "trusted identity required", 401)
		return
	}
	if len(r.URL.Query()) != 0 {
		http.Error(w, "query parameters not accepted", 400)
		return
	}
	projectID, spaceID := r.PathValue("projectID"), r.PathValue("spaceID")
	if strings.TrimSpace(projectID) == "" || strings.TrimSpace(spaceID) == "" || len(projectID) > 256 || len(spaceID) > 256 {
		http.Error(w, "invalid scope", 400)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet {
		grants, err := s.store.ListSpaceGrants(r.Context(), string(ident.Realm), projectID, spaceID, ident.UserID)
		if err != nil {
			writeSpaceGrantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"grants": grants})
		return
	}
	var input struct {
		Permissions      []string `json:"permissions"`
		ExpectedRevision *int64   `json:"expectedRevision"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || input.ExpectedRevision == nil || decoder.Decode(&struct{}{}) != io.EOF {
		http.Error(w, "permissions and expectedRevision required", 400)
		return
	}
	grant, err := s.store.SetSpaceGrant(r.Context(), string(ident.Realm), projectID, spaceID, ident.UserID, r.PathValue("userID"), input.Permissions, *input.ExpectedRevision)
	if err != nil {
		writeSpaceGrantError(w, err)
		return
	}
	writeJSON(w, 200, grant)
}

func writeSpaceGrantError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrSpaceGrantForbidden):
		writeJSON(w, 403, map[string]string{"error": "当前项目所有者才可管理此空间授权，归档项目不能修改"})
	case errors.Is(err, store.ErrSpaceGrantConflict):
		writeJSON(w, 409, map[string]string{"error": "空间授权已变更，请刷新后重试"})
	case errors.Is(err, store.ErrSpaceGrantBadRequest):
		writeJSON(w, 400, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, 503, map[string]string{"error": "空间授权依赖暂不可用，未保存修改"})
	}
}
