// Package domain contains the Cluster-only organization and capability
// governance contracts. It intentionally keeps the feature gate and skill
// precedence pure so every HTTP/storage adapter has one behavior to test.
package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

type DeploymentMode string

const (
	ModeLocal      DeploymentMode = "local"
	ModeStandalone DeploymentMode = "standalone"
	ModeCluster    DeploymentMode = "cluster"
)

const ClusterReady = "ready"

var ErrClusterOnly = errors.New("CLUSTER_ONLY")

// Features is the server-authoritative capability descriptor. A UI may use it
// to hide unavailable controls, but handlers must still call RequireCluster.
type Features struct {
	DeploymentMode         DeploymentMode `json:"deployment_mode"`
	ClusterStatus          string         `json:"cluster_status"`
	OrganizationGovernance bool           `json:"organization_governance"`
	SkillDistribution      bool           `json:"skill_distribution"`
	DesktopWorkers         bool           `json:"desktop_workers"`
	ArtifactRollouts       bool           `json:"artifact_rollouts"`
	CrossNodeDelegation    bool           `json:"cross_node_delegation"`
}

func NewFeatures(mode DeploymentMode, clusterStatus string) Features {
	enabled := mode == ModeCluster && clusterStatus == ClusterReady
	return Features{
		DeploymentMode: mode, ClusterStatus: clusterStatus,
		OrganizationGovernance: enabled, SkillDistribution: enabled,
		DesktopWorkers: enabled, ArtifactRollouts: enabled, CrossNodeDelegation: enabled,
	}
}

func RequireCluster(mode DeploymentMode, clusterStatus string) error {
	if mode != ModeCluster || clusterStatus != ClusterReady {
		return ErrClusterOnly
	}
	return nil
}

// PermissionAction identifies a product action instead of a role. Roles are
// only one possible source of a Realm grant; callers always authorize an
// actor/resource/action/context tuple.
type PermissionAction string

const (
	ActionTaskDelegate        PermissionAction = "task:delegate"
	ActionTaskExecutionUpdate PermissionAction = "task:execution:update"
)

// PermissionActor is the authenticated subject used in an authorization
// explanation. It deliberately contains no caller-supplied grants.
type PermissionActor struct {
	UserID string   `json:"user_id"`
	Realm  string   `json:"realm"`
	Roles  []string `json:"roles"`
}

// PermissionResource is the scoped target of an authorization decision.
// Project and Space are optional, but once supplied each becomes a mandatory
// intersection boundary and can never elevate Realm access.
type PermissionResource struct {
	Kind      string `json:"kind,omitempty"`
	ID        string `json:"id,omitempty"`
	Realm     string `json:"realm"`
	ProjectID string `json:"project_id,omitempty"`
	SpaceID   string `json:"space_id,omitempty"`
}

// PermissionContext carries authoritative adapter facts. A nil ProjectAllowed
// or SpaceAllowed is intentionally treated as deny when that boundary exists:
// an unavailable policy source must never turn into an implicit grant.
type PermissionContext struct {
	RealmAllowed   bool  `json:"realm_allowed"`
	ProjectAllowed *bool `json:"project_allowed,omitempty"`
	SpaceAllowed   *bool `json:"space_allowed,omitempty"`
}

// PermissionRequest is the normalized policy input specified by the control
// plane contract. It is pure so HTTP handlers and future OPA adapters share
// the exact same intersection semantics.
type PermissionRequest struct {
	Actor    PermissionActor    `json:"actor"`
	Resource PermissionResource `json:"resource"`
	Action   PermissionAction   `json:"action"`
	Context  PermissionContext  `json:"context"`
}

// PermissionDecision explains the allow/deny result and the policy facts that
// participated in it. Consumers can show this directly instead of reducing a
// forbidden request to an empty list.
type PermissionDecision struct {
	Allowed         bool               `json:"allowed"`
	Action          PermissionAction   `json:"action"`
	Resource        PermissionResource `json:"resource"`
	Reason          string             `json:"reason"`
	MatchedPolicies []string           `json:"matched_policies"`
}

// EvaluatePermission implements the documented minimum-permission rule:
// Realm ∩ Project ∩ Space. A project role or Space grant cannot compensate for
// a missing Realm grant, and an unknown scoped authorization is a deny.
func EvaluatePermission(req PermissionRequest) PermissionDecision {
	decision := PermissionDecision{Action: req.Action, Resource: req.Resource, MatchedPolicies: []string{}}
	if req.Resource.Realm == "" || req.Resource.Realm != req.Actor.Realm {
		decision.Reason = "资源 realm 与调用者 realm 不一致"
		return decision
	}
	if !req.Context.RealmAllowed {
		decision.Reason = "Realm 策略未授予该动作"
		return decision
	}
	decision.MatchedPolicies = append(decision.MatchedPolicies, "realm:action")
	if req.Resource.ProjectID != "" {
		if req.Context.ProjectAllowed == nil {
			decision.Reason = "项目授权状态未知，按最小权限原则拒绝"
			return decision
		}
		if !*req.Context.ProjectAllowed {
			decision.Reason = "项目成员策略未授予该动作"
			return decision
		}
		decision.MatchedPolicies = append(decision.MatchedPolicies, "project:member")
	}
	if req.Resource.SpaceID != "" {
		if req.Context.SpaceAllowed == nil {
			decision.Reason = "Space 授权状态未知，按最小权限原则拒绝"
			return decision
		}
		if !*req.Context.SpaceAllowed {
			decision.Reason = "Space 策略未授予该动作"
			return decision
		}
		decision.MatchedPolicies = append(decision.MatchedPolicies, "space:grant")
	}
	decision.Allowed = true
	decision.Reason = "Realm、项目与 Space 边界均允许该动作"
	return decision
}

