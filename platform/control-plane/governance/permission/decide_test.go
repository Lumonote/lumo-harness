package permission

import (
	"context"
	"errors"
	"testing"
)

func TestDecide(t *testing.T) {
	base := Input{Realm: "r", Principal: Principal{"user", "u"}, Resource: Resource{"r", "dual-tool", "project/project_context", "p"}, Action: ProjectRead, Risk: "low", Approval: "never"}
	for _, tc := range []struct {
		name             string
		mutate           func(*Input)
		allow, consulted bool
		want             string
	}{
		{"allow", nil, true, true, "allow"},
		{"always ask", func(i *Input) { i.Approval = "always" }, true, true, "ask"},
		{"high auto", func(i *Input) { i.Risk = "high"; i.Approval = "auto" }, true, true, "ask"},
		{"deny before ask", func(i *Input) { i.Approval = "always" }, false, true, "deny"},
		{"cross realm", func(i *Input) { i.Resource.Realm = "other" }, true, false, "deny"},
		{"other user", func(i *Input) { i.Principal.ID = "other" }, true, false, "deny"},
		{"unregistered", func(i *Input) { i.Resource.ID = "unknown/tool" }, true, false, "deny"},
		{"action mismatch", func(i *Input) { i.Action = EngineList }, true, false, "deny"},
		{"no project", func(i *Input) { i.Resource.ProjectID = "" }, true, false, "deny"},
		{"invalid risk", func(i *Input) { i.Risk = "" }, true, false, "deny"},
		{"invalid approval", func(i *Input) { i.Approval = "skip" }, true, false, "deny"},
		{"high never", func(i *Input) { i.Risk = "high" }, true, false, "deny"},
		{"invalid agent", func(i *Input) { i.Actor = &Actor{Kind: "agent"} }, true, false, "deny"},
		{"depth limit", func(i *Input) { i.Actor = &Actor{Kind: "agent", AgentID: "a", Depth: 4} }, true, false, "deny"},
		{"engine list", func(i *Input) {
			i.Resource.ID = "acp-engines/acp_engines_list"
			i.Resource.ProjectID = ""
			i.Action = EngineList
		}, true, true, "allow"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := base
			if tc.mutate != nil {
				tc.mutate(&in)
			}
			called := false
			d, err := Decide(context.Background(), "r", "u", in, func(context.Context, Input) (bool, []string, error) { called = true; return tc.allow, nil, nil })
			if err != nil || d.Effect != tc.want || called != tc.consulted || d.Matched == nil {
				t.Fatalf("decision=%+v called=%v err=%v", d, called, err)
			}
		})
	}
	for _, auth := range []Authorize{nil, func(context.Context, Input) (bool, []string, error) { return true, nil, errors.New("unavailable") }} {
		d, err := Decide(context.Background(), "r", "u", base, auth)
		if d.Effect != "deny" || d.ReasonCode != "policy_unavailable" || err == nil {
			t.Fatalf("unavailable: %+v %v", d, err)
		}
	}
}
