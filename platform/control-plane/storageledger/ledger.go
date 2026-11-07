// Package storageledger accounts logical retained bytes at authoritative commit
// boundaries. It is not an object collector: a charge never grants deletion.
package storageledger

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const DDL = `
CREATE TABLE IF NOT EXISTS platform_storage_limits (
 realm TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('realm','project')),scope_id TEXT NOT NULL,
 limit_bytes BIGINT CHECK(limit_bytes>=0),revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(realm,scope,scope_id),
 CHECK((scope='realm' AND scope_id='') OR (scope='project' AND scope_id<>''))
);
CREATE TABLE IF NOT EXISTS platform_storage_charges (
 realm TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('session-attachment','run-file','task-artifact','knowledge-file')),
 reference_id TEXT NOT NULL,project_id TEXT NOT NULL,bytes BIGINT NOT NULL CHECK(bytes>=0),
 object_key TEXT NOT NULL DEFAULT '',released_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(realm,kind,reference_id)
);
CREATE INDEX IF NOT EXISTS platform_storage_charges_project ON platform_storage_charges(realm,project_id);
CREATE TABLE IF NOT EXISTS platform_storage_coverage (
 producer TEXT PRIMARY KEY CHECK(producer IN ('session-attachment','run-file','task-artifact','knowledge-file')),
 completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

var ErrQuota = errors.New("storage quota exceeded")
var ErrCoverage = errors.New("storage accounting is awaiting producer backfill")

type Charge struct {
	Realm, ProjectID, Kind, ReferenceID, ObjectKey string
	Bytes                                          int64
}

// Lock always takes the realm row before project rows. The realm row serializes
// different projects and replicas, including a concurrent limit reduction.
func Lock(ctx context.Context, tx pgx.Tx, realm, project string) error {
	if realm == "" {
		return errors.New("missing storage realm")
	}
	_, err := tx.Exec(ctx, `INSERT INTO platform_storage_limits(realm,scope,scope_id) VALUES($1,'realm','') ON CONFLICT DO NOTHING`, realm)
	if err != nil {
		return err
	}
	var revision int64
	if err = tx.QueryRow(ctx, `SELECT revision FROM platform_storage_limits WHERE realm=$1 AND scope='realm' AND scope_id='' FOR UPDATE`, realm).Scan(&revision); err != nil {
		return err
	}
	if project == "" {
		return nil
	}
	_, err = tx.Exec(ctx, `INSERT INTO platform_storage_limits(realm,scope,scope_id) VALUES($1,'project',$2) ON CONFLICT DO NOTHING`, realm, project)
	if err != nil {
		return err
	}
	return tx.QueryRow(ctx, `SELECT revision FROM platform_storage_limits WHERE realm=$1 AND scope='project' AND scope_id=$2 FOR UPDATE`, realm, project).Scan(&revision)
}

// Register is atomic with the producer's own write. Logical bytes are charged
// per durable reference (forks included), not per deduplicated physical object.
func Register(ctx context.Context, tx pgx.Tx, c Charge) error {
	return register(ctx, tx, c, false)
}

func register(ctx context.Context, tx pgx.Tx, c Charge, historical bool) error {
	if c.Bytes < 0 || c.ReferenceID == "" {
		return errors.New("invalid storage charge")
	}
	if err := Lock(ctx, tx, c.Realm, c.ProjectID); err != nil {
		return err
	}
	var project, key string
	var size int64
	var released bool
	err := tx.QueryRow(ctx, `SELECT project_id,bytes,object_key,released_at IS NOT NULL FROM platform_storage_charges WHERE realm=$1 AND kind=$2 AND reference_id=$3`, c.Realm, c.Kind, c.ReferenceID).Scan(&project, &size, &key, &released)
	if err == nil {
		if project != c.ProjectID || key != c.ObjectKey || size != c.Bytes || released {
			return errors.New("storage reference is immutable")
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if !historical {
		if err = RequireCoverage(ctx, tx, c.Realm, c.ProjectID); err != nil {
			return err
		}
	}
	var fits bool
	err = tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM platform_storage_limits l WHERE l.realm=$1 AND l.limit_bytes IS NOT NULL AND (l.scope='realm' OR (l.scope='project' AND l.scope_id=$2)) AND $3::bigint>l.limit_bytes-COALESCE((SELECT sum(c.bytes) FROM platform_storage_charges c WHERE c.realm=l.realm AND c.released_at IS NULL AND (l.scope='realm' OR c.project_id=l.scope_id)),0))`, c.Realm, c.ProjectID, c.Bytes).Scan(&fits)
	if err != nil {
		return err
	}
	if !fits && !historical {
		return fmt.Errorf("%w", ErrQuota)
	}
	_, err = tx.Exec(ctx, `INSERT INTO platform_storage_charges(realm,project_id,kind,reference_id,bytes,object_key) VALUES($1,$2,$3,$4,$5,$6)`, c.Realm, c.ProjectID, c.Kind, c.ReferenceID, c.Bytes, c.ObjectKey)
	return err
}