type User struct {
	ID            string    `json:"id"`
	Realm         string    `json:"realm"`
	DisplayName   string    `json:"display_name"`
	PrimaryDeptID string    `json:"primary_dept_id,omitempty"`
	Status        string    `json:"status"`
	Source        string    `json:"source"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// UserProfile is the read model used by the delegation matcher. It keeps the
// matching inputs explicit so an operator can explain why a person was chosen.
// Skills are already resolved by the governance precedence rules; callers must
// never match against raw grants.
type UserProfile struct {
	User
	WorkerID   string `json:"worker_id"`
	WorkerKind string `json:"worker_kind"`
	// ProjectScopeID is empty for humans and globally available agents. For an
	// agent preset it is a hard asset scope, not a soft matching preference.
	ProjectScopeID string `json:"project_scope_id,omitempty"`
	PresetVersion  string `json:"preset_version,omitempty"`
	// RuntimeStatus is empty for people. Agent presets are not executable until
	// their runtime reports an active state; not_reported is deliberately not
	// treated as active simply because a desired asset exists.
	RuntimeStatus    string           `json:"runtime_status,omitempty"`
	RuntimeUpdatedAt *time.Time       `json:"runtime_updated_at,omitempty"`
	Tags             []string         `json:"tags"`
	Skills           []EffectiveSkill `json:"skills"`
	ActiveTasks      int              `json:"active_tasks"`
	Load             float64          `json:"load"`
	Confidence       float64          `json:"confidence"`
	Quality          float64          `json:"quality"`
	CostNorm         float64          `json:"cost_norm"`
	MaxConcurrency   int              `json:"max_concurrency,omitempty"`
	TrustLevel       string           `json:"trust_level,omitempty"`
	Residency        string           `json:"residency,omitempty"`
}

// WorkerProfile is the unified read model returned to the control plane. It
// deliberately has no workers table behind it: humans come from users and
// agents come from runtime rows + agent grants.
type WorkerProfile struct {
	WorkerID         string           `json:"worker_id"`
	WorkerKind       string           `json:"worker_kind"`
	DisplayName      string           `json:"display_name"`
	ProjectScopeID   string           `json:"project_scope_id,omitempty"`
	PresetVersion    string           `json:"preset_version,omitempty"`
	RuntimeStatus    string           `json:"runtime_status,omitempty"`
	RuntimeUpdatedAt *time.Time       `json:"runtime_updated_at,omitempty"`
	Status           string           `json:"status"`
	Skills           []EffectiveSkill `json:"skills"`
	ActiveTasks      int              `json:"active_tasks"`
	Load             float64          `json:"load"`
	MaxConcurrency   int              `json:"max_concurrency"`
	Confidence       float64          `json:"confidence"`
	Quality          float64          `json:"quality"`
	CostNorm         float64          `json:"cost_norm"`
	TrustLevel       string           `json:"trust_level,omitempty"`
	Residency        string           `json:"residency,omitempty"`
	Eligible         bool             `json:"eligible"`
}

// AgentPreset is a managed Agent asset. It owns desired configuration and
// delegation limits; it is deliberately not another Worker table. Runtime
// liveness and run counts remain in governance_worker_runtime and task runs.
// SystemPromptRef is a reference to a protected prompt/configuration source,
// never prompt contents or credentials.
type AgentPreset struct {
	ID                 string    `json:"id"`
	Realm              string    `json:"realm"`
	ProjectID          string    `json:"project_id,omitempty"`
	Name               string    `json:"name"`
	Description        string    `json:"description,omitempty"`
	OwnerUserID        string    `json:"owner_user_id"`
	Status             string    `json:"status"`
	Version            string    `json:"version"`
	Revision           int       `json:"revision"`
	Provider           string    `json:"provider"`
	ModelRef           string    `json:"model_ref"`
	SystemPromptRef    string    `json:"system_prompt_ref,omitempty"`
	ConnectorIDs       []string  `json:"connector_ids"`
	KnowledgeSpaceIDs  []string  `json:"knowledge_space_ids"`
	MaxConcurrency     int       `json:"max_concurrency"`
	TrustLevel         string    `json:"trust_level,omitempty"`
	Residency          string    `json:"residency,omitempty"`
	MaxBudgetCents     int64     `json:"max_budget_cents"`
	TimeoutSeconds     int       `json:"timeout_seconds"`
	MaxDelegationDepth int       `json:"max_delegation_depth"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

// Normalize applies safe defaults and canonicalizes reference lists before a
// preset is persisted. The authoritative connector and Space services still
// validate existence when their execution integrations are wired.
func (p *AgentPreset) Normalize() {
	p.ID = strings.TrimSpace(p.ID)
	p.Realm = strings.TrimSpace(p.Realm)
	p.ProjectID = strings.TrimSpace(p.ProjectID)
	p.Name = strings.TrimSpace(p.Name)
	p.Description = strings.TrimSpace(p.Description)
	p.OwnerUserID = strings.TrimSpace(p.OwnerUserID)
	p.Status = strings.TrimSpace(strings.ToLower(p.Status))
	p.Version = strings.TrimSpace(p.Version)
	p.Provider = strings.TrimSpace(p.Provider)
	p.ModelRef = strings.TrimSpace(p.ModelRef)
	p.SystemPromptRef = strings.TrimSpace(p.SystemPromptRef)
	p.TrustLevel = strings.TrimSpace(p.TrustLevel)
	p.Residency = strings.TrimSpace(p.Residency)
	if p.Status == "" {
		p.Status = "active"
	}
	if p.Version == "" {
		p.Version = "1.0.0"
	}
	if p.MaxConcurrency == 0 {
		p.MaxConcurrency = 1
	}
	if p.TimeoutSeconds == 0 {
		p.TimeoutSeconds = 3600
	}
	p.ConnectorIDs = normalizedReferences(p.ConnectorIDs)
	p.KnowledgeSpaceIDs = normalizedReferences(p.KnowledgeSpaceIDs)
}

// Valid checks only boundaries this service owns. It does not invent model,
// connector, or Space availability from a display field.
func (p AgentPreset) Valid() bool {
	if p.ID == "" || p.Realm == "" || p.Name == "" || p.OwnerUserID == "" || p.Provider == "" || p.ModelRef == "" {
		return false
	}
	if p.Status != "active" && p.Status != "disabled" {
		return false
	}
	if len([]rune(p.ID)) > 128 || len([]rune(p.Name)) > 160 || len([]rune(p.Version)) > 64 || len([]rune(p.Provider)) > 128 || len([]rune(p.ModelRef)) > 256 {
		return false
	}
	if p.MaxConcurrency < 1 || p.TimeoutSeconds < 1 || p.TimeoutSeconds > 86400 || p.MaxBudgetCents < 0 || p.MaxDelegationDepth < 0 || p.MaxDelegationDepth > 16 {
		return false
	}
	return len(p.ConnectorIDs) <= 200 && len(p.KnowledgeSpaceIDs) <= 200
}

func normalizedReferences(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || len([]rune(value)) > 256 || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

type DelegationSpec struct {
	Title              string   `json:"title"`
	Intent             string   `json:"intent"`
	ProjectID          string   `json:"project_id"`
	RequiredTags       []string `json:"required_tags"`
	RequiredSkills     []string `json:"required_skills"`
	Residency          string   `json:"residency,omitempty"`
	RequiredTrustLevel string   `json:"required_trust_level,omitempty"`
}

type DelegationCandidate struct {
	WorkerID       string                 `json:"worker_id"`
	WorkerKind     string                 `json:"worker_kind"`
	AgentRef       string                 `json:"agent_ref,omitempty"`
	UserID         string                 `json:"user_id"`
	DisplayName    string                 `json:"display_name"`
	DepartmentID   string                 `json:"department_id,omitempty"`
	TrustLevel     string                 `json:"trust_level,omitempty"`
	Residency      string                 `json:"residency,omitempty"`
	Tags           []string               `json:"tags"`
	Skills         []string               `json:"skills"`
	MatchedTags    []string               `json:"matched_tags"`
	MatchedSkills  []string               `json:"matched_skills"`
	Score          int                    `json:"score"`
	ConfidenceBand string                 `json:"confidence_band"`
	ScoreBreakdown DispatchScoreBreakdown `json:"score_breakdown"`
	ScoreWeights   DispatchWeights        `json:"score_weights"`
	ActiveTasks    int                    `json:"active_tasks"`
	Eligible       bool                   `json:"eligible"`
	Rationale      []string               `json:"rationale"`
}

type DelegatedTask struct {
	ID               string                 `json:"id"`
	Realm            string                 `json:"realm"`
	Title            string                 `json:"title"`
	Intent           string                 `json:"intent"`
	ProjectID        string                 `json:"project_id,omitempty"`
	RequesterUserID  string                 `json:"requester_user_id"`
	AssigneeUserID   string                 `json:"assignee_user_id"`
	AssigneeName     string                 `json:"assignee_name,omitempty"`
	RequiredTags     []string               `json:"required_tags"`
	RequiredSkills   []string               `json:"required_skills"`
	InferredTags     []string               `json:"inferred_tags"`
	InferredSkills   []string               `json:"inferred_skills"`
	SelectedSkills   []string               `json:"selected_skills"`
	State            string                 `json:"state"`
	BusinessState    string                 `json:"business_state,omitempty"`
	ConfidenceBand   string                 `json:"confidence_band,omitempty"`
	AssigneeWorkerID string                 `json:"assignee_worker_id,omitempty"`
	ScoreBreakdown   DispatchScoreBreakdown `json:"score_breakdown,omitempty"`
	ScoreWeights     DispatchWeights        `json:"score_weights,omitempty"`
	MatchScore       int                    `json:"match_score"`
	Rationale        []string               `json:"rationale"`
	SchedulerTaskID  string                 `json:"scheduler_task_id,omitempty"`
	AssignedNodeID   string                 `json:"assigned_node_id,omitempty"`
	// Schedule preserves the scheduler constraints selected at delegation time
	// so retries never silently weaken residency, queue or capability rules.
	Schedule  json.RawMessage `json:"schedule,omitempty"`
	LastError string          `json:"last_error,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

// DispatchWeights 是可重放的派单权重快照。字段名与 seam-contracts/dispatch.ts
// 对齐；历史任务永远使用自己落库的快照，不读取今天的默认值。
type DispatchWeights struct {
	Match      float64 `json:"match"`
	Confidence float64 `json:"confidence"`
	Load       float64 `json:"load"`
	Quality    float64 `json:"quality"`
	Cost       float64 `json:"cost"`
}

type DispatchScoreBreakdown struct {
	Match            float64         `json:"match"`
	Confidence       float64         `json:"confidence"`
	Load             float64         `json:"load"`
	Quality          float64         `json:"quality"`
	CostNorm         float64         `json:"cost_norm"`
	EffectiveWeights DispatchWeights `json:"effective_weights"`
	Contributions    DispatchWeights `json:"contributions"`
	WeightedTotal    float64         `json:"weighted_total"`
}

type DispatchScore struct {
	Score     int                    `json:"score"`
	Band      string                 `json:"band"`
	Breakdown DispatchScoreBreakdown `json:"breakdown"`
	Weights   DispatchWeights        `json:"weights"`
}

const (
	WorkerHuman   = "human"
	WorkerAgent   = "agent"
	BandAuto      = "AUTO"
	BandSuggested = "SUGGESTED"
	BandManual    = "MANUAL"
)

var DefaultDispatchWeights = DispatchWeights{Match: 0.35, Confidence: 0.10, Load: 0.20, Quality: 0.25, Cost: 0.10}

func (w DispatchWeights) valid() bool {
	sum := w.Match + w.Confidence + w.Load + w.Quality + w.Cost
	return finiteUnit(w.Match) && finiteUnit(w.Confidence) && finiteUnit(w.Load) && finiteUnit(w.Quality) && finiteUnit(w.Cost) && math.Abs(sum-1) < 1e-9 && w.Cost < 1
}

func finiteUnit(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v <= 1 }

func ConfidenceBandOf(score int) string {
	if score < 0 || score > 100 {
		return ""
	}
	if score >= 90 {
		return BandAuto
	}
	if score >= 70 {
		return BandSuggested
	}
	return BandManual
}

// ScoreCandidate implements §23.2. Human candidates drop the incomparable cost
// dimension and renormalize the remaining weights; Agent candidates retain all
// five dimensions. All input dimensions are validated instead of silently
// clamped so a malformed profile cannot create an attractive false score.
func ScoreCandidate(kind string, match, confidence, load, quality, costNorm float64, weights DispatchWeights) (DispatchScore, error) {
	if kind != WorkerHuman && kind != WorkerAgent {
		return DispatchScore{}, fmt.Errorf("unknown worker kind %q", kind)
	}
	if !finiteUnit(match) || !finiteUnit(confidence) || !finiteUnit(load) || !finiteUnit(quality) || !finiteUnit(costNorm) {
		return DispatchScore{}, errors.New("dispatch dimensions must be within [0,1]")
	}
	if !weights.valid() {
		return DispatchScore{}, errors.New("dispatch weights must be non-negative and sum to 1")
	}
	denominator := 1.0
	if kind == WorkerHuman {
		denominator = 1 - weights.Cost
	}
	effective := DispatchWeights{
		Match: weights.Match / denominator, Confidence: weights.Confidence / denominator,
		Load: weights.Load / denominator, Quality: weights.Quality / denominator,
	}
	if kind == WorkerAgent {
		effective.Cost = weights.Cost / denominator
	}
	dimensions := DispatchScoreBreakdown{
		Match: match, Confidence: match * confidence, Load: 1 - load,
		Quality: quality, CostNorm: costNorm, EffectiveWeights: effective,
	}
	dimensions.Contributions = DispatchWeights{
		Match:      effective.Match * dimensions.Match,
		Confidence: effective.Confidence * dimensions.Confidence,
		Load:       effective.Load * dimensions.Load,
		Quality:    effective.Quality * dimensions.Quality,
		Cost:       effective.Cost * (1 - costNorm),
	}
	dimensions.WeightedTotal = dimensions.Contributions.Match + dimensions.Contributions.Confidence + dimensions.Contributions.Load + dimensions.Contributions.Quality + dimensions.Contributions.Cost
	score := int(math.Round(math.Max(0, math.Min(100, dimensions.WeightedTotal*100))))
	return DispatchScore{Score: score, Band: ConfidenceBandOf(score), Breakdown: dimensions, Weights: weights}, nil
}

const (
	DelegationAssigned = "ASSIGNED"
	DelegationQueued   = "QUEUED"
	DelegationRunning  = "RUNNING"
	// DelegationCancelling means Scheduler has acknowledged the stop request;
	// it remains non-terminal until the execution node reports its final state.
	DelegationCancelling = "CANCELLING"
	DelegationCompleted  = "COMPLETED"
	DelegationFailed     = "FAILED"
	DelegationCancelled  = "CANCELLED"
	DelegationBlocked    = "BLOCKED"
)

const (
	BusinessDraft     = "DRAFT"
	BusinessRouting   = "ROUTING"
	BusinessAssigned  = "ASSIGNED"
	BusinessExecuting = "EXECUTING"
	BusinessVerifying = "VERIFYING"
	BusinessInReview  = "IN_REVIEW"
	BusinessDone      = "DONE"
	BusinessRejected  = "REJECTED"
	BusinessArchived  = "ARCHIVED"
)

var businessStates = map[string]bool{
	BusinessDraft: true, BusinessRouting: true, BusinessAssigned: true,
	BusinessExecuting: true, BusinessVerifying: true, BusinessInReview: true,
	BusinessDone: true, BusinessRejected: true, BusinessArchived: true,
}

// TaskRun is one immutable execution attempt. Reassignment creates another
// row; it never overwrites the old node, session or error.
type TaskRun struct {
	ID              string     `json:"id"`
	Realm           string     `json:"realm"`
	TaskID          string     `json:"task_id"`
	Attempt         int        `json:"attempt"`
	WorkerID        string     `json:"worker_id"`
	SessionRef      string     `json:"session_ref,omitempty"`
	SchedulerTaskID string     `json:"scheduler_task_id,omitempty"`
	AssignedNodeID  string     `json:"assigned_node_id,omitempty"`
	State           string     `json:"state"`
	FailureKind     string     `json:"failure_kind,omitempty"`
	LastError       string     `json:"last_error,omitempty"`
	StartedAt       *time.Time `json:"started_at,omitempty"`
	EndedAt         *time.Time `json:"ended_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
}

// TaskAuditEvent is the immutable control-plane trail for a business Task.
// It records the actor and rationale for retry, reassignment and state changes
// separately from the technical Run, so operators can explain the decision.
type TaskAuditEvent struct {
	ID        string          `json:"id"`
	Realm     string          `json:"realm"`
	TaskID    string          `json:"task_id"`
	Event     string          `json:"event"`
	Actor     string          `json:"actor"`
	Detail    json.RawMessage `json:"detail"`
	CreatedAt time.Time       `json:"created_at"`
}

const (
	OutcomeAccepted     = "ACCEPTED"
	OutcomeReassigned   = "REASSIGNED"
	OutcomeReworked     = "REWORKED"
	OutcomeRejected     = "REJECTED"
	OutcomeFirstPass    = "FIRST_PASS"
	ReasonSkillMismatch = "SKILL_MISMATCH"
	ReasonOverloaded    = "OVERLOADED"
	ReasonError         = "ERROR"
	ReasonOther         = "OTHER"
)

func ValidDispatchOutcome(value string) bool {
	switch value {
	case OutcomeAccepted, OutcomeReassigned, OutcomeReworked, OutcomeRejected, OutcomeFirstPass:
		return true
	default:
		return false
	}
}

func ValidReassignReason(value string) bool {
	switch value {
	case ReasonSkillMismatch, ReasonOverloaded, ReasonError, ReasonOther:
		return true
	default:
		return false
	}
}

type DispatchOutcome struct {
	ID        string    `json:"id"`
	Realm     string    `json:"realm"`
	TaskID    string    `json:"task_id"`
	RunID     string    `json:"run_id"`
	WorkerID  string    `json:"worker_id"`
	Outcome   string    `json:"outcome"`
	Reason    string    `json:"reason"`
	Notes     string    `json:"notes,omitempty"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
}

type ReportEvidence struct {
	SessionRef string `json:"session_ref"`
	Seq        int64  `json:"seq"`
}

type ReportSection struct {
	Name     string           `json:"name"`
	Content  json.RawMessage  `json:"content"`
	Evidence []ReportEvidence `json:"evidence"`
	Verified bool             `json:"verified"`
}

type TaskReport struct {
	ID          string          `json:"id"`
	Realm       string          `json:"realm"`
	TaskID      string          `json:"task_id"`
	RunID       string          `json:"run_id,omitempty"`
	Sections    []ReportSection `json:"sections"`
	Status      string          `json:"status"`
	Stale       bool            `json:"stale,omitempty"`
	StaleReason string          `json:"stale_reason,omitempty"`
	CreatedBy   string          `json:"created_by"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

const (
	ReportDraft     = "draft"
	ReportConfirmed = "confirmed"
	ReportArchived  = "archived"
)

func ValidReportStatus(value string) bool {
	return value == ReportDraft || value == ReportConfirmed || value == ReportArchived
}

// TransitionBusinessTask is the only business-state transition authority.
// Same-state calls are idempotent; terminal archive is the only legal exit
// from DONE/REJECTED and ARCHIVED cannot move again.
func TransitionBusinessTask(from, event string) (string, error) {
	if !businessStates[from] {
		return "", fmt.Errorf("unknown business state %q", from)
	}
	targets := map[string]string{
		"route": BusinessRouting, "assign": BusinessAssigned, "start": BusinessExecuting,
		"verify": BusinessVerifying, "submit_review": BusinessInReview, "complete": BusinessDone,
		"reject": BusinessRejected, "archive": BusinessArchived, "reroute": BusinessRouting,
	}
	to, ok := targets[event]
	if !ok {
		return "", fmt.Errorf("unknown business task event %q", event)
	}
	allowed := map[string]map[string]bool{
		BusinessDraft:     {BusinessRouting: true},
		BusinessRouting:   {BusinessRouting: true, BusinessAssigned: true},
		BusinessAssigned:  {BusinessAssigned: true, BusinessExecuting: true, BusinessRouting: true},
		BusinessExecuting: {BusinessExecuting: true, BusinessVerifying: true, BusinessRouting: true},
		BusinessVerifying: {BusinessVerifying: true, BusinessInReview: true, BusinessRouting: true},
		BusinessInReview:  {BusinessInReview: true, BusinessDone: true, BusinessRejected: true, BusinessRouting: true},
		BusinessDone:      {BusinessDone: true, BusinessArchived: true},
		BusinessRejected:  {BusinessRejected: true, BusinessRouting: true, BusinessArchived: true},
		BusinessArchived:  {BusinessArchived: true},
	}
	if !allowed[from][to] {
		return "", fmt.Errorf("business task cannot transition %s via %s to %s", from, event, to)
	}
	return to, nil
}

func ValidDelegationState(value string) bool {
	switch value {
	case DelegationAssigned, DelegationQueued, DelegationRunning, DelegationCancelling, DelegationCompleted, DelegationFailed, DelegationCancelled, DelegationBlocked:
		return true
	default:
		return false
	}
}

// DelegationStateActive means the current Run still owns execution capacity.
// A retry or reassignment must create a new attempt only after this becomes
// false, otherwise two workers could execute the same business task.
func DelegationStateActive(value string) bool {
	return value == DelegationAssigned || value == DelegationQueued || value == DelegationRunning || value == DelegationCancelling
}

// RankDelegationCandidates performs deterministic, explainable intent
// matching. It deliberately does not invent authority or silently choose a
// person when the intent has no overlap with a governed tag or skill.
func RankDelegationCandidates(spec DelegationSpec, profiles []UserProfile) (inferredTags, inferredSkills []string, candidates []DelegationCandidate) {
	intent := strings.ToLower(strings.TrimSpace(spec.Intent))
	inferredTagSet := map[string]bool{}
	inferredSkillSet := map[string]bool{}
	for _, profile := range profiles {
		for _, tag := range profile.Tags {
			if termInText(intent, tag) {
				inferredTagSet[strings.ToLower(strings.TrimSpace(tag))] = true
			}
		}
		for _, skill := range profile.Skills {
			if termInText(intent, skill.Name) || termInText(intent, skill.SkillID) {
				inferredSkillSet[strings.ToLower(strings.TrimSpace(skill.Name))] = true
			}
		}
	}
	for _, profile := range profiles {
		for _, tag := range profile.Tags {
			key := strings.ToLower(strings.TrimSpace(tag))
			if inferredTagSet[key] && !containsFold(inferredTags, tag) {
				inferredTags = append(inferredTags, tag)
			}
		}
		for _, skill := range profile.Skills {
			key := strings.ToLower(strings.TrimSpace(skill.Name))
			if inferredSkillSet[key] && !containsFold(inferredSkills, skill.Name) {
				inferredSkills = append(inferredSkills, skill.Name)
			}
		}
	}

	for _, profile := range profiles {
		workerKind := profile.WorkerKind
		if workerKind == "" {
			workerKind = WorkerHuman
		}
		workerID := profile.WorkerID
		if workerID == "" {
			workerID = "user:" + profile.ID
		}
		candidate := DelegationCandidate{
			WorkerID: workerID, WorkerKind: workerKind, DisplayName: profile.DisplayName,
			DepartmentID: profile.PrimaryDeptID, Tags: append([]string(nil), profile.Tags...),
			UserID: profile.ID, TrustLevel: profile.TrustLevel, Residency: profile.Residency,
			ActiveTasks: profile.ActiveTasks,
		}
		if workerKind == WorkerAgent {
			candidate.AgentRef = strings.TrimPrefix(workerID, "agent:")
		}
		for _, skill := range profile.Skills {
			candidate.Skills = append(candidate.Skills, skill.Name)
		}
		for _, tag := range append(append([]string{}, spec.RequiredTags...), inferredTags...) {
			if containsFold(profile.Tags, tag) && !containsFold(candidate.MatchedTags, tag) {
				candidate.MatchedTags = append(candidate.MatchedTags, tag)
			}
		}
		for _, wanted := range append(append([]string{}, spec.RequiredSkills...), inferredSkills...) {
			for _, skill := range profile.Skills {
				if equalFold(skill.Name, wanted) || equalFold(skill.SkillID, wanted) {
					if !containsFold(candidate.MatchedSkills, skill.Name) {
						candidate.MatchedSkills = append(candidate.MatchedSkills, skill.Name)
					}
					break
				}
			}
		}
		missing := 0
		for _, wanted := range spec.RequiredTags {
			if !containsFold(candidate.MatchedTags, wanted) {
				missing++
			}
		}
		for _, wanted := range spec.RequiredSkills {
			found := false
			for _, skill := range candidate.MatchedSkills {
				if equalFold(skill, wanted) {
					found = true
					break
				}
			}
			if !found {
				missing++
			}
		}
		wantedTags := append(append([]string{}, spec.RequiredTags...), inferredTags...)
		wantedSkills := append(append([]string{}, spec.RequiredSkills...), inferredSkills...)
		signalCount := len(uniqueFold(wantedTags)) + len(uniqueFold(wantedSkills))
		matchedCount := float64(len(uniqueFold(candidate.MatchedTags)))
		for _, wanted := range uniqueFold(wantedSkills) {
			for _, skill := range profile.Skills {
				if !equalFold(skill.Name, wanted) && !equalFold(skill.SkillID, wanted) {
					continue
				}
				// A grant without a proficiency row is authorized but cold-start;
				// keep membership match at 1 while C remains 0. A recorded level
				// contributes its normalized 0–5 proficiency.
				proficiency := 1.0
				if skill.Level > 0 {
					proficiency = float64(skill.Level) / 5
				}
				matchedCount += proficiency
				break
			}
		}
		match := 0.0
		if signalCount > 0 {
			match = float64(matchedCount) / float64(signalCount)
		}
		load := profile.Load
		if load == 0 && profile.ActiveTasks > 0 && workerKind == WorkerAgent && profile.MaxConcurrency > 0 {
			// Agent capacity is an explicit runtime fact. Human capacity is not
			// inferred from active task count because Lumo has no human staffing
			// or concurrency model to justify a made-up denominator.
			load = float64(profile.ActiveTasks) / float64(profile.MaxConcurrency)
		}
		if load < 0 {
			load = 0
		}
		if load > 1 {
			load = 1
		}
		confidence := profile.Confidence
		if confidence < 0 {
			confidence = 0
		}
		quality := profile.Quality
		if quality <= 0 {
			quality = 0.5
		}
		costNorm := profile.CostNorm
		if costNorm < 0 {
			costNorm = 0
		}
		score, scoreErr := ScoreCandidate(workerKind, match, confidence, load, quality, costNorm, DefaultDispatchWeights)
		residencyOK := spec.Residency == "" || profile.Residency == spec.Residency
		trustOK := spec.RequiredTrustLevel == "" || profile.TrustLevel == spec.RequiredTrustLevel
		projectScopeOK := workerKind != WorkerAgent || profile.ProjectScopeID == "" || profile.ProjectScopeID == spec.ProjectID
		runtimeReady := workerKind != WorkerAgent || profile.RuntimeStatus == "active"
		candidate.Eligible = profile.Status == "active" && runtimeReady && missing == 0 && signalCount > 0 && load <= 0.8 && residencyOK && trustOK && projectScopeOK && scoreErr == nil
		if scoreErr == nil {
			candidate.Score = score.Score
			candidate.ConfidenceBand = score.Band
			candidate.ScoreBreakdown = score.Breakdown
			candidate.ScoreWeights = score.Weights
		}
		if candidate.Eligible {
			candidate.Rationale = append(candidate.Rationale, "满足显式与意图匹配条件")
		} else if profile.Status != "active" {
			candidate.Rationale = append(candidate.Rationale, "用户状态不是 active")
		} else if missing > 0 {
			candidate.Rationale = append(candidate.Rationale, "缺少必需标签或技能")
		} else if load > 0.8 {
			candidate.Rationale = append(candidate.Rationale, fmt.Sprintf("负载 %.0f%% 超过 80%% 派单阈值", load*100))
		} else if !residencyOK {
			candidate.Rationale = append(candidate.Rationale, "数据驻留不满足任务约束")
		} else if !trustOK {
			candidate.Rationale = append(candidate.Rationale, "信任等级不满足任务约束")
		} else if !projectScopeOK {
			candidate.Rationale = append(candidate.Rationale, "Agent preset 不在此项目的授权范围内")
		} else if !runtimeReady {
			candidate.Rationale = append(candidate.Rationale, "Agent 执行态尚未上报 active 健康状态")
		} else if scoreErr != nil {
			candidate.Rationale = append(candidate.Rationale, "候选评分输入非法")
		} else {
			candidate.Rationale = append(candidate.Rationale, "意图没有命中已治理的标签或技能")
		}
		candidate.Rationale = append(candidate.Rationale, fmt.Sprintf("当前进行中任务 %d 个", profile.ActiveTasks))
		if candidate.ConfidenceBand != "" {
			candidate.Rationale = append(candidate.Rationale, "置信度分档 "+candidate.ConfidenceBand)
		}
		candidates = append(candidates, candidate)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Eligible != candidates[j].Eligible {
			return candidates[i].Eligible
		}
		if candidates[i].Score != candidates[j].Score {
			return candidates[i].Score > candidates[j].Score
		}
		if candidates[i].ActiveTasks != candidates[j].ActiveTasks {
			return candidates[i].ActiveTasks < candidates[j].ActiveTasks
		}
		return candidates[i].UserID < candidates[j].UserID
	})
	return inferredTags, inferredSkills, candidates
}

func termInText(text, value string) bool {
	term := strings.ToLower(strings.TrimSpace(value))
	return term != "" && strings.Contains(text, term)
}

func equalFold(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}

func containsFold(values []string, wanted string) bool {
	for _, value := range values {
		if equalFold(value, wanted) {
			return true
		}
	}
	return false
}

func uniqueFold(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		key := strings.ToLower(strings.TrimSpace(value))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, value)
	}
	return out
}

