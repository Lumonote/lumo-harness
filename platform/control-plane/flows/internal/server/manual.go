package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/engine"
	"github.com/lumo-harness/platform/flows/internal/store"
	"github.com/lumo-harness/platform/observability"
)

func (s *Server) executeManualRun(w http.ResponseWriter, r *http.Request, c caller, f *domain.Flow, version int, def *domain.Definition, input any) {
	key := r.Header.Get("Idempotency-Key")
	if len(key) > 200 || strings.IndexFunc(key, func(c rune) bool {
		return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("_.:-", c))
	}) >= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid Idempotency-Key"})
		return
	}
	requestKey := "key:" + key
	if key == "" {
		id, err := newFlowID()
		if err != nil {
			s.writeManagementError(w, err)
			return
		}
		requestKey = "generated:" + id
	}
	payload, err := json.Marshal(input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid input"})
		return
	}
	run, started, err := s.store.StartManualRun(r.Context(), c.realm, c.user, f.ID, requestKey, version, payload)
	if errors.Is(err, store.ErrManualInputConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		s.writeManagementError(w, err)
		return
	}
	w.Header().Set("X-Lumo-Flow-Run", strconv.FormatInt(run.ID, 10))
	w.Header().Set("Location", fmt.Sprintf("/v1/flows/%s/runs/%d/result", f.ID, run.ID))
	if !started {
		s.writeManualRun(w, run)
		return
	}
	// Client disconnect is not cancellation. Bound execution independently and
	// finalize with a fresh context so a deadline cannot discard the receipt.
	executionCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), store.RunTimeout)
	defer cancel()
	if key != "" {
		scope, _ := json.Marshal([]string{"manual", f.ID, strconv.Itoa(version), key})
		executionCtx = engine.WithExecutionKey(executionCtx, string(scope))
	}
	dept := ""
	if len(c.depts) > 0 {
		dept = c.depts[0]
	}
	_, runErr := s.engine.RunWithRecorder(engine.WithIdentity(executionCtx, observability.Identity{Realm: c.realm, UserID: c.user, Roles: c.roles, ProjectID: f.ProjectID, DeptID: dept}), def, input, manualRecorder{store: s.store, runID: run.ID})
	finalCtx, finalCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer finalCancel()
	finished, err := s.store.FinishManualRun(finalCtx, run.ID, runErr)
	if err != nil {
		s.log.Error("finalize manual flow run", "run_id", run.ID, "err", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "execution outcome could not be recorded; inspect run before retry", "runId": run.ID})
		return
	}
	s.writeManualRun(w, finished)
}

type manualRecorder struct {
	store *store.Store
	runID int64
}

func (m manualRecorder) Started(ctx context.Context, node domain.FlowNode) error {
	receiptCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return m.store.StartManualNode(receiptCtx, m.runID, node.ID, node.Operator)
}

func (m manualRecorder) Finished(ctx context.Context, node domain.FlowNode, output any, nodeErr error) error {
	// The operator's deadline must not discard its final receipt.
	receiptCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	status := "succeeded"
	if nodeErr != nil {
		status = "failed"
		if errors.Is(nodeErr, context.DeadlineExceeded) || errors.Is(nodeErr, context.Canceled) {
			status = "unknown"
			nodeErr = fmt.Errorf("execution interrupted; outcome may be unknown; inspect effects before retry: %w", nodeErr)
		}
	}
	raw, err := json.Marshal(output)
	if err != nil {
		return err
	}
	return m.store.FinishManualNode(receiptCtx, m.runID, node.ID, status, raw, nodeErr)
}

func (s *Server) writeManualRun(w http.ResponseWriter, run store.ManualRun) {
	switch run.Status {
	case "running":
		writeJSON(w, http.StatusAccepted, map[string]any{"runId": run.ID, "status": run.Status})
	case "succeeded":
		writeJSON(w, http.StatusOK, run.Output)
	default:
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"runId": run.ID, "error": run.Error})
	}
}

func (s *Server) manualRunResult(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	f, err := s.store.GetFlow(r.Context(), r.PathValue("id"), c.realm)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "flow not found"})
		return
	}
	if _, ok := s.requireProjectMember(w, r, f.ProjectID, c); !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("run"), 10, 64)
	if err != nil || id < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid run id"})
		return
	}
	run, err := s.store.ManualRunResult(r.Context(), c.realm, c.user, f.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "run not found"})
		return
	}
	if err != nil {
		s.writeManagementError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, run)
}
