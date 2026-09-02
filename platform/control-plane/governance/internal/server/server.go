// Package server exposes the Cluster-only governance API. Authentication is
// deliberately limited to gateway-injected headers in this first slice; the
// service never accepts a caller identity in the request body.
package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	authcrypto "github.com/lumo-harness/platform/governance/internal/auth"
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
	// AuthMFAKey is a base64 32-byte AES key. MFA remains unavailable rather
	// than storing recoverable factor secrets when it is not configured.
	AuthMFAKey string
	// WebAuthn holds an already validated RPID/origin allow-list.  Empty means
	// passkeys are unavailable; partial configuration is rejected at startup.
	WebAuthn authcrypto.WebAuthnConfig
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
	mux.HandleFunc("GET /v1/auth/sessions", s.authSessions)
	mux.HandleFunc("GET /v1/auth/security-events", s.authSecurityEvents)
	mux.HandleFunc("GET /v1/auth/mfa", s.authMFAStatus)
	mux.HandleFunc("POST /v1/auth/mfa/enroll", s.authMFAEnroll)
	mux.HandleFunc("POST /v1/auth/mfa/confirm", s.authMFAConfirm)
	mux.HandleFunc("DELETE /v1/auth/mfa", s.authMFADisable)
	mux.HandleFunc("GET /v1/auth/passkeys", s.authPasskeys)
	mux.HandleFunc("POST /v1/auth/passkeys/register/options", s.authPasskeyRegistrationOptions)
	mux.HandleFunc("POST /v1/auth/passkeys/register", s.authPasskeyRegistration)
	mux.HandleFunc("DELETE /v1/auth/passkeys/{credentialID}", s.authPasskeyDelete)
	mux.HandleFunc("POST /v1/auth/passkey/login/options", s.authPasskeyLoginOptions)
	mux.HandleFunc("POST /v1/auth/passkey/login", s.authPasskeyLogin)
	mux.HandleFunc("DELETE /v1/auth/sessions/{sessionID}", s.authRevokeSession)
	mux.HandleFunc("POST /v1/auth/sessions/revoke-others", s.authRevokeOtherSessions)
	mux.HandleFunc("POST /v1/auth/logout", s.authLogout)
	mux.HandleFunc("POST /v1/auth/password", s.authPassword)
	mux.HandleFunc("GET /v1/features", s.features)
	mux.HandleFunc("GET /v1/effective-permissions", s.effectivePermissions)
	mux.HandleFunc("POST /v1/permission-explain", s.explainPermission)
	mux.HandleFunc("PUT /v1/users/{userID}", s.upsertUser)
	mux.HandleFunc("GET /v1/users/{userID}/effective-skills", s.effectiveSkills)
	mux.HandleFunc("GET /v1/agent-presets", s.listAgentPresets)
	mux.HandleFunc("POST /v1/agent-presets", s.createAgentPreset)
	mux.HandleFunc("GET /v1/agent-presets/{presetID}", s.getAgentPreset)
	mux.HandleFunc("PATCH /v1/agent-presets/{presetID}", s.updateAgentPreset)
	mux.HandleFunc("GET /v1/workers", s.listWorkers)
	mux.HandleFunc("GET /v1/workers/{workerID}/profile", s.workerProfile)
	mux.HandleFunc("GET /v1/users", s.listUsers)
	mux.HandleFunc("GET /v1/users/{userID}/tags", s.userTags)
	mux.HandleFunc("PUT /v1/users/{userID}/tags", s.userTags)
	mux.HandleFunc("GET /v1/delegations", s.listDelegations)
	mux.HandleFunc("GET /v1/delegations/{taskID}", s.getDelegation)
	mux.HandleFunc("POST /v1/delegations/preview", s.previewDelegation)
	mux.HandleFunc("POST /v1/delegations", s.createDelegation)
	mux.HandleFunc("POST /v1/delegations/{taskID}/cancel", s.cancelDelegation)
	mux.HandleFunc("POST /v1/delegations/{taskID}/retry", s.retryDelegation)
	mux.HandleFunc("POST /v1/delegations/{taskID}/reassign", s.reassignDelegation)
	mux.HandleFunc("POST /v1/delegations/{taskID}/status", s.updateDelegationStatus)
	mux.HandleFunc("POST /v1/tasks/{taskID}/transition", s.transitionTask)
	mux.HandleFunc("GET /v1/tasks/{taskID}/runs", s.listTaskRuns)
	mux.HandleFunc("GET /v1/tasks/{taskID}/audit", s.listTaskAudit)
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
	mux.HandleFunc("GET /v1/skills/runtime-snapshot", s.runtimeSkillSnapshot)
	mux.HandleFunc("GET /v1/skills/{skillID}/versions", s.listSkillVersions)
	mux.HandleFunc("POST /v1/skills/{skillID}/versions", s.createSkillVersion)
	mux.HandleFunc("GET /v1/skills/{skillID}/versions/{version}", s.getSkillVersion)
	mux.HandleFunc("POST /v1/skills/{skillID}/versions/{version}/publish", s.publishSkillVersion)
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

type delegationAction = domain.PermissionAction

const (
	actionDelegate        delegationAction = domain.ActionTaskDelegate
	actionExecutionUpdate delegationAction = domain.ActionTaskExecutionUpdate
)

