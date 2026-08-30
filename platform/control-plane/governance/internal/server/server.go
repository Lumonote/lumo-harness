// Package server exposes the Cluster-only governance API. Authentication is
// deliberately limited to gateway-injected headers in this first slice; the
// service never accepts a caller identity in the request body.
package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
	"github.com/lumo-harness/platform/observability"
)

type Config struct {
	DeploymentMode    domain.DeploymentMode
	ClusterStatus     string
	SchedulerURL      string
	ClusterID         string
	ControlPlaneToken string
	AuthMaxAttempts   int
	AuthLockFor       time.Duration
	AuthSessionTTL    time.Duration
	AuthCaptchaTTL    time.Duration
}

type Server struct {
	store *store.Store
	cfg   Config
	log   *slog.Logger
}

func New(st *store.Store, cfg Config, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	if cfg.AuthMaxAttempts < 1 {
		cfg.AuthMaxAttempts = 5
	}
	if cfg.AuthLockFor <= 0 {
		cfg.AuthLockFor = 5 * time.Minute
	}
	if cfg.AuthSessionTTL <= 0 {
		cfg.AuthSessionTTL = 24 * time.Hour
	}
	if cfg.AuthCaptchaTTL <= 0 {
		cfg.AuthCaptchaTTL = 2 * time.Minute
	}
	return &Server{store: st, cfg: cfg, log: log}
}

func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /metrics", metrics)
	mux.HandleFunc("POST /v1/auth/captcha", s.authCaptcha)
	mux.HandleFunc("POST /v1/auth/login", s.authLogin)
	mux.HandleFunc("GET /v1/auth/session", s.authSession)
	mux.HandleFunc("POST /v1/auth/logout", s.authLogout)
	mux.HandleFunc("POST /v1/auth/password", s.authPassword)
	mux.HandleFunc("GET /v1/features", s.features)
	mux.HandleFunc("PUT /v1/users/{userID}", s.upsertUser)
	mux.HandleFunc("GET /v1/users/{userID}/effective-skills", s.effectiveSkills)
	mux.HandleFunc("GET /v1/workers", s.listWorkers)
	mux.HandleFunc("GET /v1/workers/{workerID}/profile", s.workerProfile)
	mux.HandleFunc("GET /v1/users", s.listUsers)
	mux.HandleFunc("GET /v1/users/{userID}/tags", s.userTags)
	mux.HandleFunc("PUT /v1/users/{userID}/tags", s.userTags)
	mux.HandleFunc("GET /v1/delegations", s.listDelegations)
	mux.HandleFunc("GET /v1/delegations/{taskID}", s.getDelegation)
	mux.HandleFunc("POST /v1/delegations/preview", s.previewDelegation)
	mux.HandleFunc("POST /v1/delegations", s.createDelegation)
	mux.HandleFunc("POST /v1/delegations/{taskID}/status", s.updateDelegationStatus)
	mux.HandleFunc("POST /v1/tasks/{taskID}/transition", s.transitionTask)
	mux.HandleFunc("GET /v1/tasks/{taskID}/runs", s.listTaskRuns)
	mux.HandleFunc("POST /v1/tasks/{taskID}/runs", s.createTaskRun)
	mux.HandleFunc("PATCH /v1/tasks/{taskID}/runs/{runID}", s.updateTaskRun)
	mux.HandleFunc("POST /v1/tasks/{taskID}/outcome", s.recordOutcome)
	mux.HandleFunc("GET /v1/departments/tree", s.listDepartments)
	mux.HandleFunc("POST /v1/departments", s.createDepartment)
	mux.HandleFunc("GET /v1/roles", s.listRoles)
	mux.HandleFunc("POST /v1/roles", s.createRole)
	mux.HandleFunc("PUT /v1/users/{userID}/roles/{roleID}", s.assignRole)
	mux.HandleFunc("GET /v1/skills", s.listSkills)
	mux.HandleFunc("POST /v1/skills", s.createSkill)
	mux.HandleFunc("POST /v1/skills/{skillID}/grants", s.grantSkill)
	mux.HandleFunc("POST /v1/skills/{skillID}/revocations", s.revokeSkill)
	mux.HandleFunc("GET /v1/desktop-nodes", s.listDesktopNodes)
	mux.HandleFunc("POST /v1/desktop-nodes", s.registerDesktopNode)
	mux.HandleFunc("POST /v1/desktop-nodes/{nodeID}/heartbeat", s.heartbeatDesktopNode)
}

