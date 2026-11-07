package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/session-control/internal/store"
)

type executionFake struct {
	ownerFake
	seen store.ExecutionNodeRequest
}

func (f *executionFake) AcquireExecutionNode(_ context.Context, in store.ExecutionNodeRequest) (store.ExecutionNode, error) {
	f.seen = in
	return store.ExecutionNode{Realm: in.Realm, NodeID: in.NodeID, ProjectID: in.ProjectID, ProcessID: in.ProcessID, Endpoint: in.Endpoint, Fence: 1}, nil
}
func (f *executionFake) RenewExecutionNode(ctx context.Context, in store.ExecutionNodeRequest, _ bool) (store.ExecutionNode, error) {
	return f.AcquireExecutionNode(ctx, in)
}
func (f *executionFake) ExecutionNode(context.Context, string, string, string) (store.ExecutionNode, error) {
	return store.ExecutionNode{}, store.ErrExecutionFenced
}
func (f *executionFake) SessionExecutionLease(context.Context, string, store.ExecutionLeaseRequest, string) (store.ExecutionLease, error) {
	return store.ExecutionLease{}, store.ErrExecutionFenced
}
func TestExecutionRoutesBoundIdentityAndDoNotExposeProcessSecrets(t *testing.T) {
	previous := observability.Default
	observability.Default = &observability.Metrics{}
	t.Cleanup(func() { observability.Default = previous })
	f := &executionFake{}
	mux := http.NewServeMux()
	New(Options{Owners: f}).Routes(mux)
	initial := httptest.NewRecorder()
	observability.Default.Write(initial)
	for _, operation := range []string{"session_execution_node", "session_execution_lease", "session_attachment"} {
		if !strings.Contains(initial.Body.String(), `lumo_business_requests_total{operation="`+operation+`",outcome="fenced"} 0`) {
			t.Fatalf("startup did not publish the initial business baseline: %s", initial.Body)
		}
	}
	call := func(method, path, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		return w
	}
	valid := `{"realm":"r","node_id":"n","project_id":"p","process_id":"process","endpoint":"https://node.example","token":"` + strings.Repeat("a", 64) + `"}`
	w := call("POST", "/v1/session-execution/nodes/n/acquire", valid)
	if w.Code != 200 || strings.Contains(w.Body.String(), "token") || strings.Contains(w.Body.String(), strings.Repeat("a", 64)) {
		t.Fatalf("response %d %s", w.Code, w.Body)
	}
	for _, body := range []string{strings.Replace(valid, `"node_id":"n"`, `"node_id":"foreign"`, 1), strings.TrimSuffix(valid, "}") + `,"owner_user_id":"forged"}`, valid + ` {}`} {
		if w = call("POST", "/v1/session-execution/nodes/n/acquire", body); w.Code != 400 {
			t.Fatalf("invalid envelope %d %s", w.Code, w.Body)
		}
	}
	if w = call("GET", "/v1/session-execution/nodes/n?realm=r&project_id=p", ""); w.Code != 409 {
		t.Fatalf("missing route %d %s", w.Code, w.Body)
	}
	if w = call("POST", "/v1/session-execution/sessions/managed/renew", valid); w.Code != 409 {
		t.Fatalf("fenced response %d %s", w.Code, w.Body)
	}
	if w = call("PUT", "/v1/session-execution/nodes/n/acquire", valid); w.Code != 405 {
		t.Fatalf("unsupported write %d", w.Code)
	}
	metrics := httptest.NewRecorder()
	observability.Default.Write(metrics)
	for _, want := range []string{
		`lumo_business_requests_total{operation="session_execution_node",outcome="success"} 1`,
		`lumo_business_requests_total{operation="session_execution_node",outcome="invalid"} 3`,
		`lumo_business_requests_total{operation="session_execution_node",outcome="fenced"} 1`,
		`lumo_business_requests_total{operation="session_execution_lease",outcome="fenced"} 1`,
	} {
		if !strings.Contains(metrics.Body.String(), want) {
			t.Fatalf("missing actual handler metric %q: %s", want, metrics.Body)
		}
	}
}

func TestSessionBusinessErrorsStayInClosedOutcomes(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want observability.BusinessOutcome
	}{
		{nil, observability.BusinessSuccess},
		{errors.Join(errors.New("private-session"), store.ErrExecutionFenced), observability.BusinessFenced},
		{store.ErrOwnerInvalid, observability.BusinessInvalid},
		{store.ErrOwnerConflict, observability.BusinessConflict},
		{store.ErrNotFound, observability.BusinessNotFound},
		{errors.New("db-private-realm"), observability.BusinessUnavailable},
	} {
		if got := sessionBusinessOutcome(tc.err); got != tc.want {
			t.Fatalf("%v: got %s want %s", tc.err, got, tc.want)
		}
	}
}
