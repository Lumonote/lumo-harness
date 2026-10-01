package heartbeat

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNacosLivenessUsesHealthyNodeIDsAndContinuousAbsence(t *testing.T) {
	now := time.Now()
	body := `{"hosts":[{"healthy":true,"enabled":false,"metadata":{"node_id":"node-a"}}]}`
	status := http.StatusOK
	candidates := []string{"node-a", "node-b", "node-b"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/nacos/v1/ns/instance/list" || r.URL.Query().Get("serviceName") != "lumo-dsh-node" ||
			r.URL.Query().Get("healthyOnly") != "false" || r.URL.Query().Get("namespaceId") != "test-ns" {
			t.Errorf("unexpected Nacos query: %s", r.URL)
		}
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	defer server.Close()
	source, err := NewNacosLiveness(NacosLivenessOptions{
		BaseURL: server.URL, Namespace: "test-ns", Now: func() time.Time { return now },
		Candidates: func(context.Context) ([]string, error) { return candidates, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	sink := &recordingSink{}
	reporter, _ := NewNodeLossReporter(NodeLossReporterOptions{Sink: sink})
	read := func() []NodeObservation {
		t.Helper()
		rows, err := source.ReadNodes(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 2 || rows[0].NodeID != "node-a" || rows[0].Age != 0 {
			t.Fatalf("healthy disabled node and candidate dedup: %+v", rows)
		}
		return rows
	}
	if got := reporter.ReportLiveness(context.Background(), read()); len(got.Down) != 0 {
		t.Fatal("startup absence must receive a full grace period")
	}
	now = now.Add(30 * time.Second)
	if got := reporter.ReportLiveness(context.Background(), read()); len(got.Reported) != 0 {
		t.Fatal("suspect node must keep its existing threads")
	}
	// Failed reads invalidate the observed absence interval, including its gap.
	status = http.StatusServiceUnavailable
	if _, err := source.ReadNodes(context.Background()); err == nil {
		t.Fatal("registry outage must be an error, not an empty node list")
	}
	now = now.Add(2 * time.Minute)
	status = http.StatusOK
	if rows := read(); rows[1].Age != 0 {
		t.Fatalf("outage counted as absence: %+v", rows)
	}
	now = now.Add(89 * time.Second)
	if got := reporter.ReportLiveness(context.Background(), read()); len(got.Reported) != 0 {
		t.Fatal("down threshold reached early")
	}
	now = now.Add(time.Second)
	if got := reporter.ReportLiveness(context.Background(), read()); len(got.Reported) != 1 || got.Reported[0] != "node-b" {
		t.Fatalf("continuous absent candidate must be reported: %+v", got)
	}
	if got := reporter.ReportLiveness(context.Background(), read()); len(got.Reported) != 0 {
		t.Fatal("duplicate down report")
	}
	body = `{"hosts":[{"healthy":true,"metadata":{"node_id":"node-a"}},{"healthy":true,"metadata":{"node_id":"node-b"}}]}`
	if got := reporter.ReportLiveness(context.Background(), read()); len(got.Recovered) != 1 {
		t.Fatalf("recovery must reset both timers and report dedup: %+v", got)
	}
	candidates = nil
	if rows, err := source.ReadNodes(context.Background()); err != nil || len(rows) != 0 || len(source.missing) != 0 {
		t.Fatalf("retired nodes must be forgotten: %+v, %v", rows, err)
	}
}

func TestNacosLivenessRejectsIncompleteSnapshots(t *testing.T) {
	for _, body := range []string{
		`{}`, `{"hosts":null}`, `{"hosts":"bad"}`, `{"hosts":[]}garbage`,
		`{"hosts":[],"code":500} {}`, `{"hosts":[{"healthy":true,"metadata":{}}]}`,
		`{"hosts":[{"metadata":{"node_id":"node-a"}}]}`,
	} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, body) }))
			defer server.Close()
			source, _ := NewNacosLiveness(NacosLivenessOptions{
				BaseURL: server.URL, Candidates: func(context.Context) ([]string, error) { return []string{"node-a"}, nil },
			})
			source.missing["node-a"] = time.Now().Add(-time.Hour)
			if _, err := source.ReadNodes(context.Background()); err == nil || len(source.missing) != 0 {
				t.Fatalf("incomplete snapshot must reset absence and fail: %v", err)
			}
		})
	}
}

func TestNacosLivenessCandidateFailureResetsTimers(t *testing.T) {
	source, err := NewNacosLiveness(NacosLivenessOptions{
		BaseURL: "http://localhost:8848", Candidates: func(context.Context) ([]string, error) { return nil, fmt.Errorf("database unavailable") },
	})
	if err != nil {
		t.Fatal(err)
	}
	source.missing["node-a"] = time.Now().Add(-time.Hour)
	if _, err := source.ReadNodes(context.Background()); err == nil || len(source.missing) != 0 {
		t.Fatalf("candidate read failure must reset timers: %v", err)
	}
}