type caller struct {
	userID string
	realm  string
	roles  map[string]bool
}

func (s *Server) caller(w http.ResponseWriter, r *http.Request) (caller, bool) {
	userID, realm := r.Header.Get("X-Lumo-User"), r.Header.Get("X-Lumo-Realm")
	if userID == "" || realm == "" {
		writeError(w, http.StatusUnauthorized, "missing_identity", "X-Lumo-User and X-Lumo-Realm are required")
		return caller{}, false
	}
	return caller{userID: userID, realm: realm, roles: store.NormalizeRoles(r.Header.Get("X-Lumo-Roles"))}, true
}

func (s *Server) requireCluster(w http.ResponseWriter) bool {
	if err := domain.RequireCluster(s.cfg.DeploymentMode, s.cfg.ClusterStatus); err != nil {
		writeError(w, http.StatusForbidden, "CLUSTER_ONLY", "该功能仅在状态为 ready 的 Cluster 部署中可用")
		return false
	}
	return true
}

func isRealmAdmin(c caller) bool {
	return c.roles["platform_admin"] || c.roles["realm_admin"] || c.roles["admin"]
}

func requireRealmAdmin(w http.ResponseWriter, c caller) bool {
	if isRealmAdmin(c) {
		return true
	}
	writeError(w, http.StatusForbidden, "forbidden", "realm_admin role required")
	return false
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "features": domain.NewFeatures(s.cfg.DeploymentMode, s.cfg.ClusterStatus)})
}

func metrics(w http.ResponseWriter, _ *http.Request) { observability.Handler(w, nil) }

func (s *Server) features(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, domain.NewFeatures(s.cfg.DeploymentMode, s.cfg.ClusterStatus))
}

type userRequest struct {
	DisplayName   string `json:"display_name"`
	PrimaryDeptID string `json:"primary_dept_id"`
	Status        string `json:"status"`
}

