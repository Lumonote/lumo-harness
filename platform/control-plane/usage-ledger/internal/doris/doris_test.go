package doris

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type transport func(*http.Request) (*http.Response, error)

func (t transport) RoundTrip(r *http.Request) (*http.Response, error) { return t(r) }

func TestLoadAndAggregateUseDorisContracts(t *testing.T) {
	var paths []string
	client := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.URL.Path)
		if r.URL.Path == "/api/query" {
			return response(`{"data":[{"day":"2026-08-27","user_id":"u1","project_id":"p1","cost_type":"llm.tokens","qty":2,"cost_usd":0.1,"tokens":20}]}`), nil
		}
		return response(`{"Status":"Success"}`), nil
	})}
	c := New(Config{BaseURL: "http://doris", Client: client})
	if err := c.EnsureTable(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := c.Load(context.Background(), []Row{{Ts: time.Now(), UserID: "u1", ProjectID: "p1", CostType: "llm.tokens", Qty: 2}}); err != nil {
		t.Fatal(err)
	}
	rows, err := c.Aggregate(context.Background(), time.Now().Add(-time.Hour), time.Now(), "p1")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ProjectID != "p1" {
		t.Fatalf("rows = %+v", rows)
	}
	if len(paths) != 3 || paths[0] != "/api/query" || paths[1] != "/api/lumo/usage_cube_daily/_stream_load" || paths[2] != "/api/query" {
		t.Fatalf("paths = %v", paths)
	}
}

func response(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}
