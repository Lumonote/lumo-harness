package store

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func remoteComputerTestStore(t *testing.T) (*Store, RemoteComputerAuthority) {
	t.Helper()
	s := progressTestStore(t)
	ctx := context.Background()
	_, err := s.pool.Exec(ctx, `CREATE TABLE projects(id TEXT PRIMARY KEY,realm TEXT NOT NULL,status TEXT NOT NULL);CREATE TABLE project_members(project_id TEXT,user_id TEXT,PRIMARY KEY(project_id,user_id));
 INSERT INTO projects VALUES('project','realm','active');INSERT INTO project_members VALUES('project','manager'),('project','employee');
 INSERT INTO governance_agent_presets(realm,id,project_id,name,owner_user_id,provider,model_ref,max_concurrency)VALUES('realm','agent','project','Remote Agent','manager','fixture','fixture',1);
 INSERT INTO governance_desktop_nodes(realm,id,cluster_id,owner_user_id,display_name,os,arch,client_version,capacity,status)VALUES('realm','device','cluster','manager','Fixture desktop','darwin','arm64','1.2.1',1,'ONLINE');
 INSERT INTO governance_device_connections(realm,node_id,revision,applied_revision,connection_id,connection_expires,certificate_expires)VALUES('realm','device',1,1,'connection',now()+interval '5 minutes',now()+interval '1 hour')`)
	if err != nil {
		t.Fatal(err)
	}
	subject, err := s.UpsertBotSubject(ctx, BotSubject{Realm: "realm", Channel: "channel", Subject: "subject", UserID: "employee", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	grant, err := s.UpsertBotGrant(ctx, BotGrant{BotSubject: subject, TeamID: "team", Captain: "captain", TeamRevision: "team-v1", TeamOwner: "manager", ProjectID: "project", AgentID: "agent", Capability: "computer-use.request", SubjectUserID: "employee", SubjectRevision: subject.Revision, PresetRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	return s, RemoteComputerAuthority{Channel: "channel", Subject: "subject", Sender: "employee", BindingRevision: subject.Revision, GrantRevision: grant.Revision, FlowID: "flow", FlowVersion: 1, FlowNode: "node", Author: "manager", ProjectID: "project", TeamID: "team", Captain: "captain", AgentID: "agent", TeamOwner: "manager", TeamRevision: "team-v1", PresetRevision: 1}
}
func TestRemoteComputerApprovalCASCurrentGrantAndImmutableReceipts(t *testing.T) {
	s, a := remoteComputerTestStore(t)
	ctx := context.Background()
	r, err := s.CreateRemoteComputerRequest(ctx, "realm", "device", "run-node", a, "session", "computer.observe", "Observe fixture", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	same, err := s.CreateRemoteComputerRequest(ctx, "realm", "device", "run-node", a, "session", "computer.observe", "Observe fixture", time.Minute)
	if err != nil || same.RequestID != r.RequestID {
		t.Fatalf("idempotency: %+v %v", same, err)
	}
	if _, err = s.CreateRemoteComputerRequest(ctx, "realm", "device", "other-key", a, "session", "computer.observe", "Observe fixture", time.Minute); !errors.Is(err, ErrConflict) {
		t.Fatalf("parallel request: %v", err)
	}
	var winners atomic.Int32
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := s.RemoteComputerLease(ctx, "realm", "device", "connection", r.RequestID, RemoteComputerLeaseInput{Digest: r.Digest, ExpectedRevision: 1, Phase: "approve"})
			if e == nil {
				winners.Add(1)
			} else if !errors.Is(e, ErrConflict) {
				t.Errorf("approval: %v", e)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("approval winners=%d", winners.Load())
	}
	if _, err = s.pool.Exec(ctx, `UPDATE governance_bot_grants SET status='revoked',revision=revision+1 WHERE capability='computer-use.request'`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.RemoteComputerLease(ctx, "realm", "device", "connection", r.RequestID, RemoteComputerLeaseInput{Digest: r.Digest, ExpectedRevision: 2, Phase: "check"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("revoked Bot still controls: %v", err)
	}
	finished, err := s.RemoteComputerLease(ctx, "realm", "device", "connection", r.RequestID, RemoteComputerLeaseInput{Digest: r.Digest, ExpectedRevision: 2, Phase: "finish", State: "cancelled", Summary: "Confirmed local stop"})
	if err != nil || finished.State != "cancelled" {
		t.Fatalf("finish: %+v %v", finished, err)
	}
	if _, err = s.RemoteComputerLease(ctx, "realm", "device", "connection", r.RequestID, RemoteComputerLeaseInput{Digest: r.Digest, ExpectedRevision: 3, Phase: "finish", State: "completed"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("terminal replay: %v", err)
	}
	var receipts int
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_remote_computer_receipts WHERE request_id=$1`, r.RequestID).Scan(&receipts); err != nil || receipts != 2 {
		t.Fatalf("receipts=%d %v", receipts, err)
	}
}
func TestRemoteComputerRechecksProjectOwnerRoleAndConnection(t *testing.T) {
	for _, change := range []string{"DELETE FROM project_members WHERE user_id='employee'", "UPDATE governance_users SET status='disabled' WHERE id='manager'", "UPDATE governance_role_permissions SET effect='deny' WHERE action='task:delegate'", "UPDATE governance_device_connections SET connection_id='new-connection'", "UPDATE governance_desktop_nodes SET owner_user_id='employee'"} {
		t.Run(change, func(t *testing.T) {
			s, a := remoteComputerTestStore(t)
			ctx := context.Background()
			r, err := s.CreateRemoteComputerRequest(ctx, "realm", "device", "run", a, "session", "computer.interact", "Interact with fixture", time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.pool.Exec(ctx, change); err != nil {
				t.Fatal(err)
			}
			if _, err = s.RemoteComputerLease(ctx, "realm", "device", "connection", r.RequestID, RemoteComputerLeaseInput{Digest: r.Digest, ExpectedRevision: 1, Phase: "approve"}); err == nil {
				t.Fatal("stale authority approved")
			}
		})
	}
}
func TestRemoteComputerConnectionLossIsUnknownAndNeverReplayed(t *testing.T) {
	s, a := remoteComputerTestStore(t)
	ctx := context.Background()
	r, err := s.CreateRemoteComputerRequest(ctx, "realm", "device", "run", a, "session", "computer.observe", "Observe fixture", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE governance_device_connections SET connection_id='new-connection'`); err != nil {
		t.Fatal(err)
	}
	current, err := s.RemoteComputerRequest(ctx, "realm", r.RequestID)
	if err != nil || current.State != "unknown" {
		t.Fatalf("current=%+v %v", current, err)
	}
	same, err := s.CreateRemoteComputerRequest(ctx, "realm", "device", "run", a, "session", "computer.observe", "Observe fixture", time.Minute)
	if err != nil || same.RequestID != r.RequestID || same.State != "unknown" {
		t.Fatalf("replay=%+v %v", same, err)
	}
	var commands int
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_device_commands WHERE action='computer_use_request'`).Scan(&commands); err != nil || commands != 1 {
		t.Fatalf("replayed %d commands: %v", commands, err)
	}
}

func TestRemoteComputerRejectsDeadlinesExpiredDuringAuthorityLockWait(t *testing.T) {
	for _, phase := range []string{"create", "approve", "check"} {
		for _, deadline := range []string{"request", "connection", "certificate"} {
			if phase == "create" && deadline == "request" {
				continue
			}
			t.Run(phase+"/"+deadline, func(t *testing.T) {
				s, a := remoteComputerTestStore(t)
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				var request RemoteComputerRequest
				var err error
				if phase != "create" {
					request, err = s.CreateRemoteComputerRequest(ctx, "realm", "device", "run", a, "session", "computer.observe", "Observe fixture", time.Minute)
					if err != nil {
						t.Fatal(err)
					}
					if phase == "check" {
						request, err = s.RemoteComputerLease(ctx, "realm", "device", "connection", request.RequestID, RemoteComputerLeaseInput{Digest: request.Digest, ExpectedRevision: request.Revision, Phase: "approve"})
						if err != nil {
							t.Fatal(err)
						}
					}
				}
				var expires time.Time
				switch deadline {
				case "request":
					err = s.pool.QueryRow(ctx, `UPDATE governance_remote_computer_requests SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1 RETURNING expires_at`, request.RequestID).Scan(&expires)
				case "connection":
					err = s.pool.QueryRow(ctx, `UPDATE governance_device_connections SET connection_expires=clock_timestamp()+interval '400 milliseconds' RETURNING connection_expires`).Scan(&expires)
				case "certificate":
					err = s.pool.QueryRow(ctx, `UPDATE governance_device_connections SET certificate_expires=clock_timestamp()+interval '400 milliseconds' RETURNING certificate_expires`).Scan(&expires)
				}
				if err != nil {
					t.Fatal(err)
				}
				blocker, err := s.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer blocker.Rollback(context.Background())
				if _, err = blocker.Exec(ctx, `SELECT revision FROM governance_bot_grants WHERE capability='computer-use.request' FOR UPDATE`); err != nil {
					t.Fatal(err)
				}
				outcome := make(chan error, 1)
				go func() {
					var e error
					if phase == "create" {
						_, e = s.CreateRemoteComputerRequest(ctx, "realm", "device", "run", a, "session", "computer.observe", "Observe fixture", time.Minute)
					} else {
						_, e = s.RemoteComputerLease(ctx, "realm", "device", "connection", request.RequestID, RemoteComputerLeaseInput{Digest: request.Digest, ExpectedRevision: request.Revision, Phase: phase})
					}
					outcome <- e
				}()
				for {
					var blocked, expired bool
					if err = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))),clock_timestamp()>$2`, blocker.Conn().PgConn().PID(), expires).Scan(&blocked, &expired); err != nil {
						t.Fatal(err)
					}
					if blocked && expired {
						break
					}
					select {
					case e := <-outcome:
						t.Fatalf("request did not wait for the held authority lock: %v", e)
					default:
					}
					time.Sleep(5 * time.Millisecond)
				}
				if err = blocker.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				if err = <-outcome; !errors.Is(err, ErrConflict) {
					t.Fatalf("expired %s still authorized %s: %v", deadline, phase, err)
				}
				var commands, receipts int
				if err = s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM governance_device_commands WHERE action='computer_use_request'),(SELECT count(*) FROM governance_remote_computer_receipts)`).Scan(&commands, &receipts); err != nil {
					t.Fatal(err)
				}
				wantCommands, wantReceipts := 1, 0
				if phase == "create" {
					wantCommands = 0
				}
				if phase == "check" {
					wantReceipts = 1
				}
				if commands != wantCommands || receipts != wantReceipts {
					t.Fatalf("expired authority persisted commands/receipts: %d/%d", commands, receipts)
				}
			})
		}
	}
}
