package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/session-control/internal/store"
)

type SessionExecutionStore interface {
	AcquireExecutionNode(context.Context, store.ExecutionNodeRequest) (store.ExecutionNode, error)
	RenewExecutionNode(context.Context, store.ExecutionNodeRequest, bool) (store.ExecutionNode, error)
	ExecutionNode(context.Context, string, string, string) (store.ExecutionNode, error)
	SessionExecutionLease(context.Context, string, store.ExecutionLeaseRequest, string) (store.ExecutionLease, error)
}

func (s *Server) executionStore(w http.ResponseWriter) SessionExecutionStore {
	v, ok := s.opts.Owners.(SessionExecutionStore)
	if !ok {
		ownerJSON(w, 503, map[string]string{"error": "execution_authority_unavailable"})
		return nil
	}
	return v
}
func (s *Server) handleExecutionNode(w http.ResponseWriter, r *http.Request) {
	outcome := observability.BusinessUnavailable
	defer func() { observability.RecordBusinessResult(observability.BusinessSessionExecutionNode, outcome) }()
	st := s.executionStore(w)
	if st == nil {
		return
	}
	if r.Method == http.MethodGet {
		n, err := st.ExecutionNode(r.Context(), r.URL.Query().Get("realm"), r.PathValue("nodeID"), r.URL.Query().Get("project_id"))
		if err != nil {
			outcome = sessionBusinessOutcome(err)
			ownerError(w, err)
			return
		}
		outcome = observability.BusinessSuccess
		ownerJSON(w, 200, map[string]any{"node": n})
		return
	}
	var in store.ExecutionNodeRequest
	if decodeOwnerJSON(r, &in) != nil || in.NodeID != r.PathValue("nodeID") {
		outcome = observability.BusinessInvalid
		ownerError(w, store.ErrOwnerInvalid)
		return
	}
	var n store.ExecutionNode
	var err error
	switch r.PathValue("operation") {
	case "acquire":
		n, err = st.AcquireExecutionNode(r.Context(), in)
	case "renew", "release":
		n, err = st.RenewExecutionNode(r.Context(), in, r.PathValue("operation") == "release")
	default:
		outcome = observability.BusinessNotFound
		ownerJSON(w, 404, map[string]string{"error": "not_found"})
		return
	}
	if err != nil {
		outcome = sessionBusinessOutcome(err)
		ownerError(w, err)
		return
	}
	outcome = observability.BusinessSuccess
	ownerJSON(w, 200, map[string]any{"node": n})
}
func (s *Server) handleExecutionLease(w http.ResponseWriter, r *http.Request) {
	outcome := observability.BusinessUnavailable
	defer func() { observability.RecordBusinessResult(observability.BusinessSessionExecutionLease, outcome) }()
	st := s.executionStore(w)
	if st == nil {
		return
	}
	var in store.ExecutionLeaseRequest
	if decodeOwnerJSON(r, &in) != nil {
		outcome = observability.BusinessInvalid
		ownerError(w, store.ErrOwnerInvalid)
		return
	}
	mode := r.PathValue("operation")
	if mode != "acquire" && mode != "renew" && mode != "release" {
		outcome = observability.BusinessNotFound
		ownerJSON(w, 404, map[string]string{"error": "not_found"})
		return
	}
	l, err := st.SessionExecutionLease(r.Context(), r.PathValue("ref"), in, mode)
	if err != nil {
		outcome = sessionBusinessOutcome(err)
		ownerError(w, err)
		return
	}
	outcome = observability.BusinessSuccess
	ownerJSON(w, 200, map[string]any{"lease": l})
}

func sessionBusinessOutcome(err error) observability.BusinessOutcome {
	switch {
	case err == nil:
		return observability.BusinessSuccess
	case errors.Is(err, store.ErrExecutionFenced):
		return observability.BusinessFenced
	case errors.Is(err, store.ErrOwnerInvalid):
		return observability.BusinessInvalid
	case errors.Is(err, store.ErrOwnerConflict):
		return observability.BusinessConflict
	case errors.Is(err, store.ErrNotFound):
		return observability.BusinessNotFound
	default:
		return observability.BusinessUnavailable
	}
}
