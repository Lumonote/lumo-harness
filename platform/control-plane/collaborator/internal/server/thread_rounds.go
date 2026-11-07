package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/lumo-harness/platform/collaborator/internal/store"
)

// These routes share the collaborator's service-token boundary. The node
// validates current governance authority before admission and while running;
// a durable receipt alone never grants permission to execute a model turn.
func decodeThreadRound(w http.ResponseWriter, r *http.Request, body any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 96*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(body); err != nil {
		http.Error(w, "invalid thread round request", http.StatusBadRequest)
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		http.Error(w, "one JSON request required", http.StatusBadRequest)
		return false
	}
	return true
}

func (s *Server) handleAdmitThreadRound(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	var body struct {
		store.ThreadRoundIdentity
		NodeID                string `json:"node_id"`
		CoordinatorSessionRef string `json:"coordinator_session_ref"`
		TaskID                string `json:"task_id"`
		Attempt               int    `json:"attempt"`
		RequestHash           string `json:"request_hash"`
		RunID                 string `json:"run_id"`
	}
	if !decodeThreadRound(w, r, &body) {
		return
	}
	if body.OwnerUserID != ident.UserID {
		http.Error(w, "round owner does not match authenticated node user", http.StatusForbidden)
		return
	}
	receipt, admitted, err := s.store.AdmitThreadRound(r.Context(), string(ident.Realm), r.PathValue("threadID"),
		body.NodeID, body.CoordinatorSessionRef, body.TaskID, body.Attempt, body.RequestHash, body.RunID, body.ThreadRoundIdentity)
	if err != nil {
		writeThreadRoundErr(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if admitted {
		writeJSON(w, http.StatusCreated, map[string]any{"admitted": true, "token": receipt.Token, "receipt": receipt})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"admitted": false, "receipt": receipt})
}

func (s *Server) handleGetThreadRound(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	receipt, err := s.store.GetThreadRound(r.Context(), string(ident.Realm), r.PathValue("threadID"), r.PathValue("runID"))
	if err != nil {
		writeThreadRoundErr(w, err)
		return
	}
	if receipt.OwnerUserID != ident.UserID {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, receipt)
}

func (s *Server) handleFinishThreadRound(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	var body struct {
		Token   string `json:"token"`
		State   string `json:"state"`
		Summary string `json:"summary"`
	}
	if !decodeThreadRound(w, r, &body) {
		return
	}
	// Recheck owner even for a replay; possession of an old receipt does not
	// turn another user into the owner of the stable session.
	receipt, err := s.store.GetThreadRound(r.Context(), string(ident.Realm), r.PathValue("threadID"), r.PathValue("runID"))
	if err != nil {
		writeThreadRoundErr(w, err)
		return
	}
	if receipt.OwnerUserID != ident.UserID {
		http.NotFound(w, r)
		return
	}
	receipt, err = s.store.FinishThreadRound(r.Context(), string(ident.Realm), r.PathValue("threadID"), r.PathValue("runID"), body.Token, body.State, body.Summary)
	if err != nil {
		writeThreadRoundErr(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, receipt)
}

func writeThreadRoundErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrThreadRoundNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, store.ErrThreadRoundConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	default:
		writeThreadErr(w, err)
	}
}
