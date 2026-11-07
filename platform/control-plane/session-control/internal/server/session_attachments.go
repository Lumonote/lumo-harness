package server

import (
	"context"
	"github.com/lumo-harness/platform/session-control/internal/store"
	"net/http"
)

type SessionAttachmentStore interface {
	SessionAttachments(context.Context, string, store.AttachmentRequest) ([]store.AttachmentReceipt, error)
}

func (s *Server) handleSessionAttachments(w http.ResponseWriter, r *http.Request) {
	persistence, ok := s.opts.Owners.(SessionAttachmentStore)
	if !ok {
		ownerJSON(w, 503, map[string]string{"error": "attachment_store_unavailable"})
		return
	}
	var in store.AttachmentRequest
	if r.URL.RawQuery != "" || decodeOwnerJSON(r, &in) != nil {
		ownerError(w, store.ErrOwnerInvalid)
		return
	}
	receipts, err := persistence.SessionAttachments(r.Context(), r.PathValue("ref"), in)
	if err != nil {
		ownerError(w, err)
		return
	}
	ownerJSON(w, 200, map[string]any{"receipts": receipts})
}