// IntentTerms is intentionally small and deterministic; it is useful to UI
// previews that want to show the words considered by the matcher.
func IntentTerms(value string) []string {
	seen := map[string]bool{}
	terms := []string{}
	for _, part := range strings.FieldsFunc(strings.ToLower(value), func(r rune) bool { return unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) }) {
		if len([]rune(part)) < 2 || seen[part] {
			continue
		}
		seen[part] = true
		terms = append(terms, part)
	}
	return terms
}

type Department struct {
	ID            string `json:"id"`
	Realm         string `json:"realm"`
	ParentDeptID  string `json:"parent_dept_id,omitempty"`
	Name          string `json:"name"`
	ManagerUserID string `json:"manager_user_id,omitempty"`
	Path          string `json:"path"`
	Level         int    `json:"level"`
	Status        string `json:"status"`
}

type Role struct {
	ID          string `json:"id"`
	Realm       string `json:"realm"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Status      string `json:"status"`
}

type SkillKind string

const (
	SkillPrompt    SkillKind = "prompt"
	SkillWorkflow  SkillKind = "workflow"
	SkillTool      SkillKind = "tool"
	SkillConnector SkillKind = "connector"
)

func (k SkillKind) Valid() bool {
	return k == SkillPrompt || k == SkillWorkflow || k == SkillTool || k == SkillConnector
}

type Skill struct {
	ID               string     `json:"id"`
	Realm            string     `json:"realm"`
	Name             string     `json:"name"`
	Description      string     `json:"description,omitempty"`
	Kind             SkillKind  `json:"kind"`
	Visibility       string     `json:"visibility"`
	CurrentVersion   string     `json:"current_version"`
	PublishedVersion string     `json:"published_version,omitempty"`
	PublishedDigest  string     `json:"published_digest,omitempty"`
	PublishedBy      string     `json:"published_by,omitempty"`
	PublishedAt      *time.Time `json:"published_at,omitempty"`
	CreatedBy        string     `json:"created_by"`
	CreatedAt        time.Time  `json:"created_at"`
}

// SkillVersion is an immutable, governed source revision. It deliberately
// lives separately from the node installation: saving governance content only
// advances Skill.CurrentVersion. A realm administrator must explicitly select
// one immutable revision as Skill.PublishedVersion before the protected
// artifact publisher may include it in a node runtime snapshot.
type SkillVersion struct {
	Realm     string    `json:"realm"`
	SkillID   string    `json:"skill_id"`
	Version   string    `json:"version"`
	Content   string    `json:"content,omitempty"`
	Digest    string    `json:"digest"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
}

