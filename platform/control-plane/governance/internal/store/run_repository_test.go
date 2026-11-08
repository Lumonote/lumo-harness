package store

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestRepositoryProfileUpgradesLegacyConstraintWithoutChangingPresets(t *testing.T) {
	for _, first := range []string{"migration", "startup"} {
		t.Run(first, func(t *testing.T) {
			s := taskTestStore(t)
			ctx := context.Background()
			for _, name := range []string{"plain", "files", "repository"} {
				seedReviewExecution(t, s, "upgrade-"+name, "upgrade-"+name+"-agent", "model-a", true)
			}
			if _, err := s.pool.Exec(ctx, `UPDATE governance_agent_presets SET output_profile='platform-closed-text-files-v1' WHERE id='upgrade-files-agent';
 ALTER TABLE governance_agent_presets DROP CONSTRAINT governance_agent_presets_output_profile_check;
 ALTER TABLE governance_agent_presets ADD CONSTRAINT governance_agent_presets_output_profile_check CHECK(output_profile IN ('platform-closed-text-v1','platform-closed-text-files-v1'))`); err != nil {
				t.Fatal(err)
			}
			migration, err := os.ReadFile("../../../../deploy/migrations/040_governance_controlled_repository.sql")
			if err != nil {
				t.Fatal(err)
			}
			upgrade := func(kind string) {
				t.Helper()
				if kind == "startup" {
					err = s.Init(ctx)
				} else {
					_, err = s.pool.Exec(ctx, string(migration))
				}
				if err != nil {
					t.Fatalf("%s cannot upgrade existing profile constraint: %v", kind, err)
				}
			}
			upgrade(first)
			if _, err = s.pool.Exec(ctx, `UPDATE governance_agent_presets SET output_profile=$1 WHERE id='upgrade-repository-agent'`, domain.ClosedRepositoryOutputProfile); err != nil {
				t.Fatalf("repository profile is not usable after %s: %v", first, err)
			}
			for _, kind := range []string{"startup", "migration", "startup", "migration"} {
				upgrade(kind)
			}
			for _, profile := range []struct{ id, expected string }{{"plain", domain.ClosedTextOutputProfile}, {"files", domain.ClosedTextFilesOutputProfile}, {"repository", domain.ClosedRepositoryOutputProfile}} {
				var actual string
				var revision int
				if err = s.pool.QueryRow(ctx, `SELECT output_profile,revision FROM governance_agent_presets WHERE id=$1`, "upgrade-"+profile.id+"-agent").Scan(&actual, &revision); err != nil || actual != profile.expected || revision != 1 {
					t.Fatalf("upgrade changed preset %s: %s revision %d: %v", profile.id, actual, revision, err)
				}
			}
			if _, err = s.pool.Exec(ctx, `UPDATE governance_agent_presets SET output_profile='unbounded-host-execution' WHERE id='upgrade-repository-agent'`); err == nil {
				t.Fatal("unknown execution profile bypassed the upgraded constraint")
			}
		})
	}
}

