package domain

import (
	"fmt"
	"strings"
	"time"
	"unicode"
)

// TaskProgress is an attributed checkpoint, not an execution receipt or an
// acceptance decision. Reaching 100 percent never changes either state machine.
type TaskProgress struct {
	TaskID        string     `json:"task_id"`
	RunID         string     `json:"run_id"`
	Revision      int64      `json:"revision"`
	Status        string     `json:"status"`
	Percent       int        `json:"percent"`
	Summary       string     `json:"summary"`
	NextStep      string     `json:"next_step"`
	BlockedReason string     `json:"blocked_reason,omitempty"`
	DueAt         *time.Time `json:"due_at,omitempty"`
	UpdatedBy     string     `json:"updated_by"`
	Source        string     `json:"source"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

type TaskProgressUpdate struct {
	RunID            string     `json:"run_id"`
	ExpectedRevision int64      `json:"expected_revision"`
	Status           string     `json:"status"`
	Percent          int        `json:"percent"`
	Summary          string     `json:"summary"`
	NextStep         string     `json:"next_step"`
	BlockedReason    string     `json:"blocked_reason,omitempty"`
	DueAt            *time.Time `json:"due_at,omitempty"`
}

func (p *TaskProgressUpdate) Normalize() {
	p.RunID = strings.TrimSpace(p.RunID)
	p.Status = strings.TrimSpace(p.Status)
	p.Summary = strings.TrimSpace(p.Summary)
	p.NextStep = strings.TrimSpace(p.NextStep)
	p.BlockedReason = strings.TrimSpace(p.BlockedReason)
	if p.DueAt != nil {
		v := p.DueAt.UTC()
		p.DueAt = &v
	}
}

func (p TaskProgressUpdate) Validate() error {
	if p.RunID == "" || len(p.RunID) > 160 || p.ExpectedRevision < 0 || p.Percent < 0 || p.Percent > 100 {
		return fmt.Errorf("a current run, non-negative revision and percent between 0 and 100 are required")
	}
	if p.Status != "on_track" && p.Status != "at_risk" && p.Status != "blocked" {
		return fmt.Errorf("status must be on_track, at_risk or blocked")
	}
	if p.Summary == "" || p.NextStep == "" || len([]rune(p.Summary)) > 4000 || len([]rune(p.NextStep)) > 2000 || len([]rune(p.BlockedReason)) > 2000 {
		return fmt.Errorf("summary and next_step are required and must respect their length limits")
	}
	if (p.Status == "blocked") != (p.BlockedReason != "") {
		return fmt.Errorf("blocked_reason must be set exactly when status is blocked")
	}
	if p.DueAt != nil && (p.DueAt.IsZero() || p.DueAt.Year() < 2000 || p.DueAt.Year() > 9999) {
		return fmt.Errorf("due_at must be a valid timestamp between years 2000 and 9999")
	}
	return nil
}

func TaskProgressWritable(task DelegatedTask, run TaskRun) bool {
	return task.BusinessState != BusinessDone && task.BusinessState != BusinessArchived &&
		(task.State == DelegationAssigned || task.State == DelegationQueued || task.State == DelegationRunning) &&
		(run.State == DelegationAssigned || run.State == DelegationQueued || run.State == DelegationRunning)
}

type TaskProgressView struct {
	CurrentRunID string         `json:"current_run_id"`
	Revision     int64          `json:"revision"`
	Progress     *TaskProgress  `json:"progress"`
	History      []TaskProgress `json:"history"`
	CanUpdate    bool           `json:"can_update"`
}

type TaskProgressHealth struct {
	Blocked        bool `json:"blocked"`
	Overdue        bool `json:"overdue"`
	Stale          bool `json:"stale"`
	AwaitingReview bool `json:"awaiting_review"`
}

type WorkforceProgressItem struct {
	Task     DelegatedTask      `json:"task"`
	Run      *TaskRun           `json:"run,omitempty"`
	Progress *TaskProgress      `json:"progress,omitempty"`
	Health   TaskProgressHealth `json:"health"`
}

type WorkforceProgressSummary struct {
	Total          int `json:"total"`
	Active         int `json:"active"`
	Blocked        int `json:"blocked"`
	Overdue        int `json:"overdue"`
	Stale          int `json:"stale"`
	AwaitingReview int `json:"awaiting_review"`
	Accepted       int `json:"accepted"`
	AtRisk         int `json:"at_risk"`
}

// Search and risk predicates apply to the complete authorized scope before
// pagination. Checkpoints describe progress, never business acceptance.
type WorkforceProgressFilter struct {
	Query      string `json:"q"`
	Risk       string `json:"risk"`
	WorkerKind string `json:"worker_kind"`
}

func (f *WorkforceProgressFilter) Normalize() {
	f.Query = strings.ToLower(strings.TrimSpace(f.Query))
	if f.Risk == "" {
		f.Risk = "all"
	}
	if f.WorkerKind == "" {
		f.WorkerKind = "all"
	}
}

func (f WorkforceProgressFilter) Validate() error {
	if len([]rune(f.Query)) > 200 || strings.IndexFunc(f.Query, unicode.IsControl) >= 0 {
		return fmt.Errorf("q must be at most 200 characters without control characters")
	}
	switch f.Risk {
	case "all", "blocked", "overdue", "stale", "awaiting_review", "at_risk", "active", "accepted":
	default:
		return fmt.Errorf("unknown workforce risk filter")
	}
	switch f.WorkerKind {
	case "all", "employee", "agent", "unassigned":
	default:
		return fmt.Errorf("unknown workforce worker_kind")
	}
	return nil
}

func WorkforceWorkerKind(task DelegatedTask) string {
	if strings.HasPrefix(task.AssigneeWorkerID, "agent:") {
		return "agent"
	}
	if task.AssigneeUserID != "" || strings.HasPrefix(task.AssigneeWorkerID, "user:") {
		return "employee"
	}
	return "unassigned"
}

func (f WorkforceProgressFilter) Matches(item WorkforceProgressItem) bool {
	if f.WorkerKind != "all" && WorkforceWorkerKind(item.Task) != f.WorkerKind {
		return false
	}
	match := true
	switch f.Risk {
	case "blocked":
		match = item.Health.Blocked
	case "overdue":
		match = item.Health.Overdue
	case "stale":
		match = item.Health.Stale
	case "awaiting_review":
		match = item.Health.AwaitingReview
	case "at_risk":
		match = item.Task.BusinessState != BusinessDone && item.Task.BusinessState != BusinessArchived && item.Progress != nil && item.Progress.Status == "at_risk"
	case "active":
		match = DelegationStateActive(item.Task.State)
	case "accepted":
		match = item.Task.BusinessState == BusinessDone
	}
	if !match {
		return false
	}
	search := []string{item.Task.ID, item.Task.Title, item.Task.AssigneeName, item.Task.AssigneeUserID, item.Task.AssigneeWorkerID}
	if item.Progress != nil {
		search = append(search, item.Progress.Summary, item.Progress.NextStep, item.Progress.BlockedReason)
	}
	return f.Query == "" || strings.Contains(strings.ToLower(strings.Join(search, "\n")), f.Query)
}

func ProgressHealth(task DelegatedTask, run *TaskRun, progress *TaskProgress, now time.Time) TaskProgressHealth {
	h := TaskProgressHealth{AwaitingReview: task.BusinessState == BusinessVerifying || task.BusinessState == BusinessInReview}
	if task.BusinessState == BusinessDone || task.BusinessState == BusinessArchived {
		return h
	}
	// Never reuse an earlier attempt's percentage, blocker or deadline.
	if progress != nil && (run == nil || progress.RunID != run.ID) {
		progress = nil
	}
	h.Blocked = task.State == DelegationBlocked
	updated := task.CreatedAt
	if run != nil {
		updated = run.CreatedAt
	}
	if progress != nil {
		h.Blocked = h.Blocked || progress.Status == "blocked"
		h.Overdue = progress.DueAt != nil && progress.DueAt.Before(now)
		updated = progress.UpdatedAt
	}
	h.Stale = DelegationStateActive(task.State) && !updated.IsZero() && now.Sub(updated) >= 24*time.Hour
	return h
}

func SummarizeWorkforce(items []WorkforceProgressItem) WorkforceProgressSummary {
	out := WorkforceProgressSummary{Total: len(items)}
	for _, item := range items {
		if DelegationStateActive(item.Task.State) {
			out.Active++
		}
		if item.Health.Blocked {
			out.Blocked++
		}
		if item.Health.Overdue {
			out.Overdue++
		}
		if item.Health.Stale {
			out.Stale++
		}
		if item.Health.AwaitingReview {
			out.AwaitingReview++
		}
		if item.Task.BusinessState == BusinessDone {
			out.Accepted++
		}
		if item.Task.BusinessState != BusinessDone && item.Task.BusinessState != BusinessArchived && item.Progress != nil && item.Progress.Status == "at_risk" {
			out.AtRisk++
		}
	}
	return out
}