// delegationRoleActions is the one policy entry point for the legacy
// gateway-issued roles. Handlers ask for an action, not for an ad-hoc role
// list; a later policy engine can replace this map without reopening every
// endpoint's authorization logic.
var delegationRoleActions = map[string]map[delegationAction]bool{
	"platform_admin": {actionDelegate: true, actionExecutionUpdate: true},
	"realm_admin":    {actionDelegate: true, actionExecutionUpdate: true},
	"admin":          {actionDelegate: true, actionExecutionUpdate: true},
	"manager":        {actionDelegate: true},
	"dept_manager":   {actionDelegate: true},
	"operator":       {actionDelegate: true, actionExecutionUpdate: true},
	"owner":          {actionDelegate: true},
	"agent_operator": {actionDelegate: true, actionExecutionUpdate: true},
}

var permissionActions = []delegationAction{actionDelegate, actionExecutionUpdate}

func (c caller) permits(action delegationAction) bool {
	for role := range c.roles {
		if delegationRoleActions[role][action] {
			return true
		}
	}
	return false
}

func (c caller) grantingRoles(action delegationAction) []string {
	roles := []string{}
	for role := range c.roles {
		if delegationRoleActions[role][action] {
			roles = append(roles, role)
		}
	}
	sort.Strings(roles)
	return roles
}

func (c caller) roleNames() []string {
	roles := make([]string, 0, len(c.roles))
	for role := range c.roles {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	return roles
}

func validPermissionAction(action delegationAction) bool {
	for _, candidate := range permissionActions {
		if action == candidate {
			return true
		}
	}
	return false
}

// permissionDecision is the adapter that supplies the Realm role grant and
// Project membership facts to the pure Realm ∩ Project ∩ Space policy. Space
// remains nil until its authoritative service is wired in, which makes every
// Space-scoped request a deliberate fail-closed decision.
func (s *Server) permissionDecision(ctx context.Context, c caller, action delegationAction, resource domain.PermissionResource) (domain.PermissionDecision, error) {
	if resource.Realm == "" {
		resource.Realm = c.realm
	}
	if resource.Realm != c.realm {
		return domain.EvaluatePermission(domain.PermissionRequest{
			Actor:    domain.PermissionActor{UserID: c.userID, Realm: c.realm, Roles: c.roleNames()},
			Resource: resource, Action: action,
			Context: domain.PermissionContext{RealmAllowed: false},
		}), nil
	}
	var projectAllowed *bool
	if strings.TrimSpace(resource.ProjectID) != "" {
		allowed := isRealmAdmin(c)
		if !allowed {
			member, err := s.store.ProjectMember(ctx, resource.ProjectID, c.userID)
			if err != nil {
				return domain.PermissionDecision{}, err
			}
			allowed = member
		}
		projectAllowed = &allowed
	}
	roles := c.grantingRoles(action)
	decision := domain.EvaluatePermission(domain.PermissionRequest{
		Actor:    domain.PermissionActor{UserID: c.userID, Realm: c.realm, Roles: c.roleNames()},
		Resource: resource, Action: action,
		Context: domain.PermissionContext{RealmAllowed: len(roles) > 0, ProjectAllowed: projectAllowed},
	})
	for _, role := range roles {
		decision.MatchedPolicies = append([]string{"realm:role:" + role}, decision.MatchedPolicies...)
	}
	return decision, nil
}

func (s *Server) requirePermission(ctx context.Context, w http.ResponseWriter, c caller, action delegationAction, resource domain.PermissionResource) bool {
	decision, err := s.permissionDecision(ctx, c, action, resource)
	if err != nil {
		s.respondStoreError(w, err)
		return false
	}
	if decision.Allowed {
		return true
	}
	writeError(w, http.StatusForbidden, "forbidden", decision.Reason)
	return false
}

func permissionResourceFromQuery(r *http.Request, realm string) domain.PermissionResource {
	query := r.URL.Query()
	return domain.PermissionResource{
		Realm: realm, ProjectID: strings.TrimSpace(query.Get("project_id")), SpaceID: strings.TrimSpace(query.Get("space_id")),
		Kind: strings.TrimSpace(query.Get("resource_kind")), ID: strings.TrimSpace(query.Get("resource_id")),
	}
}

// effectivePermissions returns the current caller's decisions for every
// currently supported action, scoped to the optional project/Space context.
func (s *Server) effectivePermissions(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	resource := permissionResourceFromQuery(r, c.realm)
	decisions := make([]domain.PermissionDecision, 0, len(permissionActions))
	for _, action := range permissionActions {
		decision, err := s.permissionDecision(r.Context(), c, action, resource)
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		decisions = append(decisions, decision)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"actor":    domain.PermissionActor{UserID: c.userID, Realm: c.realm, Roles: c.roleNames()},
		"resource": resource, "decisions": decisions,
	})
}

type permissionExplainRequest struct {
	Action   delegationAction          `json:"action"`
	Resource domain.PermissionResource `json:"resource"`
}

// explainPermission answers why a concrete actor/resource/action/context is
// allowed or denied. The actor comes from trusted headers, never the body.
func (s *Server) explainPermission(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	var req permissionExplainRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validPermissionAction(req.Action) {
		writeError(w, http.StatusBadRequest, "unsupported_action", "当前策略未定义该动作")
		return
	}
	decision, err := s.permissionDecision(r.Context(), c, req.Action, req.Resource)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, decision)
}

