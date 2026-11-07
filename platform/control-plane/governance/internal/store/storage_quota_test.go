package store

import (
	"context"
	"errors"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/storageledger"
	"testing"
	"time"
)

func TestStorageQuotaCASCurrentAdminAndControlledFilesAtomic(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedRolePolicyAdmin(t, s)
	state, err := s.StorageQuota(ctx, "realm", "project", "manager", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	zero := int64(0)
	state, err = s.StorageQuota(ctx, "realm", "project", "manager", &state.Revision, &zero)
	if err != nil || state.LimitBytes == nil || *state.LimitBytes != 0 {
		t.Fatalf("set %+v %v", state, err)
	}
	// Existing quota audit rows must survive a fresh replica's startup DDL.
	if err = s.Init(ctx); err != nil {
		t.Fatalf("restart after quota audit: %v", err)
	}
	old := int64(1)
	if _, err = s.StorageQuota(ctx, "realm", "project", "manager", &old, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("CAS: %v", err)
	}
	if _, err = s.StorageQuota(ctx, "realm", "project", "employee", nil, nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("nonadmin: %v", err)
	}
	result := seedReviewExecution(t, s, "quota-producer", "quota-agent", "model-a", true)
	if _, err = s.pool.Exec(ctx, `UPDATE governance_agent_presets SET output_profile='platform-closed-text-files-v1' WHERE id='quota-agent'`); err != nil {
		t.Fatal(err)
	}
	result.Files = []domain.RunTextFile{{Name: "result.txt", MediaType: "text/plain; charset=utf-8", Text: "result"}}
	prepareReviewExecution(t, s, result, "model-a")
	if _, err = s.RecordTrustedTaskResult(ctx, "realm", result, "worker"); !errors.Is(err, storageledger.ErrQuota) {
		t.Fatalf("file quota: %v", err)
	}
	var count int
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_run_file_blobs`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("blob escaped failed quota: %d %v", count, err)
	}
}

func TestStorageQuotaAdminExpiryDuringLedgerLockWait(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	seedRolePolicyAdmin(t, s)
	state, err := s.StorageQuota(ctx, "realm", "", "manager", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	blocker, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err = blocker.Exec(ctx, `SELECT revision FROM platform_storage_limits WHERE realm='realm' AND scope='realm' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE governance_user_roles SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE realm='realm'`); err != nil {
		t.Fatal(err)
	}
	outcome := make(chan error, 1)
	go func() { _, e := s.StorageQuota(ctx, "realm", "", "manager", &state.Revision, nil); outcome <- e }()
	deadline := time.Now().Add(4 * time.Second)
	for {
		var blocked, expired bool
		if err = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))),EXISTS(SELECT 1 FROM governance_user_roles WHERE expires_at<clock_timestamp())`, blocker.Conn().PgConn().PID()).Scan(&blocked, &expired); err != nil {
			t.Fatal(err)
		}
		if blocked && expired {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("did not reach expired lock wait")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err = blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-outcome; !errors.Is(err, ErrForbidden) {
		t.Fatalf("expired admin accepted: %v", err)
	}
}
