package server

import (
	"encoding/json"
	"github.com/lumo-harness/platform/collaborator/internal/store"
	"io"
	"net/http"
)

func decodeThreadCommand(w http.ResponseWriter, r *http.Request, body any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 384*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(body); err != nil {
		http.Error(w, "invalid thread command", http.StatusBadRequest)
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		http.Error(w, "one JSON command required", http.StatusBadRequest)
		return false
	}
	return true
}

func (s *Server) handleEnqueueThreadCommand(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	var c store.ThreadCommand
	if !decodeThreadCommand(w, r, &c) {
		return
	}
	if c.Realm != "" && c.Realm != string(ident.Realm) || c.OwnerUserID != "" && c.OwnerUserID != ident.UserID {
		http.Error(w, "command identity mismatch", 403)
		return
	}
	c.Realm = string(ident.Realm)
	c.OwnerUserID = ident.UserID
	c.ThreadID = r.PathValue("threadID")
	saved, created, err := s.store.EnqueueThreadCommand(r.Context(), c)
	if err != nil {
		writeThreadRoundErr(w, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, saved)
}
func (s *Server) handleGetThreadCommand(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	c, err := s.store.GetThreadCommand(r.Context(), string(ident.Realm), r.PathValue("commandID"), ident.UserID)
	if err != nil {
		writeThreadRoundErr(w, err)
		return
	}
	writeJSON(w, 200, c)
}
func (s *Server) handleWakeThreadCommand(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	var b struct {
		Key   string `json:"wake_key"`
		Event string `json:"event_id"`
	}
	if !decodeThreadRound(w, r, &b) {
		return
	}
	c, err := s.store.WakeThreadCommand(r.Context(), string(ident.Realm), r.PathValue("commandID"), ident.UserID, b.Key, b.Event)
	if err != nil {
		writeThreadRoundErr(w, err)
		return
	}
	writeJSON(w, 200, c)
}
func (s *Server) handleClaimThreadCommand(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	var b struct {
		Node string `json:"node_id"`
	}
	if !decodeThreadRound(w, r, &b) {
		return
	}
	if b.Node == "" {
		http.Error(w, "node required", 400)
		return
	}
	c, err := s.store.ClaimThreadCommand(r.Context(), string(ident.Realm), b.Node, ident.UserID)
	if err != nil {
		writeThreadRoundErr(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"command": c})
}
func (s *Server) handleFinishThreadCommand(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	var b struct {
		Node    string `json:"node_id"`
		Token   string `json:"claim_token"`
		State   string `json:"state"`
		Run     string `json:"run_id"`
		Summary string `json:"summary"`
	}
	if !decodeThreadRound(w, r, &b) {
		return
	}
	c, err := s.store.FinishThreadCommand(r.Context(), string(ident.Realm), r.PathValue("commandID"), b.Node, ident.UserID, b.Token, b.State, b.Run, b.Summary)
	if err != nil {
		writeThreadRoundErr(w, err)
		return
	}
	writeJSON(w, 200, c)
}
func (s *Server) registerThreadCommandRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /threads/{threadID}/commands", s.handleEnqueueThreadCommand)
	m.HandleFunc("GET /thread-commands/{commandID}", s.handleGetThreadCommand)
	m.HandleFunc("POST /thread-commands/{commandID}/wake", s.handleWakeThreadCommand)
	m.HandleFunc("POST /thread-commands/claim", s.handleClaimThreadCommand)
	m.HandleFunc("POST /thread-commands/{commandID}/finish", s.handleFinishThreadCommand)
}
