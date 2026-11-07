package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/server"
)

func TestNeverStartedStopReleasesOnlyItsExactAssignment(t *testing.T) {
	for _, raceNewAttempt := range []bool{false, true} {
		t.Run(fmt.Sprint(raceNewAttempt), func(t *testing.T) {
			st := newStore(t)
			ctx := context.Background()
			lease, err := st.Acquire(ctx, "leader", 60000)
			if err != nil {
				t.Fatal(err)
			}
			task := domain.Task{TaskID: "cancel", Realm: "r1", ClusterID: "c1"}
			executor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var stop struct {
					ChildID string `json:"childId"`
					Attempt int    `json:"attempt"`
					NodeID  string `json:"nodeId"`
				}
				if err := json.NewDecoder(r.Body).Decode(&stop); err != nil || stop.ChildID != task.TaskID || stop.Attempt != 1 || stop.NodeID != "N1" {
					t.Errorf("unbound stop: %+v %v", stop, err)
					w.WriteHeader(400)
					return
				}
				if raceNewAttempt {
					if _, err := st.CompleteTaskAttempt(ctx, task.TaskID, 1, domain.StateFailed); err != nil {
						t.Error(err)
						w.WriteHeader(500)
						return
					}
					if _, err := st.PlaceTask(ctx, lease, task, "N1"); err != nil {
						t.Error(err)
						w.WriteHeader(500)
						return
					}
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ok":true,"never_started":true}`))
			}))
			defer executor.Close()
			cat := &catalog.Pg{Pool: st.Pool()}
			if err := cat.Upsert(ctx, domain.Node{NodeID: "N1", Realm: "r1", ClusterID: "c1", Capacity: 1, ControlURL: executor.URL}); err != nil {
				t.Fatal(err)
			}
			if _, err := st.PlaceTask(ctx, lease, task, "N1"); err != nil {
				t.Fatal(err)
			}
			api := httptest.NewServer(server.New(st, &election.State{}, cat, discardLogger()).Routes())
			defer api.Close()
			req, _ := http.NewRequest("POST", api.URL+"/v1/tasks/cancel/cancel", strings.NewReader(`{"attempt":1,"node_id":"N1"}`))
			req.Header.Set("X-Lumo-Realm", "r1")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != 200 {
				t.Fatalf("stop status: %d", res.StatusCode)
			}
			p, err := st.GetPlacement(ctx, task.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			if raceNewAttempt {
				if p.Attempt != 2 || p.State != domain.StatePlaced {
					t.Fatalf("stale stop settled newer attempt: %+v", p)
				}
			} else {
				if p.State != domain.StateAborted {
					t.Fatalf("unstarted task leaked slot: %+v", p)
				}
				counts, err := st.ActiveCounts(ctx)
				if err != nil || counts["N1"] != 0 {
					t.Fatalf("slot not released: %v %v", counts, err)
				}
				if n := rowCount(t, st, `SELECT count(*) FROM scheduler_dispatch_outbox WHERE task_id='cancel' AND delivered_at IS NULL`); n != 0 {
					t.Fatal("unstarted dispatch remains live")
				}
				var status string
				if err := st.Pool().QueryRow(ctx, `SELECT status FROM scheduler_control_commands WHERE task_id='cancel'`).Scan(&status); err != nil || status != "ACKNOWLEDGED" {
					t.Fatalf("stop receipt not durable: %s %v", status, err)
				}
			}
		})
	}
}
