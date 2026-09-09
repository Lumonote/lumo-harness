package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// TaskResult is an execution receipt. Acceptance remains a separate decision
// by the requester, and a later attempt cannot overwrite an earlier receipt.
type TaskResult struct {
	TaskID     string          `json:"task_id"`
	RunID      string          `json:"run_id"`
	State      string          `json:"state"`
	SessionRef string          `json:"session_ref"`
	NodeID     string          `json:"node_id,omitempty"`
	Summary    string          `json:"summary"`
	Output     json.RawMessage `json:"output,omitempty"`
	CreatedAt  time.Time       `json:"created_at"`
}

func (r TaskResult) Validate() error {
	if r.TaskID == "" || r.RunID == "" || len(r.TaskID) > 160 || len(r.RunID) > 160 ||
		len(r.SessionRef) > 160 || len(r.NodeID) > 160 || len([]rune(r.Summary)) > 16000 {
		return fmt.Errorf("invalid result identity or summary size")
	}
	if r.State != DelegationCompleted && r.State != DelegationFailed && r.State != DelegationCancelled {
		return fmt.Errorf("result state must be COMPLETED, FAILED or CANCELLED")
	}
	if len(r.Output) > 1<<20 || (len(r.Output) > 0 && !json.Valid(r.Output)) {
		return fmt.Errorf("result output must be valid JSON of at most 1 MiB")
	}
	if r.State == DelegationCompleted && (strings.TrimSpace(r.SessionRef) == "" ||
		(strings.TrimSpace(r.Summary) == "" && (len(r.Output) == 0 || bytes.Equal(bytes.TrimSpace(r.Output), []byte("null"))))) {
		return fmt.Errorf("completed execution requires a session reference and a result")
	}
	return nil
}

type CollaborationSummary struct {
	Total          int `json:"total"`
	Active         int `json:"active"`
	AwaitingReview int `json:"awaiting_review"`
	Accepted       int `json:"accepted"`
	NeedsAttention int `json:"needs_attention"`
	Unresolved     int `json:"unresolved"`
}

type ChildTaskProgress struct {
	Task   DelegatedTask `json:"task"`
	Run    *TaskRun      `json:"run,omitempty"`
	Result *TaskResult   `json:"result,omitempty"`
}

type CollaborationProgress struct {
	Task     DelegatedTask        `json:"task"`
	Children []ChildTaskProgress  `json:"children"`
	Summary  CollaborationSummary `json:"summary"`
	HasMore  bool                 `json:"has_more"`
}
