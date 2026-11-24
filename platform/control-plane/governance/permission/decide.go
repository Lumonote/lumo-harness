// Package permission decides dual-plugin tool calls without executing them.
package permission

import (
	"context"
	"errors"
	"strings"
)

type Principal struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type Actor struct {
	Kind    string `json:"kind"`
	AgentID string `json:"agent_id"`
	RunID   string `json:"run_id,omitempty"`
	Depth   int    `json:"depth,omitempty"`
}

type Resource struct {
	Realm     string `json:"realm"`
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	ProjectID string `json:"project_id,omitempty"`
}

type Input struct {
	Realm      string    `json:"realm"`
	Principal  Principal `json:"principal"`
	Actor      *Actor    `json:"actor,omitempty"`
	SessionRef string    `json:"session_ref,omitempty"`
	Action     string    `json:"action"`
	Resource   Resource  `json:"resource"`
	Risk       string    `json:"risk"`
	Approval   string    `json:"approval"`
}

type Decision struct {
	Effect     string   `json:"effect"`
	ReasonCode string   `json:"reason_code"`
	Reason     string   `json:"reason"`
	Matched    []string `json:"matched"`
}

const (
	ProjectRead = "project:read"
	EngineList  = "agent:engine:list"
)

// Authorize must consult current trusted facts, never request-supplied grants.
type Authorize func(context.Context, Input) (allowed bool, matched []string, err error)

func deny(code, reason string) Decision { return Decision{"deny", code, reason, []string{}} }

// Decide compares the wire subject with the authenticated service assertions.
// An error always accompanies a deny and must not be cached as a grant.
func Decide(ctx context.Context, realm, user string, in Input, authorize Authorize) (Decision, error) {
	if realm == "" || in.Realm != realm || in.Resource.Realm != realm {
		return deny("realm_mismatch", "realm does not match the caller"), nil
	}
	if strings.TrimSpace(user) == "" || in.Principal.Kind != "user" || in.Principal.ID != user {
		return deny("subject_incomplete", "principal does not match the caller"), nil
	}
	if a := in.Actor; a != nil {
		if a.Kind != "agent" || strings.TrimSpace(a.AgentID) == "" {
			return deny("subject_incomplete", "invalid agent identity"), nil
		}
		if a.Depth < 0 || a.Depth > 3 {
			return deny("delegation_too_deep", "invalid delegation depth"), nil
		}
	}
	if in.Resource.Kind != "dual-tool" || !((in.Resource.ID == "project/project_context" && in.Action == ProjectRead) || (in.Resource.ID == "acp-engines/acp_engines_list" && in.Action == EngineList)) {
		return deny("unknown_tool_action", "tool and action are not registered together"), nil
	}
	if strings.TrimSpace(in.Resource.ProjectID) != in.Resource.ProjectID || (in.Action == ProjectRead && in.Resource.ProjectID == "") {
		return deny("project_scope", "a valid project scope is required"), nil
	}
	if (in.Risk != "low" && in.Risk != "medium" && in.Risk != "high") || (in.Approval != "never" && in.Approval != "auto" && in.Approval != "always") || (in.Risk == "high" && in.Approval == "never") {
		return deny("invalid_policy", "invalid risk or approval policy"), nil
	}
	if authorize == nil {
		return deny("policy_unavailable", "no authorization source"), errors.New("no authorization source")
	}
	allowed, matched, err := authorize(ctx, in)
	if err != nil {
		return deny("policy_unavailable", "could not verify current authorization"), err
	}
	if matched == nil {
		matched = []string{}
	}
	if !allowed {
		return Decision{"deny", "access_denied", "current policy does not grant this tool", matched}, nil
	}
	if in.Approval == "always" || in.Risk == "high" {
		return Decision{"ask", "approval_required", "confirmation required", append(matched, "manifest:approval")}, nil
	}
	return Decision{"allow", "authorized", "tool access granted", matched}, nil
}
