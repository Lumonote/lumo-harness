package server

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/lumo-harness/platform/session-control/internal/store"
	"github.com/lumo-harness/platform/storageledger"
	"io"
	"net/http"
	"strconv"
	"strings"
)

type SessionOwnerStore interface {
	ReserveSessionOwner(context.Context, store.ReserveSessionOwner) (store.SessionOwner, string, error)
	ActivateSessionOwner(context.Context, string, string, string) (store.SessionOwner, error)
	SessionOwner(context.Context, string, string) (store.SessionOwner, error)
	SessionOwners(context.Context, string, string, string, string, int) ([]store.SessionOwner, error)
}

func ownerJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func decodeOwnerJSON(r *http.Request, v any) error {
	d := json.NewDecoder(io.LimitReader(r.Body, 8193))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("expected a single JSON object")
	}
	return nil
}
func ownerError(w http.ResponseWriter, err error) {
	status := 500
	code := "owner_store_unavailable"
	switch {
	case errors.Is(err, storageledger.ErrCoverage):
		status = 503
		code = "storage_accounting_pending"
	case errors.Is(err, storageledger.ErrQuota):
		status = 507
		code = "storage_quota_exceeded"
	case errors.Is(err, store.ErrExecutionFenced):
		status = 409
		code = "session_execution_fenced"
	case errors.Is(err, store.ErrOwnerInvalid):
		status = 400
		code = "invalid_owner_request"
	case errors.Is(err, store.ErrOwnerConflict):
		status = 409
		code = "owner_creation_conflict"
	case errors.Is(err, store.ErrNotFound):
		status = 404
		code = "owner_not_found"
	}
	ownerJSON(w, status, map[string]string{"error": code})
}

// These routes are internal service-token APIs; public callers cannot select an ownership identity.
func (s *Server) handleSessionOwners(w http.ResponseWriter, r *http.Request) {
	if s.opts.Owners == nil {
		ownerJSON(w, 503, map[string]string{"error": "owner_store_unavailable"})
		return
	}
	ref := strings.TrimPrefix(r.URL.Path, "/v1/session-owners")
	ref = strings.Trim(ref, "/")
	if ref == "" {
		switch r.Method {
		case http.MethodPost:
			var in store.ReserveSessionOwner
			if err := decodeOwnerJSON(r, &in); err != nil {
				ownerJSON(w, 400, map[string]string{"error": "invalid_owner_request"})
				return
			}
			o, token, err := s.opts.Owners.ReserveSessionOwner(r.Context(), in)
			if err != nil {
				ownerError(w, err)
				return
			}
			ownerJSON(w, 201, map[string]any{"owner": o, "creation_token": token})
		case http.MethodGet:
			q := r.URL.Query()
			limit := 100
			if q.Get("limit") != "" {
				n, err := strconv.Atoi(q.Get("limit"))
				if err != nil {
					ownerError(w, store.ErrOwnerInvalid)
					return
				}
				limit = n
			}
			var rows []store.SessionOwner
			var err error
			if q.Get("project_id") != "" && q.Get("node_id") == "" {
				projectStore, ok := s.opts.Owners.(interface {
					SessionOwnersForProject(context.Context, string, string, string, string, int) ([]store.SessionOwner, error)
				})
				if !ok {
					ownerJSON(w, 503, map[string]string{"error": "owner_store_unavailable"})
					return
				}
				rows, err = projectStore.SessionOwnersForProject(r.Context(), q.Get("realm"), q.Get("owner_user_id"), q.Get("project_id"), q.Get("after"), limit)
			} else {
				rows, err = s.opts.Owners.SessionOwners(r.Context(), q.Get("realm"), q.Get("owner_user_id"), q.Get("node_id"), q.Get("after"), limit)
			}
			if err != nil {
				ownerError(w, err)
				return
			}
			next := ""
			if len(rows) == limit {
				next = rows[len(rows)-1].SessionRef
			}
			ownerJSON(w, 200, map[string]any{"owners": rows, "next_cursor": next})
		default:
			ownerJSON(w, 405, map[string]string{"error": "method_not_allowed"})
		}
		return
	}
	if tail, ok := strings.CutSuffix(ref, "/activate"); ok {
		if r.Method != http.MethodPost {
			ownerJSON(w, 405, map[string]string{"error": "method_not_allowed"})
			return
		}
		var in struct {
			Realm         string `json:"realm"`
			CreationToken string `json:"creation_token"`
		}
		if err := decodeOwnerJSON(r, &in); err != nil {
			ownerError(w, store.ErrOwnerInvalid)
			return
		}
		o, err := s.opts.Owners.ActivateSessionOwner(r.Context(), in.Realm, tail, in.CreationToken)
		if err != nil {
			ownerError(w, err)
			return
		}
		ownerJSON(w, 200, map[string]any{"owner": o})
		return
	}
	if strings.Contains(ref, "/") {
		ownerJSON(w, 404, map[string]string{"error": "not_found"})
		return
	}
	if r.Method != http.MethodGet {
		ownerJSON(w, 405, map[string]string{"error": "method_not_allowed"})
		return
	}
	o, err := s.opts.Owners.SessionOwner(r.Context(), r.URL.Query().Get("realm"), ref)
	if err != nil {
		ownerError(w, err)
		return
	}
	ownerJSON(w, 200, map[string]any{"owner": o})
}
