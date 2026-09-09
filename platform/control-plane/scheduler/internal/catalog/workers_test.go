package catalog

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

type workerTransport func(*http.Request) (*http.Response, error)

func (f workerTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestWorkerDirectoryOnlyReturnsCurrentAuthorizedDevices(t *testing.T) {
	current := "device-a"
	directory := WorkerDirectory{URL: "https://governance.test", Token: "service-token", Client: &http.Client{
		Transport: workerTransport(func(r *http.Request) (*http.Response, error) {
			if r.Header.Get("Authorization") != "Bearer service-token" || r.Header.Get("X-Lumo-Realm") != "realm" || r.URL.Query().Get("project_id") != "project-a" {
				t.Fatalf("missing request scope: %#v", r)
			}
			body := fmt.Sprintf(`{"realm":"realm","worker_id":"user:employee","node_ids":[%q]}`, current)
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
		}),
	}}
	task := domain.Task{Realm: "realm", WorkerID: "user:employee", ProjectID: "project-a"}
	nodes := []domain.Node{{NodeID: "device-a", Realm: "realm"}, {NodeID: "device-b", Realm: "realm"}, {NodeID: "device-a", Realm: "other"}}
	for _, id := range []string{"device-a", "device-b"} {
		current = id
		filtered, err := directory.Filter(context.Background(), task, nodes)
		if err != nil || len(filtered) != 1 || filtered[0].NodeID != id || filtered[0].Realm != "realm" {
			t.Fatalf("device scope was cached or leaked: %#v, %v", filtered, err)
		}
	}
}

func TestWorkerDirectoryFailsClosed(t *testing.T) {
	task := domain.Task{Realm: "realm", WorkerID: "agent:analyst"}
	nodes := []domain.Node{{NodeID: "n", Realm: "realm"}}
	for _, body := range []string{
		`{"realm":"other","worker_id":"agent:analyst","node_ids":["n"]}`,
		`{"realm":"realm","worker_id":"agent:another","node_ids":["n"]}`,
		`{"realm":"realm","worker_id":"agent:analyst","node_ids":["n"]} {}`,
		strings.Repeat("x", (1<<20)+1),
	} {
		directory := WorkerDirectory{URL: "https://governance.test", Token: "token", Client: &http.Client{Transport: workerTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
		})}}
		if filtered, err := directory.Filter(context.Background(), task, nodes); err == nil || len(filtered) != 0 {
			t.Fatalf("invalid response allowed placement: %v", err)
		}
	}
	if _, err := (WorkerDirectory{}).Filter(context.Background(), task, nodes); err == nil {
		t.Fatal("missing governance configuration did not block governed placement")
	}
	if got, err := (WorkerDirectory{}).Filter(context.Background(), domain.Task{}, nodes); err != nil || len(got) != 1 {
		t.Fatal("infrastructure placement regressed")
	}
}

func TestWorkerDirectoryDoesNotFollowRedirects(t *testing.T) {
	calls := 0
	directory := WorkerDirectory{URL: "https://governance.test", Token: "token", Client: &http.Client{Transport: workerTransport(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: http.StatusTemporaryRedirect, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{"Location": {"https://elsewhere.test"}}}, nil
	})}}
	if _, err := directory.Filter(context.Background(), domain.Task{Realm: "realm", WorkerID: "agent:analyst"}, nil); err == nil || calls != 1 {
		t.Fatalf("redirect followed: calls=%d, err=%v", calls, err)
	}
}