func (s *Server) upsertUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	userID := r.PathValue("userID")
	if userID != c.userID && !requireRealmAdmin(w, c) {
		return
	}
	var req userRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	user, err := s.store.UpsertUser(r.Context(), domain.User{
		ID: userID, Realm: c.realm, DisplayName: req.DisplayName, PrimaryDeptID: req.PrimaryDeptID,
		Status: req.Status, Source: "gateway",
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) effectiveSkills(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	userID := r.PathValue("userID")
	if userID != c.userID && !requireRealmAdmin(w, c) {
		return
	}
	skills, err := s.store.EffectiveSkills(r.Context(), c.realm, userID, r.URL.Query().Get("project_id"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"skills": skills})
}

func canDelegate(c caller) bool {
	return c.roles["platform_admin"] || c.roles["realm_admin"] || c.roles["admin"] || c.roles["manager"] || c.roles["dept_manager"] || c.roles["operator"] || c.roles["owner"] || c.roles["agent_operator"]
}

func requireDelegationAuthority(w http.ResponseWriter, c caller) bool {
	if canDelegate(c) {
		return true
	}
	writeError(w, http.StatusForbidden, "forbidden", "task:delegate permission required")
	return false
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	users, err := s.store.ListUsers(r.Context(), c.realm, r.URL.Query().Get("q"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

type userTagsRequest struct {
	Tags []string `json:"tags"`
}

func (s *Server) userTags(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	userID := r.PathValue("userID")
	if userID != c.userID && !requireRealmAdmin(w, c) {
		return
	}
	if r.Method == http.MethodGet {
		tags, err := s.store.ListUserTags(r.Context(), c.realm, userID)
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"user_id": userID, "tags": tags})
		return
	}
	var req userTagsRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	tags, err := s.store.ReplaceUserTags(r.Context(), c.realm, userID, req.Tags)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user_id": userID, "tags": tags})
}

type delegationRequest struct {
	domain.DelegationSpec
	AssigneeUserID   string              `json:"assignee_user_id"`
	AssigneeWorkerID string              `json:"assignee_worker_id"`
	AutoAssign       *bool               `json:"auto_assign"`
	Schedule         *delegationSchedule `json:"schedule,omitempty"`
}

// delegationSchedule is deliberately a transport shape instead of a second
// scheduler implementation. Governance forwards these constraints to the
// existing Scheduler, which remains the only component that selects a node.
type delegationSchedule struct {
	ClusterID  string                 `json:"cluster_id,omitempty"`
	Requires   []schedulerRequirement `json:"requires,omitempty"`
	Priority   int                    `json:"priority,omitempty"`
	Residency  string                 `json:"residency,omitempty"`
	TrustLevel string                 `json:"trust_level,omitempty"`
	DeadlineMS int64                  `json:"deadline_ms,omitempty"`
	Queue      string                 `json:"queue,omitempty"`
	Weight     int                    `json:"weight,omitempty"`
	AvoidNodes []string               `json:"avoid_nodes,omitempty"`
}

type schedulerRequirement struct {
	Key   string `json:"key"`
	Value string `json:"value,omitempty"`
}

type delegationPreview struct {
	domain.DelegationSpec
	IntentTerms    []string                     `json:"intent_terms"`
	InferredTags   []string                     `json:"inferred_tags"`
	InferredSkills []string                     `json:"inferred_skills"`
	Candidates     []domain.DelegationCandidate `json:"candidates"`
}

func (s *Server) matchDelegation(ctx context.Context, realm string, req domain.DelegationSpec) (delegationPreview, error) {
	profiles, err := s.store.ListWorkerProfiles(ctx, realm, req.ProjectID, "")
	if err != nil {
		return delegationPreview{}, err
	}
	inferredTags, inferredSkills, candidates := domain.RankDelegationCandidates(req, profiles)
	return delegationPreview{DelegationSpec: req, IntentTerms: domain.IntentTerms(req.Intent), InferredTags: inferredTags, InferredSkills: inferredSkills, Candidates: candidates}, nil
}

type schedulerPlacement struct {
	NodeID  string `json:"node_id"`
	Attempt int    `json:"attempt"`
	State   string `json:"state"`
}

// placeRun delegates node selection to the existing Scheduler. Governance
// never starts a second execution mechanism: a successful placement only
// mirrors scheduler_task_id/node_id onto the business Run.
func (s *Server) placeRun(ctx context.Context, realm, taskID string, schedule *delegationSchedule) (schedulerPlacement, error) {
	if strings.TrimSpace(s.cfg.SchedulerURL) == "" {
		return schedulerPlacement{}, nil
	}
	clusterID := s.cfg.ClusterID
	requires := []schedulerRequirement{{Key: "subagent"}}
	priority, residency, deadlineMS, queue, weight := 0, "", int64(0), "", 0
	var avoidNodes []string
	if schedule != nil {
		if strings.TrimSpace(schedule.ClusterID) != "" {
			clusterID = strings.TrimSpace(schedule.ClusterID)
		}
		if len(schedule.Requires) > 0 {
			requires = schedule.Requires
		}
		priority, residency, deadlineMS, queue, weight, avoidNodes = schedule.Priority, schedule.Residency, schedule.DeadlineMS, schedule.Queue, schedule.Weight, schedule.AvoidNodes
	}
	payload, err := json.Marshal(map[string]any{
		"task_id": taskID, "cluster_id": clusterID, "requires": requires,
		"priority": priority, "residency": residency, "deadline_ms": deadlineMS,
		"queue": queue, "weight": weight, "avoid_nodes": avoidNodes,
	})
	if err != nil {
		return schedulerPlacement{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.cfg.SchedulerURL, "/")+"/v1/placements", bytes.NewReader(payload))
	if err != nil {
		return schedulerPlacement{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lumo-Realm", realm)
	if s.cfg.ControlPlaneToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.cfg.ControlPlaneToken)
	}
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return schedulerPlacement{}, fmt.Errorf("scheduler unavailable: %w", err)
	}
	defer res.Body.Close()
	var placement schedulerPlacement
	if err := json.NewDecoder(res.Body).Decode(&placement); err != nil {
		return schedulerPlacement{}, fmt.Errorf("scheduler returned invalid placement: %w", err)
	}
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusAccepted {
		return schedulerPlacement{}, fmt.Errorf("scheduler placement failed with HTTP %d", res.StatusCode)
	}
	if res.StatusCode == http.StatusCreated {
		if placement.NodeID == "" || placement.Attempt < 1 {
			return schedulerPlacement{}, errors.New("scheduler placement missing node_id/attempt")
		}
		placement.State = domain.DelegationAssigned
	} else {
		placement.State = domain.DelegationQueued
	}
	return placement, nil
}

func (s *Server) previewDelegation(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	var req domain.DelegationSpec
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Intent) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "intent is required")
		return
	}
	preview, err := s.matchDelegation(r.Context(), c.realm, req)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func (s *Server) createDelegation(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	var req delegationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	req.Intent = strings.TrimSpace(req.Intent)
	req.AssigneeUserID = strings.TrimSpace(req.AssigneeUserID)
	req.AssigneeWorkerID = strings.TrimSpace(req.AssigneeWorkerID)
	if req.Schedule != nil {
		if req.DelegationSpec.Residency == "" {
			req.DelegationSpec.Residency = strings.TrimSpace(req.Schedule.Residency)
		}
		if req.DelegationSpec.RequiredTrustLevel == "" {
			req.DelegationSpec.RequiredTrustLevel = strings.TrimSpace(req.Schedule.TrustLevel)
		}
	}
	if req.Title == "" {
		req.Title = req.Intent
	}
	if req.Title == "" || req.Intent == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "title and intent are required")
		return
	}
	autoAssign := req.AutoAssign == nil || *req.AutoAssign
	if !autoAssign && req.AssigneeUserID == "" && req.AssigneeWorkerID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "assignee_worker_id is required when auto_assign is false")
		return
	}
	preview, err := s.matchDelegation(r.Context(), c.realm, req.DelegationSpec)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	var chosen *domain.DelegationCandidate
	for i := range preview.Candidates {
		candidate := &preview.Candidates[i]
		if (req.AssigneeUserID != "" && candidate.UserID == req.AssigneeUserID) || (req.AssigneeWorkerID != "" && candidate.WorkerID == req.AssigneeWorkerID) {
			chosen = candidate
			break
		}
	}
	if (req.AssigneeUserID != "" || req.AssigneeWorkerID != "") && (chosen == nil || !chosen.Eligible) {
		writeError(w, http.StatusUnprocessableEntity, "delegatee_not_eligible", "指定 Worker 不满足任务的标签、技能或负载要求")
		return
	}
	if chosen == nil && autoAssign {
		for i := range preview.Candidates {
			if preview.Candidates[i].Eligible {
				chosen = &preview.Candidates[i]
				break
			}
		}
	}
	if chosen == nil {
		writeError(w, http.StatusUnprocessableEntity, "no_eligible_delegatee", "没有同时满足意图、标签和技能要求的 active 用户")
		return
	}
	task := domain.DelegatedTask{
		ID: newID("task"), Realm: c.realm, Title: req.Title, Intent: req.Intent, ProjectID: req.ProjectID,
		RequesterUserID: c.userID, AssigneeUserID: chosen.UserID, AssigneeName: chosen.DisplayName,
		RequiredTags: req.RequiredTags, RequiredSkills: req.RequiredSkills, InferredTags: preview.InferredTags,
		InferredSkills: preview.InferredSkills, SelectedSkills: chosen.MatchedSkills, State: domain.DelegationAssigned,
		BusinessState: domain.BusinessAssigned, ConfidenceBand: chosen.ConfidenceBand, AssigneeWorkerID: chosen.WorkerID,
		ScoreBreakdown: chosen.ScoreBreakdown, ScoreWeights: chosen.ScoreWeights, MatchScore: chosen.Score, Rationale: chosen.Rationale,
	}
	run := domain.TaskRun{ID: newID("run"), Realm: c.realm, TaskID: task.ID, Attempt: 1, WorkerID: chosen.WorkerID, State: domain.DelegationAssigned}
	createdTask, createdRun, err := s.store.CreateDelegatedTaskWithRun(r.Context(), task, run)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if strings.TrimSpace(s.cfg.SchedulerURL) != "" {
		placement, placeErr := s.placeRun(r.Context(), c.realm, createdTask.ID, req.Schedule)
		if placeErr != nil {
			failedRun, _ := s.store.UpdateTaskRun(r.Context(), c.realm, createdTask.ID, createdRun.ID, domain.DelegationBlocked, "", "", "SCHEDULER_UNAVAILABLE", placeErr.Error())
			_, _ = s.store.UpdateDelegationTask(r.Context(), c.realm, createdTask.ID, domain.DelegationBlocked, "", "", placeErr.Error())
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "scheduler_unavailable", "message": placeErr.Error(), "task": createdTask, "run": failedRun})
			return
		}
		createdRun, err = s.store.UpdateTaskRun(r.Context(), c.realm, createdTask.ID, createdRun.ID, placement.State, createdTask.ID, placement.NodeID, "", "")
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		createdTask, err = s.store.UpdateDelegationTask(r.Context(), c.realm, createdTask.ID, placement.State, createdTask.ID, placement.NodeID, "")
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusCreated, map[string]any{"task": createdTask, "run": createdRun})
}