func (v SkillVersion) Valid() bool {
	return v.Realm != "" && v.SkillID != "" && v.Version != "" && v.Content != "" && len(v.Content) <= 128<<10 && v.CreatedBy != ""
}

// RuntimeSkillSource is the complete, immutable source selected for a
// governed runtime snapshot. It intentionally contains the body because the
// offline artifact publisher needs to place the exact reviewed bytes into a
// signed Bundle; DSH nodes never fetch this API at invocation time.
type RuntimeSkillSource struct {
	SkillID string `json:"skill_id"`
	Name    string `json:"name"`
	Version string `json:"version"`
	Digest  string `json:"digest"`
	Content string `json:"content"`
}

// RuntimeSkillSnapshot is the source input for the offline signed-artifact
// build. It is deliberately separate from a node's installed snapshot: this
// document is governance state, while a node only trusts the Registry Bundle.
type RuntimeSkillSnapshot struct {
	Realm  string               `json:"realm"`
	Skills []RuntimeSkillSource `json:"skills"`
}

var runtimeSkillName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

// ValidateRuntimeSource makes the publish pointer fail closed before it can
// become a DSH local-skill candidate. The checks mirror the node-side
// skill-local/Provisioner contract: a stable kebab-case name, an exact
// frontmatter name match, a description, and only boolean invocation flags.
// Drafts remain deliberately more permissive so an author can iterate before
// attempting a realm-admin runtime release.
func (v SkillVersion) ValidateRuntimeSource(name string) error {
	if !runtimeSkillName.MatchString(name) {
		return fmt.Errorf("runtime skill name %q must be kebab case", name)
	}
	if !strings.HasPrefix(v.Content, "---\n") {
		return fmt.Errorf("runtime skill %q lacks frontmatter", name)
	}
	closing := strings.Index(v.Content[4:], "\n---\n")
	if closing < 0 {
		return fmt.Errorf("runtime skill %q has unterminated frontmatter", name)
	}
	header := v.Content[4 : closing+4]
	fields := map[string]string{}
	for _, line := range strings.Split(header, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			fields[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), "\"'")
		}
	}
	if fields["name"] != name {
		return fmt.Errorf("runtime skill frontmatter name must match %q", name)
	}
	if strings.TrimSpace(fields["description"]) == "" {
		return fmt.Errorf("runtime skill %q requires a frontmatter description", name)
	}
	for _, key := range []string{"model_invocable", "user_invocable"} {
		if value, exists := fields[key]; exists && value != "true" && value != "false" {
			return fmt.Errorf("runtime skill %q has invalid %s", name, key)
		}
	}
	return nil
}

