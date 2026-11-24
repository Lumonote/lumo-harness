package control

import (
	"testing"

	"github.com/lumo-harness/platform/session-control/internal/state"
	"github.com/lumo-harness/platform/session-control/internal/store"
)

// P0-1：awaiting-approval 关联 Ask 的校验（纯函数，不需要 PG）。
func TestAskMismatch(t *testing.T) {
	waiting := store.Row{State: state.StateAwaitingApproval, AskID: "connector:a1"}
	cases := []struct {
		name string
		row  store.Row
		req  Request
		bad  bool
	}{
		{"same ask", waiting, Request{Command: state.CmdApprove, AskID: "connector:a1"}, false},
		{"other ask", waiting, Request{Command: state.CmdReject, AskID: "connector:b2"}, true},
		{"legacy row without ask", store.Row{State: state.StateAwaitingApproval}, Request{Command: state.CmdApprove, AskID: "connector:b2"}, false},
		{"command without ask", waiting, Request{Command: state.CmdApprove}, false},
		{"not approve/reject", waiting, Request{Command: state.CmdPause, AskID: "x"}, false},
		{"not awaiting", store.Row{State: state.StateRunning, AskID: "connector:a1"}, Request{Command: state.CmdApprove, AskID: "x"}, false},
	}
	for _, c := range cases {
		if got := askMismatch(c.row, c.req) != ""; got != c.bad {
			t.Errorf("%s: mismatch=%v want %v", c.name, got, c.bad)
		}
	}
}
