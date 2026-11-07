package server

import (
	"net/http"
	"strings"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

// ConfigureSpaceAuthorization enables the service-only, current-grant read
// adapter. It uses its own credential gate even when Routes is embedded in a
// test or another host without the process-wide authentication middleware.
func (s *Server) ConfigureSpaceAuthorization(token string) { s.spaceAuthorizationToken = token }

func (s *Server) handleSpacePermissions(w http.ResponseWriter, r *http.Request) {
	if s.auth == nil {
		http.Error(w, "space identity source unavailable", http.StatusServiceUnavailable)
		return
	}
	ident, err := s.auth.Authenticate(r)
	if err != nil || strings.TrimSpace(ident.UserID) == "" || strings.TrimSpace(string(ident.Realm)) == "" {
		http.Error(w, "trusted caller identity required", http.StatusUnauthorized)
		return
	}
	space := strings.TrimSpace(r.PathValue("spaceID"))
	if space == "" || len(space) > 256 || len(r.URL.Query()) != 0 {
		http.Error(w, "space id required; query identity is not accepted", http.StatusBadRequest)
		return
	}
	perms, err := s.store.Permissions(r.Context(), ident.Realm, domain.SpaceID(space), ident.UserID)
	if err != nil {
		writeErr(w, err)
		return
	}
	if perms == nil {
		perms = []domain.Permission{}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"realm": ident.Realm, "space_id": space, "user_id": ident.UserID, "permissions": perms})
}