func (s *Server) listDelegations(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	all := isRealmAdmin(c) || c.roles["manager"] || c.roles["dept_manager"] || c.roles["operator"] || c.roles["owner"] || c.roles["agent_operator"]
	if r.URL.Query().Get("assigned_to") == "me" {
		all = false
	}
	tasks, err := s.store.ListDelegationTasks(r.Context(), c.realm, c.userID, all)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": tasks})
}

func (s *Server) getDelegation(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	task, err := s.store.GetDelegationTask(r.Context(), c.realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if !isRealmAdmin(c) && task.RequesterUserID != c.userID && task.AssigneeUserID != c.userID {
		writeError(w, http.StatusNotFound, "not_found", "task not found")
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func workerView(profile domain.UserProfile) domain.WorkerProfile {
	return domain.WorkerProfile{
		WorkerID: profile.WorkerID, WorkerKind: profile.WorkerKind, DisplayName: profile.DisplayName,
		Status: profile.Status, Skills: profile.Skills, ActiveTasks: profile.ActiveTasks, Load: profile.Load,
		MaxConcurrency: profile.MaxConcurrency, Confidence: profile.Confidence, Quality: profile.Quality,
		CostNorm: profile.CostNorm, TrustLevel: profile.TrustLevel, Residency: profile.Residency,
		Eligible: profile.Status == "active" && profile.Load <= 0.8,
	}
}

func (s *Server) listWorkers(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	profiles, err := s.store.ListWorkerProfiles(r.Context(), c.realm, r.URL.Query().Get("project_id"), r.URL.Query().Get("q"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	out := make([]domain.WorkerProfile, 0, len(profiles))
	for _, profile := range profiles {
		out = append(out, workerView(profile))
	}
	writeJSON(w, http.StatusOK, map[string]any{"workers": out})
}

func (s *Server) workerProfile(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	profile, err := s.store.GetWorkerProfile(r.Context(), c.realm, r.PathValue("workerID"), r.URL.Query().Get("project_id"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, profile)
}

func (s *Server) taskParticipant(w http.ResponseWriter, r *http.Request, c caller) (domain.DelegatedTask, bool) {
	task, err := s.store.GetDelegationTask(r.Context(), c.realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
		return domain.DelegatedTask{}, false
	}
	if !isRealmAdmin(c) && task.RequesterUserID != c.userID && task.AssigneeUserID != c.userID {
		writeError(w, http.StatusForbidden, "forbidden", "task participant required")
		return domain.DelegatedTask{}, false
	}
	return task, true
}

type taskTransitionRequest struct {
	Event string `json:"event"`
}

func (s *Server) transitionTask(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	if _, ok := s.taskParticipant(w, r, c); !ok {
		return
	}
	var req taskTransitionRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	task, err := s.store.TransitionBusinessTask(r.Context(), c.realm, r.PathValue("taskID"), strings.TrimSpace(req.Event), c.userID)
	if err != nil {
		if errors.Is(err, store.ErrLegacyTask) {
			writeError(w, http.StatusConflict, "legacy_task", err.Error())
			return
		}
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func (s *Server) listTaskRuns(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	if _, ok := s.taskParticipant(w, r, c); !ok {
		return
	}
	runs, err := s.store.ListTaskRuns(r.Context(), c.realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
}

type taskRunRequest struct {
	WorkerID        string `json:"worker_id"`
	SessionRef      string `json:"session_ref"`
	SchedulerTaskID string `json:"scheduler_task_id"`
	AssignedNodeID  string `json:"assigned_node_id"`
	State           string `json:"state"`
	FailureKind     string `json:"failure_kind"`
	LastError       string `json:"last_error"`
	BusinessEvent   string `json:"business_event"`
}

func (s *Server) createTaskRun(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	task, ok := s.taskParticipant(w, r, c)
	if !ok {
		return
	}
	var req taskRunRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	workerID := strings.TrimSpace(req.WorkerID)
	if workerID == "" {
		workerID = task.AssigneeWorkerID
		if workerID == "" && task.AssigneeUserID != "" {
			workerID = "user:" + task.AssigneeUserID
		}
	}
	if workerID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "worker_id is required")
		return
	}
	state := strings.TrimSpace(req.State)
	if state == "" {
		state = domain.DelegationAssigned
	}
	run, err := s.store.CreateNextTaskRun(r.Context(), c.realm, task.ID, domain.TaskRun{
		ID: newID("run"), WorkerID: workerID, SessionRef: strings.TrimSpace(req.SessionRef),
		SchedulerTaskID: strings.TrimSpace(req.SchedulerTaskID), AssignedNodeID: strings.TrimSpace(req.AssignedNodeID),
		State: state, FailureKind: strings.TrimSpace(req.FailureKind), LastError: req.LastError,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if event := strings.TrimSpace(req.BusinessEvent); event != "" {
		if _, err := s.store.TransitionBusinessTask(r.Context(), c.realm, task.ID, event, c.userID); err != nil {
			s.respondStoreError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusCreated, run)
}

func (s *Server) updateTaskRun(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	if _, ok := s.taskParticipant(w, r, c); !ok {
		return
	}
	var req taskRunRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.State) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "state is required")
		return
	}
	run, err := s.store.UpdateTaskRun(r.Context(), c.realm, r.PathValue("taskID"), r.PathValue("runID"), strings.TrimSpace(req.State), strings.TrimSpace(req.SchedulerTaskID), strings.TrimSpace(req.AssignedNodeID), strings.TrimSpace(req.FailureKind), req.LastError)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if event := strings.TrimSpace(req.BusinessEvent); event != "" {
		if _, err := s.store.TransitionBusinessTask(r.Context(), c.realm, r.PathValue("taskID"), event, c.userID); err != nil {
			s.respondStoreError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, run)
}

type dispatchOutcomeRequest struct {
	RunID    string `json:"run_id"`
	WorkerID string `json:"worker_id"`
	Outcome  string `json:"outcome"`
	Reason   string `json:"reason"`
	Notes    string `json:"notes"`
}

func (s *Server) recordOutcome(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	if _, ok := s.taskParticipant(w, r, c); !ok {
		return
	}
	var req dispatchOutcomeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	workerID := strings.TrimSpace(req.WorkerID)
	if workerID == "" {
		workerID = "user:" + c.userID
	}
	reason := strings.TrimSpace(req.Reason)
	outcomeValue := strings.TrimSpace(req.Outcome)
	if outcomeValue == domain.OutcomeReassigned && reason == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "REASSIGNED 必须提供 reason")
		return
	}
	outcome := domain.DispatchOutcome{ID: newID("outcome"), Realm: c.realm, TaskID: r.PathValue("taskID"), RunID: strings.TrimSpace(req.RunID), WorkerID: workerID, Outcome: outcomeValue, Reason: reason, Notes: req.Notes, CreatedBy: c.userID}
	if err := s.store.RecordDispatchOutcome(r.Context(), outcome); err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, outcome)
}

type delegationStatusRequest struct {
	State           string `json:"state"`
	SchedulerTaskID string `json:"scheduler_task_id"`
	AssignedNodeID  string `json:"assigned_node_id"`
	LastError       string `json:"last_error"`
}

func validDelegationTransition(from, to string) bool {
	if from == to {
		return true
	}
	switch from {
	case domain.DelegationAssigned:
		return to == domain.DelegationQueued || to == domain.DelegationBlocked || to == domain.DelegationCancelled
	case domain.DelegationQueued:
		return to == domain.DelegationRunning || to == domain.DelegationBlocked || to == domain.DelegationCancelled
	case domain.DelegationRunning:
		return to == domain.DelegationCompleted || to == domain.DelegationFailed || to == domain.DelegationCancelled
	case domain.DelegationBlocked, domain.DelegationFailed:
		return to == domain.DelegationQueued || to == domain.DelegationCancelled
	default:
		return false
	}
}

func (s *Server) updateDelegationStatus(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	task, err := s.store.GetDelegationTask(r.Context(), c.realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if !isRealmAdmin(c) && task.RequesterUserID != c.userID && task.AssigneeUserID != c.userID {
		writeError(w, http.StatusForbidden, "forbidden", "task participant required")
		return
	}
	var req delegationStatusRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !domain.ValidDelegationState(req.State) {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid delegation state")
		return
	}
	if !validDelegationTransition(task.State, req.State) {
		writeError(w, http.StatusConflict, "invalid_transition", "task state transition is not allowed")
		return
	}
	updated, err := s.store.UpdateDelegationTask(r.Context(), c.realm, task.ID, req.State, req.SchedulerTaskID, req.AssignedNodeID, strings.TrimSpace(req.LastError))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

type departmentRequest struct {
	ID            string `json:"id"`
	ParentDeptID  string `json:"parent_dept_id"`
	Name          string `json:"name"`
	ManagerUserID string `json:"manager_user_id"`
}

func (s *Server) listDepartments(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	departments, err := s.store.ListDepartments(r.Context(), c.realm)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"departments": departments})
}

func (s *Server) createDepartment(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req departmentRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ID == "" {
		req.ID = newID("dept")
	}
	department, err := s.store.CreateDepartment(r.Context(), domain.Department{
		ID: req.ID, Realm: c.realm, ParentDeptID: req.ParentDeptID, Name: req.Name, ManagerUserID: req.ManagerUserID,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, department)
}

func (s *Server) listRoles(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	roles, err := s.store.ListRoles(r.Context(), c.realm)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": roles})
}

type roleRequest struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (s *Server) createRole(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req roleRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ID == "" {
		req.ID = newID("role")
	}
	role, err := s.store.CreateRole(r.Context(), domain.Role{ID: req.ID, Realm: c.realm, Name: req.Name, Description: req.Description})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, role)
}

type assignRoleRequest struct {
	ExpiresAt *time.Time `json:"expires_at"`
}

func (s *Server) assignRole(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req assignRoleRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.store.AssignRole(r.Context(), c.realm, r.PathValue("userID"), r.PathValue("roleID"), c.userID, req.ExpiresAt); err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type skillRequest struct {
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	Description    string           `json:"description"`
	Kind           domain.SkillKind `json:"kind"`
	Visibility     string           `json:"visibility"`
	CurrentVersion string           `json:"current_version"`
}

func (s *Server) listSkills(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	skills, err := s.store.ListSkills(r.Context(), c.realm)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"skills": skills})
}

func (s *Server) createSkill(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	var req skillRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ID == "" {
		req.ID = newID("skill")
	}
	// Every user may create a low-risk private skill. Publishing tool or
	// connector skills requires the same governance authority as a rollout.
	if (req.Kind == domain.SkillTool || req.Kind == domain.SkillConnector || req.Visibility != "" && req.Visibility != "private") && !requireRealmAdmin(w, c) {
		return
	}
	skill, err := s.store.CreateSkill(r.Context(), domain.Skill{
		ID: req.ID, Realm: c.realm, Name: req.Name, Kind: req.Kind, Visibility: req.Visibility,
		CurrentVersion: req.CurrentVersion, CreatedBy: c.userID, Description: req.Description,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, skill)
}

type skillGrantRequest struct {
	VersionConstraint string             `json:"version_constraint"`
	SubjectType       domain.SubjectType `json:"subject_type"`
	SubjectID         string             `json:"subject_id"`
	IncludeChildren   bool               `json:"include_children"`
	ExpiresAt         *time.Time         `json:"expires_at"`
}

func (s *Server) grantSkill(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req skillGrantRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	err := s.store.GrantSkill(r.Context(), domain.SkillGrant{
		ID: newID("grant"), Realm: c.realm, SkillID: r.PathValue("skillID"), VersionConstraint: req.VersionConstraint,
		SubjectType: req.SubjectType, SubjectID: req.SubjectID, IncludeChildren: req.IncludeChildren,
		ExpiresAt: req.ExpiresAt, GrantedBy: c.userID,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type skillRevocationRequest struct {
	SubjectType domain.SubjectType `json:"subject_type"`
	SubjectID   string             `json:"subject_id"`
	Reason      string             `json:"reason"`
	ExpiresAt   *time.Time         `json:"expires_at"`
}

func (s *Server) revokeSkill(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	var req skillRevocationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	// A user may explicitly revoke their own inherited skill; broader revokes
	// change other people's access and require realm administration.
	if (req.SubjectType != domain.SubjectUser || req.SubjectID != c.userID) && !requireRealmAdmin(w, c) {
		return
	}
	err := s.store.RevokeSkill(r.Context(), domain.SkillRevocation{
		ID: newID("revoke"), Realm: c.realm, SkillID: r.PathValue("skillID"), SubjectType: req.SubjectType,
		SubjectID: req.SubjectID, Reason: req.Reason, ExpiresAt: req.ExpiresAt, RevokedBy: c.userID,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type desktopNodeRequest struct {
	ID            string   `json:"id"`
	ClusterID     string   `json:"cluster_id"`
	DisplayName   string   `json:"display_name"`
	OS            string   `json:"os"`
	Arch          string   `json:"arch"`
	ClientVersion string   `json:"client_version"`
	Capacity      int      `json:"capacity"`
	Capabilities  []string `json:"capabilities"`
	Residency     string   `json:"residency"`
}

func (s *Server) registerDesktopNode(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	var req desktopNodeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ID == "" {
		req.ID = newID("desktop")
	}
	node, err := s.store.RegisterDesktopNode(r.Context(), domain.DesktopNode{
		ID: req.ID, Realm: c.realm, ClusterID: req.ClusterID, OwnerUserID: c.userID, DisplayName: req.DisplayName,
		OS: req.OS, Arch: req.Arch, ClientVersion: req.ClientVersion, Capacity: req.Capacity,
		Capabilities: req.Capabilities, Residency: req.Residency,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, node)
}

func (s *Server) heartbeatDesktopNode(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	node, err := s.store.HeartbeatDesktopNode(r.Context(), c.realm, r.PathValue("nodeID"), c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, node)
}

func (s *Server) listDesktopNodes(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	nodes, err := s.store.ListDesktopNodes(r.Context(), c.realm, c.userID, isRealmAdmin(c))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": nodes})
}

func (s *Server) respondStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrLegacyTask):
		writeError(w, http.StatusConflict, "legacy_task", err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "resource not found")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "resource already exists")
	case errors.Is(err, store.ErrBadRequest):
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, store.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "operation not permitted")
	default:
		s.log.Error("governance request failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "internal service error")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func newID(prefix string) string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return prefix + "-" + strings.ToLower(hex.EncodeToString(raw[:]))
}