func seedRepositoryRun(t *testing.T, s *Store) (domain.TaskResult, domain.RepositorySnapshot) {
	t.Helper()
	ctx := context.Background()
	r := seedReviewExecution(t, s, "producer", "producer-agent", "model-a", true)
	if _, err := s.pool.Exec(ctx, `UPDATE governance_agent_presets SET output_profile=$1 WHERE id='producer-agent'`, domain.ClosedRepositoryOutputProfile); err != nil {
		t.Fatal(err)
	}
	base := domain.RepositorySnapshot{Repository: "org/repo", BaseCommit: strings.Repeat("a", 40), BaseBranch: "main", Files: []domain.RepositoryFile{{Path: "src/app.ts", Text: "const old = 1\n"}, {Path: "README.md", Text: "Original\n"}}}
	prepared, err := s.PrepareRunExecution(ctx, "realm", r.RunID, PrepareRunExecutionRequest{NodeID: r.NodeID, SessionRef: r.SessionRef, PresetRevision: 1, Provider: "provider", Model: "model-a", RepositorySnapshot: &base})
	if err != nil || prepared.RepositorySnapshot == nil {
		t.Fatalf("repository prepare: %+v %v", prepared, err)
	}
	r.RepositoryFiles = []domain.RepositoryFile{{Path: "src/app.ts", Text: "const updated = 2\n"}, {Path: "README.md", Text: "Original\n"}}
	return r, base
}
func repositoryPublisherRole(t *testing.T, s *Store) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO governance_roles(realm,id,name,status)VALUES('realm','repo-manager','Repository manager','active');INSERT INTO governance_role_permissions(realm,role_id,action,effect)VALUES('realm','repo-manager','task:delegate','allow');INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by)VALUES('realm','manager','repo-manager','manager')`); err != nil {
		t.Fatal(err)
	}
}
func TestRepositoryReviewReadsEveryExactDiffBeforeDraftPublication(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	producer, _ := seedRepositoryRun(t, s)
	recordReviewExecution(t, s, producer)
	repositoryPublisherRole(t, s)
	if _, err := s.AuthorizeRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, "manager", false); !errors.Is(err, ErrConflict) {
		t.Fatalf("unreviewed repo published: %v", err)
	}
	reviewer, bound := prepareFileReviewer(t, s, producer)
	if bound.Manifest.Scope != domain.ClosedRepositoryOutputProfile || bound.Manifest.Repository == nil || len(bound.Manifest.Files) != 1 {
		t.Fatalf("missing repository manifest %+v", bound.Manifest)
	}
	if _, err := s.RecordTrustedTaskResult(ctx, "realm", reviewer, "runtime"); !errors.Is(err, ErrConflict) {
		t.Fatalf("unread diff accepted: %v", err)
	}
	readEveryFile(t, s, &reviewer, bound)
	recordReviewExecution(t, s, reviewer)
	var permits []RepositoryPublication
	var failures []error
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, e := s.AuthorizeRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, "manager", false)
			mu.Lock()
			defer mu.Unlock()
			if e != nil {
				failures = append(failures, e)
			} else {
				permits = append(permits, p)
			}
		}()
	}
	wg.Wait()
	if len(permits) != 1 || len(failures) != 1 {
		t.Fatalf("publication concurrency allowed %d permits / %v", len(permits), failures)
	}
	p := permits[0]
	if p.ManifestDigest != bound.ManifestDigest || len(p.Changes) != 1 || p.Changes[0].Before != "const old = 1\n" || p.Changes[0].After != "const updated = 2\n" {
		t.Fatalf("publication not bound %+v", p)
	}
	if err := s.CompleteRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "https://github.com/org/repo/pull/1", "manager", false); !errors.Is(err, ErrConflict) {
		t.Fatalf("unclaimed permit completed: %v", err)
	}
	permits = nil
	failures = nil
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claim, err := s.ClaimRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "manager", false)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failures = append(failures, err)
			} else {
				permits = append(permits, claim)
			}
		}()
	}
	wg.Wait()
	if len(permits) != 1 || len(failures) != 1 || permits[0].Status != "publishing" || len(permits[0].Changes) != len(p.Changes) {
		t.Fatalf("publication claim not fenced: %+v / %v", permits, failures)
	}
	if _, err := s.ClaimRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "manager", false); !errors.Is(err, ErrConflict) {
		t.Fatalf("ambiguous publication reclaimed: %v", err)
	}
	if err := s.CompleteRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "https://github.com/org/other/pull/1", "manager", false); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("wrong repository URL recorded: %v", err)
	}
	if err := s.CompleteRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "https://github.com/org/repo/pull/1", "manager", false); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_repository_publications WHERE status='draft' AND manifest_digest=$1`, p.ManifestDigest).Scan(&count); err != nil || count != 1 {
		t.Fatalf("missing publication audit %v", err)
	}
	result, err := s.GetTaskResult(ctx, "realm", producer.TaskID, producer.RunID)
	if err != nil || result.ReviewScope != domain.ClosedRepositoryOutputProfile || len(result.Files) != 1 || len(result.RepositoryFiles) != 0 {
		t.Fatalf("human review projection %+v %v", result, err)
	}
}
func TestRepositorySnapshotAndChangeSetCannotBeForgedOrReplaced(t *testing.T) {
	for _, mode := range []string{"base-replaced", "missing-path", "new-path", "normal-tool-result", "corrupt-patch"} {
		t.Run(mode, func(t *testing.T) {
			s := taskTestStore(t)
			ctx := context.Background()
			producer, base := seedRepositoryRun(t, s)
			switch mode {
			case "base-replaced":
				base.Files[0].Text = "replaced base"
				_, err := s.PrepareRunExecution(ctx, "realm", producer.RunID, PrepareRunExecutionRequest{NodeID: producer.NodeID, SessionRef: producer.SessionRef, PresetRevision: 1, Provider: "provider", Model: "model-a", RepositorySnapshot: &base})
				if !errors.Is(err, ErrConflict) {
					t.Fatalf("replaced base: %v", err)
				}
				return
			case "missing-path":
				producer.RepositoryFiles = producer.RepositoryFiles[:1]
			case "new-path":
				producer.RepositoryFiles[0].Path = "other.ts"
			case "normal-tool-result":
				if _, err := s.RecordTaskResult(ctx, "realm", producer, "manager"); !errors.Is(err, ErrForbidden) {
					t.Fatalf("normal output certified %v", err)
				}
				return
			case "corrupt-patch":
				recordReviewExecution(t, s, producer)
				repositoryPublisherRole(t, s)
				reviewer, bound := prepareFileReviewer(t, s, producer)
				readEveryFile(t, s, &reviewer, bound)
				recordReviewExecution(t, s, reviewer)
				var raw []byte
				if err := s.pool.QueryRow(ctx, `SELECT body FROM governance_run_file_blobs WHERE run_id=$1`, producer.RunID).Scan(&raw); err != nil {
					t.Fatal(err)
				}
				var change domain.RepositoryChange
				if err := json.Unmarshal(raw, &change); err != nil {
					t.Fatal(err)
				}
				change.Before = "forged before"
				body, _ := json.Marshal(change)
				if _, err := s.pool.Exec(ctx, `UPDATE governance_run_file_blobs SET body=$2::bytea,bytes=octet_length($2::bytea) WHERE run_id=$1`, producer.RunID, body); err != nil {
					t.Fatal(err)
				}
				if _, err := s.AuthorizeRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, "manager", false); err == nil {
					t.Fatal("corrupt diff published")
				}
				return
			}
			if _, err := s.RecordTrustedTaskResult(ctx, "realm", producer, "runtime"); err == nil {
				t.Fatal("unregistered file set sealed")
			}
		})
	}
}