type SubjectType string

const (
	SubjectUser       SubjectType = "user"
	SubjectRole       SubjectType = "role"
	SubjectDepartment SubjectType = "department"
	SubjectProject    SubjectType = "project"
	SubjectAgent      SubjectType = "agent"
)

func (s SubjectType) Valid() bool {
	return s == SubjectUser || s == SubjectRole || s == SubjectDepartment || s == SubjectProject || s == SubjectAgent
}

type SkillGrant struct {
	ID                string      `json:"id"`
	Realm             string      `json:"realm"`
	SkillID           string      `json:"skill_id"`
	VersionConstraint string      `json:"version_constraint,omitempty"`
	SubjectType       SubjectType `json:"subject_type"`
	SubjectID         string      `json:"subject_id"`
	IncludeChildren   bool        `json:"include_children"`
	ExpiresAt         *time.Time  `json:"expires_at,omitempty"`
	GrantedBy         string      `json:"granted_by"`
}

type SkillRevocation struct {
	ID          string      `json:"id"`
	Realm       string      `json:"realm"`
	SkillID     string      `json:"skill_id"`
	SubjectType SubjectType `json:"subject_type"`
	SubjectID   string      `json:"subject_id"`
	Reason      string      `json:"reason"`
	ExpiresAt   *time.Time  `json:"expires_at,omitempty"`
	RevokedBy   string      `json:"revoked_by"`
}

