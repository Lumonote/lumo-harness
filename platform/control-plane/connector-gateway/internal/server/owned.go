package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
	"github.com/lumo-harness/platform/connector-gateway/internal/owned"
	"github.com/lumo-harness/platform/observability"
)

type ownedRequest struct {
	ProjectID   string            `json:"project_id"`
	Execution   owned.Scope       `json:"execution"`
	ConnectorID string            `json:"connector_id,omitempty"`
	Invocation  domain.Invocation `json:"invocation"`
	ReceiptID   string            `json:"receipt_id,omitempty"`
	Digest      string            `json:"digest,omitempty"`
	Revision    int64             `json:"revision,omitempty"`
	Approve     *bool             `json:"approve,omitempty"`
}

func ownedError(w http.ResponseWriter, err error) {
	status, code := http.StatusServiceUnavailable, "owned_connector_unavailable"
	outcome := observability.BusinessUnavailable
	if errors.Is(err, owned.ErrDenied) {
		outcome = observability.BusinessDenied
		status, code = http.StatusForbidden, "owned_connector_denied"
	}
	if errors.Is(err, owned.ErrChanged) {
		outcome = observability.BusinessConflict
		status, code = http.StatusConflict, "owned_connector_changed"
	}
	observability.RecordBusinessResult(observability.BusinessConnectorRequest, outcome)
	writeJSON(w, status, map[string]string{"error": code, "code": code})
}
func (s *Server) handleOwnedConnector(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.owned == nil {
		ownedError(w, errors.New("disabled"))
		return
	}
	var input ownedRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 96*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		ownedError(w, owned.ErrDenied)
		return
	}
	scope := input.Execution
	scope.ProjectID = input.ProjectID
	scope.SessionRef = r.PathValue("ref")
	credential := r.Header.Get("X-Lumo-Login-Session")
	caller, err := s.owned.Resolve(r.Context(), credential, scope)
	if err != nil {
		ownedError(w, err)
		return
	}
	scope.Realm = string(caller.Realm)
	scope.UserID = caller.UserID
	if err = s.owned.Store.Expire(r.Context()); err != nil {
		ownedError(w, err)
		return
	}
	switch r.PathValue("action") {
	case "list":
		connectors, err := s.reg.List(r.Context(), caller.Realm)
		if err != nil {
			ownedError(w, err)
			return
		}
		summaries := []map[string]any{}
		for _, conn := range connectors {
			ops := []map[string]any{}
			for _, op := range conn.Operations {
				if !s.owned.Allowed(scope, conn.ID, op.Name) {
					continue
				}
				allowed := false
				for _, role := range caller.Roles {
					for _, required := range conn.Roles {
						if role == required {
							allowed = true
						}
					}
				}
				if !allowed {
					continue
				}
				// High-sensitivity writes retain the existing independent-admin workflow.
				if op.Write && op.Sensitivity == "high" {
					continue
				}
				ops = append(ops, map[string]any{"name": op.Name, "method": op.Method, "write": op.Write, "pathParams": op.Path, "allowedQuery": op.AllowedQuery})
			}
			if len(ops) > 0 {
				summaries = append(summaries, map[string]any{"id": conn.ID, "name": conn.Name, "version": conn.Version, "operations": ops})
			}
		}
		observability.RecordBusinessResult(observability.BusinessConnectorRequest, observability.BusinessSuccess)
		writeJSON(w, 200, map[string]any{"connectors": summaries})
		return
	case "prepare":
		inv := input.Invocation
		inv.ConnectorID = input.ConnectorID
		if !s.owned.Allowed(scope, inv.ConnectorID, inv.Operation) {
			ownedError(w, owned.ErrDenied)
			return
		}
		conn, op, err := s.gw.Validate(r.Context(), caller, inv)
		if err != nil || op.Write && op.Sensitivity == "high" {
			ownedError(w, owned.ErrDenied)
			return
		}
		if op.Write {
			receipt, err := s.owned.Store.Create(r.Context(), scope, inv, conn.Version)
			if err != nil {
				ownedError(w, err)
				return
			}
			observability.RecordBusinessResult(observability.BusinessConnectorRequest, observability.BusinessSuccess)
			writeJSON(w, 200, map[string]any{"receipt": receipt})
			return
		}
		s.invokeOwned(w, r, scope, credential, caller, inv, "", conn.Version)
		return
	case "decide":
		if input.Approve == nil {
			ownedError(w, owned.ErrDenied)
			return
		}
		receipt, err := s.owned.Store.Get(r.Context(), scope, input.ReceiptID)
		if err != nil {
			ownedError(w, err)
			return
		}
		if !s.owned.Allowed(scope, receipt.ConnectorID, receipt.Operation) {
			ownedError(w, owned.ErrDenied)
			return
		}
		result, err := s.owned.Store.Decide(r.Context(), scope, input.ReceiptID, input.Digest, input.Revision, *input.Approve)
		if err != nil {
			ownedError(w, err)
			return
		}
		observability.RecordBusinessResult(observability.BusinessConnectorRequest, observability.BusinessSuccess)
		writeJSON(w, 200, map[string]any{"receipt": result})
		return
	case "execute":
		receipt, err := s.owned.Store.Get(r.Context(), scope, input.ReceiptID)
		if err != nil {
			ownedError(w, err)
			return
		}
		if !s.owned.Allowed(scope, receipt.ConnectorID, receipt.Operation) {
			ownedError(w, owned.ErrDenied)
			return
		}
		var inv domain.Invocation
		if json.Unmarshal(receipt.Payload, &inv) != nil {
			ownedError(w, owned.ErrChanged)
			return
		}
		inv.ConnectorID = receipt.ConnectorID
		conn, op, err := s.gw.Validate(r.Context(), caller, inv)
		if err != nil || !op.Write || op.Sensitivity == "high" || conn.Version != receipt.ConnectorVersion {
			ownedError(w, owned.ErrChanged)
			return
		}
		// Resolve immediately before atomically consuming consent. This checks the
		// current owner/project/login and persistent lease again after policy I/O.
		caller, err = s.owned.Resolve(r.Context(), credential, scope)
		if err != nil {
			ownedError(w, err)
			return
		}
		if _, err = s.owned.Store.Consume(r.Context(), scope, input.ReceiptID, input.Digest, input.Revision); err != nil {
			ownedError(w, err)
			return
		}
		s.invokeOwned(w, r, scope, credential, caller, inv, receipt.ID, receipt.ConnectorVersion)
		return
	default:
		ownedError(w, owned.ErrDenied)
	}
}
func (s *Server) invokeOwned(w http.ResponseWriter, r *http.Request, scope owned.Scope, credential string, caller domain.Caller, inv domain.Invocation, receiptID string, version int) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	// Revocation or execution fencing cancels in-flight I/O. An external system
	// can still have committed a request; no cancellation grants a replay token.
	done := make(chan struct{})
	defer close(done)
	go func() {
		timer := time.NewTicker(time.Second)
		defer timer.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-timer.C:
				if _, err := s.owned.Resolve(ctx, credential, scope); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	current, err := s.owned.Resolve(ctx, credential, scope)
	var result domain.Result
	if err == nil {
		result, err = s.gw.InvokeVersion(ctx, current, inv, version)
	}
	if err == nil {
		_, err = s.owned.Resolve(ctx, credential, scope)
	}
	outcome := "succeeded"
	if err != nil || ctx.Err() != nil {
		outcome = "unknown"
	} else if result.Status >= 400 {
		outcome = "failed"
	}
	metricOutcome := observability.BusinessSuccess
	if outcome == "unknown" {
		metricOutcome = observability.BusinessUnknown
	} else if outcome == "failed" {
		metricOutcome = observability.BusinessFailed
	}
	// Record uncertainty before receipt persistence: a database failure must not
	// hide an external side effect whose result is unknown and cannot be replayed.
	observability.RecordBusinessResult(observability.BusinessConnectorInvoke, metricOutcome)
	if receiptID != "" {
		// Use a short independent context to persist an unknown outcome even when
		// the user connection or execution lease was revoked during the request.
		persist, stop := context.WithTimeout(context.Background(), 3*time.Second)
		completeErr := s.owned.Store.Complete(persist, receiptID, outcome)
		stop()
		if completeErr != nil {
			ownedError(w, completeErr)
			return
		}
	}
	if outcome == "unknown" {
		observability.RecordBusinessResult(observability.BusinessConnectorRequest, observability.BusinessUnknown)
		writeJSON(w, 502, map[string]string{"error": "connector_outcome_unknown", "code": "connector_outcome_unknown"})
		return
	}
	observability.RecordBusinessResult(observability.BusinessConnectorRequest, metricOutcome)
	// Connector credentials remain inside Gateway's resolver. Its result is
	// already bounded and redacted; never return raw gateway failure text here.
	writeJSON(w, 200, map[string]any{"result": result, "outcome": outcome})
}
