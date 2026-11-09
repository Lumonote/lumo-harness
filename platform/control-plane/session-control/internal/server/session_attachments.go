package server

import (
	"context"
	"errors"
	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/session-control/internal/store"
	"net/http"
)

type SessionAttachmentStore interface {
	SessionAttachments(context.Context, string, store.AttachmentRequest) ([]store.AttachmentReceipt, error)
}
type SessionAttachmentInventoryStore interface {
	SessionAttachmentInventory(context.Context, string, store.AttachmentRequest) (store.AttachmentInventory, error)
}

func (s *Server) handleSessionAttachments(w http.ResponseWriter, r *http.Request) {
	outcome := observability.BusinessUnavailable
	defer func() { observability.RecordBusinessResult(observability.BusinessSessionAttachment, outcome) }()
	persistence, ok := s.opts.Owners.(SessionAttachmentStore)
	if !ok {
		ownerJSON(w, 503, map[string]string{"error": "attachment_store_unavailable"})
		return
	}
	var in store.AttachmentRequest
	if r.URL.RawQuery != "" || decodeOwnerJSON(r, &in) != nil {
		outcome = observability.BusinessInvalid
		ownerError(w, store.ErrOwnerInvalid)
		return
	}
	if in.Operation == "inventory" {
		inventoryStore, ok := persistence.(SessionAttachmentInventoryStore)
		if !ok {
			ownerJSON(w, 503, map[string]string{"error": "attachment_store_unavailable"})
			return
		}
		page, err := inventoryStore.SessionAttachmentInventory(r.Context(), r.PathValue("ref"), in)
		if err != nil {
			outcome = sessionBusinessOutcome(err)
			ownerError(w, err)
			return
		}
		outcome = observability.BusinessSuccess
		ownerJSON(w, 200, page)
		return
	}
	receipts, err := persistence.SessionAttachments(r.Context(), r.PathValue("ref"), in)
	if err != nil {
		if errors.Is(err, store.ErrAttachmentCapacity) {
			outcome = observability.BusinessInvalid
			ownerJSON(w, 409, map[string]string{"error": "session_attachment_capacity"})
			return
		}
		outcome = sessionBusinessOutcome(err)
		ownerError(w, err)
		return
	}
	outcome = observability.BusinessSuccess
	ownerJSON(w, 200, map[string]any{"receipts": receipts})
}