// Candidate is a grant that has already been matched to a user context by the
// store. Priority encodes the documented precedence, while Source keeps the
// result explainable for the operator and UI.
type Candidate struct {
	Skill    Skill
	Version  string
	Source   string
	Priority int
}

type EffectiveSkill struct {
	SkillID    string    `json:"skill_id"`
	Name       string    `json:"name"`
	Kind       SkillKind `json:"kind"`
	Version    string    `json:"version"`
	Source     string    `json:"source"`
	Level      int       `json:"level,omitempty"`
	Confidence float64   `json:"confidence,omitempty"`
	Priority   int       `json:"-"`
}

const (
	PriorityInheritedDepartment = 10
	PriorityDepartment          = 20
	PriorityRole                = 30
	PriorityProject             = 40
	PriorityUser                = 50
	PriorityAgent               = 45
)

// ResolveEffectiveSkills applies the fail-closed version rule. Equal priority
// grants for the same skill must agree on an exact version; silently choosing
// the newest version would make authorization an upgrade side effect.
func ResolveEffectiveSkills(candidates []Candidate, revoked map[string]bool) ([]EffectiveSkill, error) {
	chosen := make(map[string]Candidate)
	for _, candidate := range candidates {
		if revoked[candidate.Skill.ID] {
			continue
		}
		if candidate.Version == "" {
			candidate.Version = candidate.Skill.CurrentVersion
		}
		current, ok := chosen[candidate.Skill.ID]
		if !ok || candidate.Priority > current.Priority {
			chosen[candidate.Skill.ID] = candidate
			continue
		}
		if candidate.Priority == current.Priority && candidate.Version != current.Version {
			return nil, fmt.Errorf("skill %s has conflicting versions %s and %s at priority %d", candidate.Skill.ID, current.Version, candidate.Version, candidate.Priority)
		}
	}

	out := make([]EffectiveSkill, 0, len(chosen))
	for _, candidate := range chosen {
		out = append(out, EffectiveSkill{
			SkillID: candidate.Skill.ID, Name: candidate.Skill.Name, Kind: candidate.Skill.Kind,
			Version: candidate.Version, Source: candidate.Source, Priority: candidate.Priority,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SkillID < out[j].SkillID })
	return out, nil
}

type DesktopNodeStatus string

const (
	NodePendingActivation DesktopNodeStatus = "PENDING_ACTIVATION"
	NodeOnline            DesktopNodeStatus = "ONLINE"
	NodeDraining          DesktopNodeStatus = "DRAINING"
	NodeOffline           DesktopNodeStatus = "OFFLINE"
	NodeRevoked           DesktopNodeStatus = "REVOKED"
)

type DesktopNode struct {
	ID                 string            `json:"id"`
	Realm              string            `json:"realm"`
	ClusterID          string            `json:"cluster_id"`
	OwnerUserID        string            `json:"owner_user_id"`
	DisplayName        string            `json:"display_name"`
	OS                 string            `json:"os"`
	Arch               string            `json:"arch"`
	ClientVersion      string            `json:"client_version"`
	Capacity           int               `json:"capacity"`
	Capabilities       []string          `json:"capabilities"`
	Residency          string            `json:"residency,omitempty"`
	Status             DesktopNodeStatus `json:"status"`
	SchedulingEligible bool              `json:"scheduling_eligible"`
	LastSeenAt         time.Time         `json:"last_seen_at"`
}