func requireDelegationAuthority(w http.ResponseWriter, c caller) bool {
	if c.permits(actionDelegate) {
		return true
	}
	writeError(w, http.StatusForbidden, "forbidden", "task:delegate permission required")
	return false
}

func requireExecutionReporter(w http.ResponseWriter, c caller) bool {
	if c.permits(actionExecutionUpdate) {
		return true
	}
	writeError(w, http.StatusForbidden, "forbidden", "task:execution:update permission required")
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
	res, err := observability.ConfiguredHTTPClient(30 * time.Second).Do(req)
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

// cancelScheduledRun asks the Scheduler to stop the already selected node.
// Scheduler only returns CANCELLING after that node accepts the stop request,
// so Governance must never infer a cancelled task from a UI action alone.
func (s *Server) cancelScheduledRun(ctx context.Context, realm, taskID string) (schedulerPlacement, error) {
	if strings.TrimSpace(s.cfg.SchedulerURL) == "" {
		return schedulerPlacement{}, errors.New("scheduler control is not configured")
	}
	endpoint := strings.TrimRight(s.cfg.SchedulerURL, "/") + "/v1/tasks/" + url.PathEscape(taskID) + "/cancel"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return schedulerPlacement{}, err
	}
	req.Header.Set("X-Lumo-Realm", realm)
	if s.cfg.ControlPlaneToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.cfg.ControlPlaneToken)
	}
	res, err := observability.ConfiguredHTTPClient(15 * time.Second).Do(req)
	if err != nil {
		return schedulerPlacement{}, fmt.Errorf("scheduler unavailable: %w", err)
	}
	defer res.Body.Close()
	var placement schedulerPlacement
	if err := json.NewDecoder(res.Body).Decode(&placement); err != nil {
		return schedulerPlacement{}, fmt.Errorf("scheduler returned invalid cancellation response: %w", err)
	}
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusAccepted {
		return schedulerPlacement{}, fmt.Errorf("scheduler cancellation failed with HTTP %d", res.StatusCode)
	}
	return placement, nil
}

func delegationStateFromScheduler(value string) (string, bool) {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "PENDING":
		return domain.DelegationQueued, true
	case "PLACED":
		return domain.DelegationAssigned, true
	case "RUNNING":
		return domain.DelegationRunning, true
	case "CANCELLING":
		return domain.DelegationCancelling, true
	case "COMPLETED":
		return domain.DelegationCompleted, true
	case "FAILED":
		return domain.DelegationFailed, true
	case "ABORTED":
		return domain.DelegationCancelled, true
	default:
		return "", false
	}
}

// mirrorExecutionState updates the business task and its newest immutable run
// together. A legacy task can have no run yet; in that case only the task is
// updated and a later retry will materialize the historical attempt.
func (s *Server) mirrorExecutionState(ctx context.Context, realm string, task domain.DelegatedTask, state, lastError string) (domain.DelegatedTask, error) {
	updated, err := s.store.UpdateDelegationTask(ctx, realm, task.ID, state, "", "", lastError)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	runs, err := s.store.ListTaskRuns(ctx, realm, task.ID)
	if err != nil {
		return domain.DelegatedTask{}, err
	}
	if len(runs) == 0 {
		return updated, nil
	}
	latest := runs[len(runs)-1]
	if _, err := s.store.UpdateTaskRun(ctx, realm, task.ID, latest.ID, state, "", "", "", lastError); err != nil {
		return domain.DelegatedTask{}, err
	}
	return updated, nil
}

func (s *Server) schedulerPlacement(ctx context.Context, realm, taskID string) (schedulerPlacement, error) {
	if strings.TrimSpace(s.cfg.SchedulerURL) == "" {
		return schedulerPlacement{}, errors.New("scheduler control is not configured")
	}
	endpoint := strings.TrimRight(s.cfg.SchedulerURL, "/") + "/v1/placements/" + url.PathEscape(taskID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return schedulerPlacement{}, err
	}
	req.Header.Set("X-Lumo-Realm", realm)
	if s.cfg.ControlPlaneToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.cfg.ControlPlaneToken)
	}
	res, err := observability.ConfiguredHTTPClient(10 * time.Second).Do(req)
	if err != nil {
		return schedulerPlacement{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return schedulerPlacement{}, fmt.Errorf("scheduler placement query failed with HTTP %d", res.StatusCode)
	}
	var placement schedulerPlacement
	if err := json.NewDecoder(res.Body).Decode(&placement); err != nil {
		return schedulerPlacement{}, err
	}
	return placement, nil
}

func scheduleFromTask(task domain.DelegatedTask) (*delegationSchedule, error) {
	if len(task.Schedule) == 0 || string(task.Schedule) == "{}" || string(task.Schedule) == "null" {
		return nil, nil
	}
	var schedule delegationSchedule
	if err := json.Unmarshal(task.Schedule, &schedule); err != nil {
		return nil, fmt.Errorf("stored schedule is invalid: %w", err)
	}
	return &schedule, nil
}