// Configured limits fail closed until every present authoritative table has
// completed its own transactional backfill. Absent optional producers do not
// invent physical coverage. Mixed old/new writers must be quiesced on upgrade.
func RequireCoverage(ctx context.Context, tx pgx.Tx, realm, project string) error {
	var ready bool
	err := tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM platform_storage_limits WHERE realm=$1 AND limit_bytes IS NOT NULL AND (scope='realm' OR (scope='project' AND scope_id=$2))) OR NOT EXISTS(
 SELECT 1 FROM (VALUES ('session-attachment','session_attachment_receipts'),('run-file','governance_run_file_blobs'),('task-artifact','governance_task_artifacts'),('knowledge-file','knowledge_library_files')) AS sources(producer,source_table)
 WHERE to_regclass(source_table) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform_storage_coverage c WHERE c.producer=sources.producer))`, realm, project).Scan(&ready)
	if err != nil {
		return err
	}
	if !ready {
		return ErrCoverage
	}
	return nil
}

func CompleteCoverage(ctx context.Context, tx pgx.Tx, producers ...string) error {
	for _, producer := range producers {
		if _, err := tx.Exec(ctx, `INSERT INTO platform_storage_coverage(producer) VALUES($1) ON CONFLICT DO NOTHING`, producer); err != nil {
			return err
		}
	}
	return nil
}

// Ensure runs in the service startup transaction, using the same lock as the TS
// producer so concurrent first starts cannot race PostgreSQL catalog creation.
func Ensure(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(823055)`); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, DDL)
	return err
}

// Initialize releases catalog locks before waiting for any live writer's quota
// row. Even CREATE INDEX IF NOT EXISTS takes a ShareLock: retaining it during
// backfill can deadlock with a writer that holds the realm row but has not yet
// inserted its charge. The second transaction serializes reconciliation without
// running DDL. Callers must also commit their own metadata DDL before this call.
func Initialize(ctx context.Context, pool *pgxpool.Pool, backfill func(pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = Ensure(ctx, tx); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(823055)`); err != nil {
		return err
	}
	if err = backfill(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Backfill counts existing authoritative references, even when an operator has
// set a limit below their current size. Existing evidence is never discarded.
func Backfill(ctx context.Context, tx pgx.Tx, query string) error {
	for {
		rows, err := tx.Query(ctx, query+` LIMIT 1000`)
		if err != nil {
			return err
		}
		var charges []Charge
		for rows.Next() {
			var c Charge
			if err = rows.Scan(&c.Realm, &c.ProjectID, &c.Kind, &c.ReferenceID, &c.Bytes, &c.ObjectKey); err != nil {
				rows.Close()
				return err
			}
			charges = append(charges, c)
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			return err
		}
		if len(charges) == 0 {
			return nil
		}
		for _, c := range charges {
			if err = register(ctx, tx, c, true); err != nil {
				return err
			}
		}
	}
}