func TestRepositoryClaimRechecksCurrentAuthorityAndReview(t *testing.T) {
	for _, mode := range []string{"revoked-role", "inactive-user", "archived-task", "expired-review", "wrong-digest"} {
		t.Run(mode, func(t *testing.T) {
			s := taskTestStore(t)
			ctx := context.Background()
			producer, _ := seedRepositoryRun(t, s)
			recordReviewExecution(t, s, producer)
			repositoryPublisherRole(t, s)
			reviewer, bound := prepareFileReviewer(t, s, producer)
			readEveryFile(t, s, &reviewer, bound)
			recordReviewExecution(t, s, reviewer)
			p, err := s.AuthorizeRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, "manager", false)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "revoked-role":
				_, err = s.pool.Exec(ctx, `DELETE FROM governance_user_roles WHERE realm='realm' AND user_id='manager'`)
			case "inactive-user":
				_, err = s.pool.Exec(ctx, `UPDATE governance_users SET status='disabled' WHERE realm='realm' AND id='manager'`)
			case "archived-task":
				_, err = s.pool.Exec(ctx, `UPDATE governance_delegation_tasks SET business_state='ARCHIVED' WHERE id=$1`, producer.TaskID)
			case "expired-review":
				_, err = s.pool.Exec(ctx, `UPDATE governance_run_reviews SET expires_at=clock_timestamp()-interval '1 second' WHERE producer_run_id=$1`, producer.RunID)
			case "wrong-digest":
				p.ManifestDigest = strings.Repeat("0", 64)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.ClaimRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "manager", false); err == nil {
				t.Fatal("stale publication authority claimed")
			}
			var status string
			if err = s.pool.QueryRow(ctx, `SELECT status FROM governance_repository_publications WHERE id=$1::uuid`, p.ID).Scan(&status); err != nil || status != "pending" {
				t.Fatalf("failed claim consumed permit: %s %v", status, err)
			}
		})
	}
}
