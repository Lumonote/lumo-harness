package server

import (
	"context"
	"net/http"

	"github.com/lumo-harness/platform/session-control/internal/store"
)

type SessionMigrationStore interface {
	SessionMigration(context.Context, string, string, string) (store.SessionMigration, error)
	CheckpointSessionMigration(context.Context, string, store.SessionMigrationCheckpoint) (store.SessionMigration, error)
	ActivateSessionMigration(context.Context, string, string, store.SessionMigrationActivation) (store.SessionMigration, error)
}

// Internal service-token surface. Each mutation additionally requires the
// unexported current node credential; browsers cannot select an owner proof.
func (s *Server) handleSessionMigration(w http.ResponseWriter, r *http.Request) {
	st, ok := s.opts.Owners.(SessionMigrationStore)
	if !ok {
		ownerJSON(w, 503, map[string]string{"error": "session_migration_unavailable"})
		return
	}
	var m store.SessionMigration
	var err error
	switch {
	case r.Method == http.MethodGet:
		m, err = st.SessionMigration(r.Context(), r.URL.Query().Get("realm"), r.PathValue("ref"), r.URL.Query().Get("id"))
	case r.PathValue("migrationID") != "":
		var in store.SessionMigrationActivation
		if decodeOwnerJSON(r, &in) != nil {
			ownerError(w, store.ErrOwnerInvalid)
			return
		}
		m, err = st.ActivateSessionMigration(r.Context(), r.PathValue("ref"), r.PathValue("migrationID"), in)
	default:
		var in store.SessionMigrationCheckpoint
		if decodeOwnerJSON(r, &in) != nil {
			ownerError(w, store.ErrOwnerInvalid)
			return
		}
		m, err = st.CheckpointSessionMigration(r.Context(), r.PathValue("ref"), in)
	}
	if err != nil {
		ownerError(w, err)
		return
	}
	ownerJSON(w, 200, map[string]any{"migration": m})
}