// reconcileCancelling makes cancellation terminal only when Scheduler has a
// terminal execution record. It runs on reads so a lost callback cannot leave
// a task permanently displaying "cancelling".
func (s *Server) reconcileCancelling(ctx context.Context, realm string, task domain.DelegatedTask) domain.DelegatedTask {
	if task.State != domain.DelegationCancelling || task.SchedulerTaskID == "" {
		return task
	}
	placement, err := s.schedulerPlacement(ctx, realm, task.SchedulerTaskID)
	if err != nil {
		s.log.Debug("取消状态对账暂不可用", "task_id", task.ID, "err", err)
		return task
	}
	state, ok := delegationStateFromScheduler(placement.State)
	if !ok || state == domain.DelegationCancelling || state == task.State {
		return task
	}
	updated, err := s.mirrorExecutionState(ctx, realm, task, state, "")
	if err != nil {
		s.log.Warn("同步取消终态失败", "task_id", task.ID, "err", err)
		return task
	}
	return updated
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
	if !s.requirePermission(r.Context(), w, c, actionDelegate, domain.PermissionResource{ProjectID: req.ProjectID, Kind: "delegation-preview"}) {
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
	if !s.requirePermission(r.Context(), w, c, actionDelegate, domain.PermissionResource{ProjectID: req.ProjectID, Kind: "delegation"}) {
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
	scheduleSnapshot := json.RawMessage(`{}`)
	if req.Schedule != nil {
		var marshalErr error
		scheduleSnapshot, marshalErr = json.Marshal(req.Schedule)
		if marshalErr != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "调度约束无法序列化")
			return
		}
	}
	task := domain.DelegatedTask{
		ID: newID("task"), Realm: c.realm, Title: req.Title, Intent: req.Intent, ProjectID: req.ProjectID,
		RequesterUserID: c.userID, AssigneeUserID: chosen.UserID, AssigneeName: chosen.DisplayName,
		RequiredTags: req.RequiredTags, RequiredSkills: req.RequiredSkills, InferredTags: preview.InferredTags,
		InferredSkills: preview.InferredSkills, SelectedSkills: chosen.MatchedSkills, State: domain.DelegationAssigned,
		BusinessState: domain.BusinessAssigned, ConfidenceBand: chosen.ConfidenceBand, AssigneeWorkerID: chosen.WorkerID,
		ScoreBreakdown: chosen.ScoreBreakdown, ScoreWeights: chosen.ScoreWeights, MatchScore: chosen.Score, Rationale: chosen.Rationale, Schedule: scheduleSnapshot,
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
	// Only realm-level operator roles can inspect the entire realm. A
	// department manager's visibility is applied by Store as a subtree query.
	all := isRealmAdmin(c) || c.roles["operator"] || c.roles["agent_operator"] || c.roles["owner"]
	departmentScope := c.roles["dept_manager"]
	if r.URL.Query().Get("assigned_to") == "me" {
		all = false
		departmentScope = false
	}
	tasks, err := s.store.ListDelegationTasks(r.Context(), c.realm, c.userID, all, departmentScope)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	for i := range tasks {
		tasks[i] = s.reconcileCancelling(r.Context(), c.realm, tasks[i])
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
	task = s.reconcileCancelling(r.Context(), c.realm, task)
	writeJSON(w, http.StatusOK, task)
}

func workerView(profile domain.UserProfile) domain.WorkerProfile {
	return domain.WorkerProfile{
		WorkerID: profile.WorkerID, WorkerKind: profile.WorkerKind, DisplayName: profile.DisplayName,
		ProjectScopeID: profile.ProjectScopeID, PresetVersion: profile.PresetVersion, RuntimeStatus: profile.RuntimeStatus, RuntimeUpdatedAt: profile.RuntimeUpdatedAt,
		Status: profile.Status, Skills: profile.Skills, ActiveTasks: profile.ActiveTasks, Load: profile.Load,
		MaxConcurrency: profile.MaxConcurrency, Confidence: profile.Confidence, Quality: profile.Quality,
		CostNorm: profile.CostNorm, TrustLevel: profile.TrustLevel, Residency: profile.Residency,
		Eligible: profile.Status == "active" && profile.Load <= 0.8 && (profile.WorkerKind != domain.WorkerAgent || profile.RuntimeStatus == "active"),
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

type agentPresetCreateRequest struct {
	ProjectID          string   `json:"project_id,omitempty"`
	Name               string   `json:"name"`
	Description        string   `json:"description,omitempty"`
	OwnerUserID        string   `json:"owner_user_id,omitempty"`
	Status             string   `json:"status,omitempty"`
	Version            string   `json:"version,omitempty"`
	Provider           string   `json:"provider"`
	ModelRef           string   `json:"model_ref"`
	SystemPromptRef    string   `json:"system_prompt_ref,omitempty"`
	ConnectorIDs       []string `json:"connector_ids,omitempty"`
	KnowledgeSpaceIDs  []string `json:"knowledge_space_ids,omitempty"`
	MaxConcurrency     int      `json:"max_concurrency,omitempty"`
	TrustLevel         string   `json:"trust_level,omitempty"`
	Residency          string   `json:"residency,omitempty"`
	MaxBudgetCents     int64    `json:"max_budget_cents,omitempty"`
	TimeoutSeconds     int      `json:"timeout_seconds,omitempty"`
	MaxDelegationDepth int      `json:"max_delegation_depth,omitempty"`
}

func (r agentPresetCreateRequest) preset(realm, presetID, ownerUserID string) domain.AgentPreset {
	if strings.TrimSpace(r.OwnerUserID) != "" {
		ownerUserID = r.OwnerUserID
	}
	preset := domain.AgentPreset{
		ID: presetID, Realm: realm, ProjectID: r.ProjectID, Name: r.Name, Description: r.Description,
		OwnerUserID: ownerUserID, Status: r.Status, Version: r.Version, Provider: r.Provider, ModelRef: r.ModelRef,
		SystemPromptRef: r.SystemPromptRef, ConnectorIDs: r.ConnectorIDs, KnowledgeSpaceIDs: r.KnowledgeSpaceIDs,
		MaxConcurrency: r.MaxConcurrency, TrustLevel: r.TrustLevel, Residency: r.Residency,
		MaxBudgetCents: r.MaxBudgetCents, TimeoutSeconds: r.TimeoutSeconds, MaxDelegationDepth: r.MaxDelegationDepth,
	}
	preset.Normalize()
	return preset
}

// Agent preset PATCH is explicitly sparse; Revision is mandatory so one
// operator cannot silently clobber another operator's configuration update.
type agentPresetPatchRequest struct {
	Revision           int       `json:"revision"`
	ProjectID          *string   `json:"project_id,omitempty"`
	Name               *string   `json:"name,omitempty"`
	Description        *string   `json:"description,omitempty"`
	OwnerUserID        *string   `json:"owner_user_id,omitempty"`
	Status             *string   `json:"status,omitempty"`
	Version            *string   `json:"version,omitempty"`
	Provider           *string   `json:"provider,omitempty"`
	ModelRef           *string   `json:"model_ref,omitempty"`
	SystemPromptRef    *string   `json:"system_prompt_ref,omitempty"`
	ConnectorIDs       *[]string `json:"connector_ids,omitempty"`
	KnowledgeSpaceIDs  *[]string `json:"knowledge_space_ids,omitempty"`
	MaxConcurrency     *int      `json:"max_concurrency,omitempty"`
	TrustLevel         *string   `json:"trust_level,omitempty"`
	Residency          *string   `json:"residency,omitempty"`
	MaxBudgetCents     *int64    `json:"max_budget_cents,omitempty"`
	TimeoutSeconds     *int      `json:"timeout_seconds,omitempty"`
	MaxDelegationDepth *int      `json:"max_delegation_depth,omitempty"`
}

func (r agentPresetPatchRequest) apply(preset *domain.AgentPreset) {
	if r.ProjectID != nil {
		preset.ProjectID = *r.ProjectID
	}
	if r.Name != nil {
		preset.Name = *r.Name
	}
	if r.Description != nil {
		preset.Description = *r.Description
	}
	if r.OwnerUserID != nil {
		preset.OwnerUserID = *r.OwnerUserID
	}
	if r.Status != nil {
		preset.Status = *r.Status
	}
	if r.Version != nil {
		preset.Version = *r.Version
	}
	if r.Provider != nil {
		preset.Provider = *r.Provider
	}
	if r.ModelRef != nil {
		preset.ModelRef = *r.ModelRef
	}
	if r.SystemPromptRef != nil {
		preset.SystemPromptRef = *r.SystemPromptRef
	}
	if r.ConnectorIDs != nil {
		preset.ConnectorIDs = *r.ConnectorIDs
	}
	if r.KnowledgeSpaceIDs != nil {
		preset.KnowledgeSpaceIDs = *r.KnowledgeSpaceIDs
	}
	if r.MaxConcurrency != nil {
		preset.MaxConcurrency = *r.MaxConcurrency
	}
	if r.TrustLevel != nil {
		preset.TrustLevel = *r.TrustLevel
	}
	if r.Residency != nil {
		preset.Residency = *r.Residency
	}
	if r.MaxBudgetCents != nil {
		preset.MaxBudgetCents = *r.MaxBudgetCents
	}
	if r.TimeoutSeconds != nil {
		preset.TimeoutSeconds = *r.TimeoutSeconds
	}
	if r.MaxDelegationDepth != nil {
		preset.MaxDelegationDepth = *r.MaxDelegationDepth
	}
}

func canManageAgentPreset(c caller, preset domain.AgentPreset) bool {
	return isRealmAdmin(c) || preset.OwnerUserID == c.userID
}

func (s *Server) listAgentPresets(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	presets, err := s.store.ListAgentPresets(r.Context(), c.realm)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if !isRealmAdmin(c) {
		owned := presets[:0]
		for _, preset := range presets {
			if preset.OwnerUserID == c.userID {
				owned = append(owned, preset)
			}
		}
		presets = owned
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent_presets": presets})
}

func (s *Server) createAgentPreset(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req agentPresetCreateRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	preset, err := s.store.CreateAgentPreset(r.Context(), req.preset(c.realm, newID("agent"), c.userID))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, preset)
}

func (s *Server) getAgentPreset(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	preset, err := s.store.GetAgentPreset(r.Context(), c.realm, r.PathValue("presetID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if !canManageAgentPreset(c, preset) {
		writeError(w, http.StatusForbidden, "forbidden", "agent preset is not managed by this caller")
		return
	}
	writeJSON(w, http.StatusOK, preset)
}

func (s *Server) updateAgentPreset(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	preset, err := s.store.GetAgentPreset(r.Context(), c.realm, r.PathValue("presetID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if !canManageAgentPreset(c, preset) {
		writeError(w, http.StatusForbidden, "forbidden", "agent preset is not managed by this caller")
		return
	}
	var req agentPresetPatchRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Revision < 1 {
		writeError(w, http.StatusBadRequest, "bad_request", "revision is required")
		return
	}
	if !isRealmAdmin(c) && ((req.OwnerUserID != nil && *req.OwnerUserID != preset.OwnerUserID) || (req.ProjectID != nil && *req.ProjectID != preset.ProjectID)) {
		writeError(w, http.StatusForbidden, "forbidden", "only a realm admin can transfer ownership or project scope")
		return
	}
	req.apply(&preset)
	updated, err := s.store.UpdateAgentPreset(r.Context(), preset, req.Revision)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
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
	if !s.requirePermission(r.Context(), w, c, actionDelegate, domain.PermissionResource{
		Kind: "task", ID: task.ID, ProjectID: task.ProjectID,
	}) {
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

func (s *Server) listTaskAudit(w http.ResponseWriter, r *http.Request) {
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
	events, err := s.store.ListTaskAudit(r.Context(), c.realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
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
	if !ok || !requireExecutionReporter(w, c) {
		return
	}
	task, err := s.store.GetDelegationTask(r.Context(), c.realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
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
	if !ok || !requireExecutionReporter(w, c) {
		return
	}
	if _, err := s.store.GetDelegationTask(r.Context(), c.realm, r.PathValue("taskID")); err != nil {
		s.respondStoreError(w, err)
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
		return to == domain.DelegationQueued || to == domain.DelegationBlocked || to == domain.DelegationCancelling || to == domain.DelegationCancelled
	case domain.DelegationQueued:
		return to == domain.DelegationRunning || to == domain.DelegationBlocked || to == domain.DelegationCancelling || to == domain.DelegationCancelled
	case domain.DelegationRunning:
		return to == domain.DelegationCompleted || to == domain.DelegationFailed || to == domain.DelegationCancelling || to == domain.DelegationCancelled
	case domain.DelegationCancelling:
		return to == domain.DelegationCompleted || to == domain.DelegationFailed || to == domain.DelegationCancelled
	case domain.DelegationBlocked, domain.DelegationFailed:
		return to == domain.DelegationQueued || to == domain.DelegationCancelled
	default:
		return false
	}
}

// cancelDelegation is the sole user-facing cancellation operation. It does
// not accept a caller-supplied state or node identifier: those execution
// fields remain Scheduler-owned and are reconciled from Scheduler afterwards.
func (s *Server) cancelDelegation(w http.ResponseWriter, r *http.Request) {
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
	schedulerTaskID := strings.TrimSpace(task.SchedulerTaskID)
	if schedulerTaskID == "" {
		writeError(w, http.StatusConflict, "not_scheduled", "任务尚未提交给调度器，无法请求执行取消")
		return
	}
	placement, err := s.cancelScheduledRun(r.Context(), c.realm, schedulerTaskID)
	if err != nil {
		s.log.Warn("调度器取消失败", "task_id", task.ID, "scheduler_task_id", schedulerTaskID, "err", err)
		writeError(w, http.StatusServiceUnavailable, "cancel_failed", "调度器或执行节点未确认停止；任务状态未变更")
		return
	}
	state, known := delegationStateFromScheduler(placement.State)
	if !known {
		writeError(w, http.StatusBadGateway, "invalid_scheduler_state", "调度器返回了未知状态")
		return
	}
	updated, err := s.mirrorExecutionState(r.Context(), c.realm, task, state, "")
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if state != domain.DelegationCancelling && state != domain.DelegationCancelled {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "already_terminal", "message": "任务在取消请求处理期间已结束", "task": updated, "scheduler": placement,
		})
		return
	}
	status := http.StatusOK
	if state == domain.DelegationCancelling {
		status = http.StatusAccepted
	}
	writeJSON(w, status, map[string]any{"task": updated, "scheduler": placement})
}

type retryDelegationRequest struct {
	Reason string `json:"reason"`
}

// retryDelegation creates a fresh immutable Run only after Scheduler accepts
// a new attempt for a terminal task. It reuses the original, stored placement
// constraints rather than reconstructing a weaker default schedule.
func (s *Server) retryDelegation(w http.ResponseWriter, r *http.Request) {
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
	if task.State != domain.DelegationFailed && task.State != domain.DelegationCancelled && task.State != domain.DelegationBlocked {
		writeError(w, http.StatusConflict, "run_active", "只有失败、已取消或阻塞的任务可以重试")
		return
	}
	var req retryDelegationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	schedule, err := scheduleFromTask(task)
	if err != nil {
		writeError(w, http.StatusConflict, "invalid_schedule_snapshot", "任务的调度约束快照无效，拒绝弱化后重试")
		return
	}
	if strings.TrimSpace(s.cfg.SchedulerURL) == "" {
		writeError(w, http.StatusServiceUnavailable, "scheduler_unavailable", "调度器未配置，无法创建新的执行尝试")
		return
	}
	schedulerTaskID := task.SchedulerTaskID
	if schedulerTaskID == "" {
		schedulerTaskID = task.ID
	}
	placement, err := s.placeRun(r.Context(), c.realm, schedulerTaskID, schedule)
	if err != nil {
		s.log.Warn("重试放置失败", "task_id", task.ID, "scheduler_task_id", schedulerTaskID, "err", err)
		writeError(w, http.StatusServiceUnavailable, "retry_failed", "调度器未接受新的执行尝试；原任务保持终态")
		return
	}
	workerID := task.AssigneeWorkerID
	if workerID == "" && task.AssigneeUserID != "" {
		workerID = "user:" + task.AssigneeUserID
	}
	if workerID == "" {
		writeError(w, http.StatusConflict, "missing_assignee", "任务缺少可重试的执行者")
		return
	}
	run, err := s.store.CreateNextTaskRun(r.Context(), c.realm, task.ID, domain.TaskRun{
		ID: newID("run"), WorkerID: workerID, SchedulerTaskID: schedulerTaskID,
		AssignedNodeID: placement.NodeID, State: placement.State,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	updated, err := s.store.GetDelegationTask(r.Context(), c.realm, task.ID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if err := s.store.RecordTaskAudit(r.Context(), c.realm, task.ID, "retry_requested", c.userID, map[string]any{
		"from_state": task.State, "run_id": run.ID, "attempt": run.Attempt, "reason": strings.TrimSpace(req.Reason),
		"scheduler_task_id": schedulerTaskID, "assigned_node_id": placement.NodeID,
	}); err != nil {
		s.log.Warn("写入重试审计失败", "task_id", task.ID, "err", err)
	}
	writeJSON(w, http.StatusCreated, map[string]any{"task": updated, "run": run, "scheduler": placement})
}

type reassignDelegationRequest struct {
	AssigneeUserID   string `json:"assignee_user_id"`
	AssigneeWorkerID string `json:"assignee_worker_id"`
	Reason           string `json:"reason"`
}

func selectReassignmentCandidate(candidates []domain.DelegationCandidate, previousWorker, requestedUser, requestedWorker string) *domain.DelegationCandidate {
	for i := range candidates {
		candidate := &candidates[i]
		if !candidate.Eligible || candidate.WorkerID == previousWorker {
			continue
		}
		if requestedUser != "" || requestedWorker != "" {
			if (requestedUser != "" && candidate.UserID == requestedUser) || (requestedWorker != "" && candidate.WorkerID == requestedWorker) {
				return candidate
			}
			continue
		}
		return candidate
	}
	return nil
}

// reassignDelegation selects a different currently-eligible worker and records
// that choice as the next immutable Run. Omitting an assignee chooses the
// highest-ranked eligible candidate other than the prior worker.
func (s *Server) reassignDelegation(w http.ResponseWriter, r *http.Request) {
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
	if task.State != domain.DelegationFailed && task.State != domain.DelegationCancelled && task.State != domain.DelegationBlocked {
		writeError(w, http.StatusConflict, "run_active", "只有失败、已取消或阻塞的任务可以改派")
		return
	}
	var req reassignDelegationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "reason is required for reassignment")
		return
	}
	schedule, err := scheduleFromTask(task)
	if err != nil {
		writeError(w, http.StatusConflict, "invalid_schedule_snapshot", "任务的调度约束快照无效，拒绝弱化后改派")
		return
	}
	spec := domain.DelegationSpec{
		Title: task.Title, Intent: task.Intent, ProjectID: task.ProjectID,
		RequiredTags: task.RequiredTags, RequiredSkills: task.RequiredSkills,
	}
	if schedule != nil {
		spec.Residency = schedule.Residency
		spec.RequiredTrustLevel = schedule.TrustLevel
	}
	preview, err := s.matchDelegation(r.Context(), c.realm, spec)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	previousWorker := task.AssigneeWorkerID
	if previousWorker == "" && task.AssigneeUserID != "" {
		previousWorker = "user:" + task.AssigneeUserID
	}
	requestedUser := strings.TrimSpace(req.AssigneeUserID)
	requestedWorker := strings.TrimSpace(req.AssigneeWorkerID)
	chosen := selectReassignmentCandidate(preview.Candidates, previousWorker, requestedUser, requestedWorker)
	if chosen == nil {
		if requestedUser != "" || requestedWorker != "" {
			writeError(w, http.StatusUnprocessableEntity, "delegatee_not_eligible", "指定的改派对象不满足约束，或仍是原执行者")
		} else {
			writeError(w, http.StatusUnprocessableEntity, "no_eligible_delegatee", "没有可替代的合格执行者")
		}
		return
	}
	if strings.TrimSpace(s.cfg.SchedulerURL) == "" {
		writeError(w, http.StatusServiceUnavailable, "scheduler_unavailable", "调度器未配置，无法创建新的执行尝试")
		return
	}
	schedulerTaskID := task.SchedulerTaskID
	if schedulerTaskID == "" {
		schedulerTaskID = task.ID
	}
	placement, err := s.placeRun(r.Context(), c.realm, schedulerTaskID, schedule)
	if err != nil {
		s.log.Warn("改派放置失败", "task_id", task.ID, "scheduler_task_id", schedulerTaskID, "err", err)
		writeError(w, http.StatusServiceUnavailable, "reassignment_failed", "调度器未接受新的执行尝试；原任务保持终态")
		return
	}
	run, err := s.store.CreateNextAssignedTaskRun(r.Context(), c.realm, task.ID, domain.TaskRun{
		ID: newID("run"), WorkerID: chosen.WorkerID, SchedulerTaskID: schedulerTaskID,
		AssignedNodeID: placement.NodeID, State: placement.State,
	}, store.TaskRunAssignment{
		UserID: chosen.UserID, WorkerID: chosen.WorkerID, SelectedSkills: chosen.MatchedSkills,
		MatchScore: chosen.Score, Rationale: chosen.Rationale, ConfidenceBand: chosen.ConfidenceBand,
		ScoreBreakdown: chosen.ScoreBreakdown, ScoreWeights: chosen.ScoreWeights,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	updated, err := s.store.GetDelegationTask(r.Context(), c.realm, task.ID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if err := s.store.RecordTaskAudit(r.Context(), c.realm, task.ID, "reassigned", c.userID, map[string]any{
		"from_worker_id": previousWorker, "to_worker_id": chosen.WorkerID,
		"run_id": run.ID, "attempt": run.Attempt, "reason": reason,
		"scheduler_task_id": schedulerTaskID, "assigned_node_id": placement.NodeID,
	}); err != nil {
		s.log.Warn("写入改派审计失败", "task_id", task.ID, "err", err)
	}
	writeJSON(w, http.StatusCreated, map[string]any{"task": updated, "run": run, "scheduler": placement})
}

func (s *Server) updateDelegationStatus(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireExecutionReporter(w, c) {
		return
	}
	task, err := s.store.GetDelegationTask(r.Context(), c.realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
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
	Content        string           `json:"content"`
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
	}, domain.SkillVersion{Content: req.Content})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, skill)
}

func (s *Server) listSkillVersions(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	skill, err := s.store.GetSkill(r.Context(), c.realm, r.PathValue("skillID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if !requireSkillSourceAccess(w, c, skill) {
		return
	}
	versions, err := s.store.ListSkillVersions(r.Context(), c.realm, r.PathValue("skillID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": versions})
}

type skillVersionRequest struct {
	Version string `json:"version"`
	Content string `json:"content"`
}

func (s *Server) createSkillVersion(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	skill, err := s.store.GetSkill(r.Context(), c.realm, r.PathValue("skillID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if !requireSkillSourceAccess(w, c, skill) {
		return
	}
	var req skillVersionRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	version, err := s.store.CreateSkillVersion(r.Context(), domain.SkillVersion{
		Realm: c.realm, SkillID: skill.ID, Version: req.Version, Content: req.Content, CreatedBy: c.userID,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, version)
}

// publishSkillVersion is intentionally stricter than draft editing. An author
// may maintain a private source revision, but moving it into the governed
// runtime-release snapshot changes what Provisioner is allowed to assemble
// for the realm and therefore requires realm-admin authority.
func (s *Server) publishSkillVersion(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	governedSkill, err := s.store.GetSkill(r.Context(), c.realm, r.PathValue("skillID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	version, err := s.store.GetSkillVersion(r.Context(), c.realm, governedSkill.ID, r.PathValue("version"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if err := version.ValidateRuntimeSource(governedSkill.Name); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid_runtime_skill", err.Error())
		return
	}
	skill, err := s.store.PublishSkillVersion(r.Context(), c.realm, governedSkill.ID, version.Version, c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, skill)
}

// runtimeSkillSnapshot exposes only the explicitly published revisions to a
// realm administrator. It is a build input for the offline artifact publisher,
// never a runtime download API: nodes receive the same bytes only through a
// Registry-signed Bundle and Provisioner materialization.
func (s *Server) runtimeSkillSnapshot(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	snapshot, err := s.store.RuntimeSkillSnapshot(r.Context(), c.realm)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	const maxSnapshotBytes = 32 << 20
	size := 0
	for _, source := range snapshot.Skills {
		if err := (&domain.SkillVersion{Content: source.Content}).ValidateRuntimeSource(source.Name); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "invalid_runtime_skill", err.Error())
			return
		}
		if source.Digest != fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(source.Content))) {
			writeError(w, http.StatusConflict, "skill_digest_mismatch", "published skill source digest does not match its immutable content")
			return
		}
		size += len(source.Name) + len(source.Version) + len(source.Digest) + len(source.Content)
		if size > maxSnapshotBytes {
			writeError(w, http.StatusUnprocessableEntity, "runtime_snapshot_too_large", "published runtime skill snapshot exceeds 32 MiB")
			return
		}
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) getSkillVersion(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	skill, err := s.store.GetSkill(r.Context(), c.realm, r.PathValue("skillID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if !requireSkillSourceAccess(w, c, skill) {
		return
	}
	version, err := s.store.GetSkillVersion(r.Context(), c.realm, r.PathValue("skillID"), r.PathValue("version"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, version)
}

// Skill source can contain internal prompt instructions or workflow details.
// The catalog remains discoverable for matching, but source revisions are only
// readable or writable by their author and realm administrators.
func requireSkillSourceAccess(w http.ResponseWriter, c caller, skill domain.Skill) bool {
	if skill.CreatedBy == c.userID || isRealmAdmin(c) {
		return true
	}
	writeError(w, http.StatusForbidden, "forbidden", "only the skill author or realm_admin may access skill source")
	return false
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
