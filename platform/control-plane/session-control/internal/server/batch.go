package server

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/session-control/internal/state"
	"github.com/lumo-harness/platform/session-control/internal/store"
)

// Batch reads consume only caller-authorized references, never enumerate a realm.
// Like other control-plane routes, trusted services authenticate with the shared
// Bearer token; the browser-facing proxy supplies identity and enforces visibility.
type controlsReader interface {
	Controls(context.Context, string, []string) ([]store.Row, error)
}

type controlSummary struct {
	SessionRef string       `json:"session_ref"`
	Registered bool         `json:"registered"`
	State      *state.State `json:"state"`
	Revision   int64        `json:"revision"`
	UpdatedAt  *time.Time   `json:"updated_at,omitempty"`
}

func (s *Server) handleControls(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "控制态列表只接受 GET")
		return
	}
	realm := strings.TrimSpace(r.Header.Get("X-Lumo-Realm"))
	if realm == "" || strings.TrimSpace(r.Header.Get("X-Lumo-User")) == "" {
		writeError(w, http.StatusUnauthorized, "identity_required", "需要可信调用方的 realm 与用户身份")
		return
	}
	refs := r.URL.Query()["session_ref"]
	if len(refs) == 0 || len(refs) > store.MaxControlBatch {
		writeError(w, http.StatusBadRequest, "invalid_sessions", "session_ref 必填，单次最多 100 个")
		return
	}
	seen := make(map[string]bool, len(refs))
	unique := make([]string, 0, len(refs))
	for _, ref := range refs {
		if strings.TrimSpace(ref) == "" || len(ref) > 512 {
			writeError(w, http.StatusBadRequest, "invalid_sessions", "会话标识为空或过长")
			return
		}
		if !seen[ref] {
			seen[ref] = true
			unique = append(unique, ref)
		}
	}
	reader, ok := s.opts.Store.(controlsReader)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "no_store", "控制态批量读面未装配")
		return
	}
	rows, err := reader.Controls(r.Context(), realm, unique)
	if err != nil {
		s.log.Error("批量读取控制态失败", "realm", realm, "err", err)
		writeError(w, http.StatusServiceUnavailable, "store_unavailable", "控制态暂时不可读")
		return
	}
	byRef := make(map[string]store.Row, len(rows))
	for _, row := range rows {
		if row.Realm == realm && seen[row.SessionRef] {
			byRef[row.SessionRef] = row
		}
	}
	items := make([]controlSummary, 0, len(unique))
	for _, ref := range unique {
		item := controlSummary{SessionRef: ref}
		if row, found := byRef[ref]; found {
			st, at := row.State, row.UpdatedAt
			item.Registered, item.State, item.Revision, item.UpdatedAt = true, &st, row.Revision, &at
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"realm": realm, "controls": items})
}
