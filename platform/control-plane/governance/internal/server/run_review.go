package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
	"github.com/lumo-harness/platform/observability"
)

func (s *Server) registerRunReviewRoutes(mux *http.ServeMux) {
	mux.Handle("PUT /v1/runtime/task-runs/{runID}/prepare", observability.RequireControlPlaneToken(s.cfg.ControlPlaneToken)(http.HandlerFunc(s.prepareRunExecution)))
	mux.Handle("GET /v1/runtime/task-runs/{runID}/review-files/{entryID}", observability.RequireControlPlaneToken(s.cfg.ControlPlaneToken)(http.HandlerFunc(s.readRunReviewFile)))
	mux.HandleFunc("POST /v1/tasks/{taskID}/runs/{runID}/reviews", s.bindRunReview)
	mux.HandleFunc("POST /v1/tasks/{taskID}/runs/{runID}/review-tasks", s.createRunReview)
}

func (s *Server) readRunReviewFile(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	realm := r.Header.Get("X-Lumo-Realm")
	if realm == "" {
		writeError(w, http.StatusUnauthorized, "missing_realm", "X-Lumo-Realm required")
		return
	}
	file, err := s.store.ReadRunReviewFile(r.Context(), realm, r.PathValue("runID"), r.Header.Get("X-Lumo-Node-ID"), r.Header.Get("X-Lumo-Session-Ref"), r.PathValue("entryID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, file)
}

// Only the trusted runtime result transport needs this bounded expansion for
// escaped UTF-8 file bytes; ordinary authenticated JSON limits stay unchanged.
func decodeControlledRunResult(w http.ResponseWriter, r *http.Request, target *domain.TaskResult) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid runtime result")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeError(w, http.StatusBadRequest, "bad_request", "one runtime result required")
		return false
	}
	return true
}

func (s *Server) createRunReview(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !s.requireDelegationAuthority(w, r, c) {
		return
	}
	producer, ok := s.taskParticipant(w, r, c)
	if !ok {
		return
	}
	var req struct {
		ReviewerWorkerID string `json:"reviewer_worker_id"`
	}
	if !decodeRunReview(w, r, &req) {
		return
	}
	req.ReviewerWorkerID = strings.TrimSpace(req.ReviewerWorkerID)
	if !strings.HasPrefix(req.ReviewerWorkerID, "agent:") || r.Header.Get("Idempotency-Key") == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "an Agent reviewer_worker_id and Idempotency-Key are required")
		return
	}
	receipts, err := delegationReceipt(r, struct {
		Kind, ProducerTaskID, ProducerRunID, ReviewerWorkerID string
	}{"independent-run-review", producer.ID, r.PathValue("runID"), req.ReviewerWorkerID})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if task, run, err := s.store.LookupDelegationReceipt(r.Context(), c.realm, c.userID, receipts[0]); err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"task": task, "run": run})
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		s.respondStoreError(w, err)
		return
	}
	schedule, err := scheduleFromTask(producer)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	spec := domain.DelegationSpec{
		Title: "Review: " + producer.Title, ProjectID: producer.ProjectID,
		Intent: "Independently review all entries and summary in the bound output manifest. Return one text block containing only the exact JSON verdict required by the review context.",
	}
	if err = s.prepareDelegationIntent(r.Context(), c, &spec, &schedule); err != nil {
		s.respondStoreError(w, err)
		return
	}
	worker, err := s.store.GetWorkerProfile(r.Context(), c.realm, req.ReviewerWorkerID, producer.ProjectID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	// An explicitly selected reviewer is checked against live capacity and
	// placement constraints. Text keyword inference cannot establish review
	// independence; the immutable execution evidence is checked in the store.
	if !worker.Eligible || (worker.ProjectScopeID != "" && worker.ProjectScopeID != producer.ProjectID) ||
		(spec.Residency != "" && worker.Residency != spec.Residency) || (spec.RequiredTrustLevel != "" && worker.TrustLevel != spec.RequiredTrustLevel) {
		writeError(w, http.StatusUnprocessableEntity, "reviewer_not_eligible", "reviewer must be an available active Agent")
		return
	}
	preset, err := s.store.GetAgentPreset(r.Context(), c.realm, strings.TrimPrefix(worker.WorkerID, "agent:"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	scheduleSnapshot, err := json.Marshal(schedule)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	task := domain.DelegatedTask{
		ID: newID("review-task"), Realm: c.realm, Title: spec.Title, Intent: spec.Intent, IntentContract: spec.IntentContract,
		ProjectID: producer.ProjectID, RequesterUserID: c.userID, AssigneeUserID: preset.OwnerUserID, AssigneeName: worker.DisplayName,
		AssigneeWorkerID: worker.WorkerID, State: domain.DelegationAssigned, BusinessState: domain.BusinessAssigned,
		Schedule: scheduleSnapshot,
	}
	run := domain.TaskRun{ID: newID("review-run"), Realm: c.realm, TaskID: task.ID, Attempt: 1, WorkerID: worker.WorkerID, State: domain.DelegationAssigned}
	if strings.TrimSpace(s.cfg.SchedulerURL) != "" {
		run.State, run.SchedulerTaskID = domain.DelegationQueued, run.ID
		task.State, task.SchedulerTaskID = domain.DelegationQueued, run.ID
	}
	task, run, err = s.store.CreateRunReview(r.Context(), producer.ID, r.PathValue("runID"), task, run, receipts...)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"task": task, "run": run})
}

func decodeRunReview(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid review request")
		return false
	}
	if err := d.Decode(new(any)); err != io.EOF {
		writeError(w, http.StatusBadRequest, "bad_request", "one JSON request is required")
		return false
	}
	return true
}

func (s *Server) prepareRunExecution(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	realm := r.Header.Get("X-Lumo-Realm")
	if realm == "" {
		writeError(w, http.StatusUnauthorized, "missing_realm", "X-Lumo-Realm required")
		return
	}
	var req store.PrepareRunExecutionRequest
	if !decodeRunReview(w, r, &req) {
		return
	}
	prepared, err := s.store.PrepareRunExecution(r.Context(), realm, r.PathValue("runID"), req)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, prepared)
}

func (s *Server) bindRunReview(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !s.requireDelegationAuthority(w, r, c) {
		return
	}
	if _, ok = s.taskParticipant(w, r, c); !ok {
		return
	}
	var req struct {
		ReviewTaskID string `json:"review_task_id"`
		ReviewRunID  string `json:"review_run_id"`
	}
	if !decodeRunReview(w, r, &req) {
		return
	}
	access, err := s.store.TaskAccess(r.Context(), c.realm, req.ReviewTaskID, c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if access != "contributor" && !isRealmAdmin(c) {
		writeError(w, http.StatusForbidden, "forbidden", "review task contributor access required")
		return
	}
	bound, err := s.store.BindRunReview(r.Context(), c.realm, r.PathValue("taskID"), r.PathValue("runID"), req.ReviewTaskID, req.ReviewRunID, c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, bound)
}
