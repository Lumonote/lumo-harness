package store

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/storageledger"
)

type StorageQuota struct {
	Scope      string           `json:"scope"`
	ProjectID  string           `json:"project_id"`
	LimitBytes *int64           `json:"limit_bytes"`
	UsedBytes  int64            `json:"used_bytes"`
	Revision   int64            `json:"revision"`
	ByKind     map[string]int64 `json:"by_kind"`
}

func storageQuotaTx(ctx context.Context, tx pgx.Tx, realm, project string) (StorageQuota, error) {
	out := StorageQuota{Scope: "realm", ProjectID: project, ByKind: map[string]int64{}}
	if project != "" {
		out.Scope = "project"
	}
	err := tx.QueryRow(ctx, `SELECT limit_bytes,revision FROM platform_storage_limits WHERE realm=$1 AND scope=$2 AND scope_id=$3`, realm, out.Scope, project).Scan(&out.LimitBytes, &out.Revision)
	if err != nil {
		return out, err
	}
	rows, err := tx.Query(ctx, `SELECT kind,COALESCE(sum(bytes),0)::bigint FROM platform_storage_charges WHERE realm=$1 AND released_at IS NULL AND ($2='' OR project_id=$2) GROUP BY kind`, realm, project)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind string
		var size int64
		if err = rows.Scan(&kind, &size); err != nil {
			return out, err
		}
		out.ByKind[kind] = size
		out.UsedBytes += size
	}
	return out, rows.Err()
}

// The same organization lock as grant/account changes makes revocation and
// quota administration serialize. Both reads and writes require a live direct
// administrator in this transaction, rather than a stale header role.
func (s *Store) StorageQuota(ctx context.Context, realm, project, actor string, expected *int64, limit *int64) (StorageQuota, error) {
	if len(project) > 256 || (limit != nil && *limit < 0) || (expected != nil && *expected < 1) {
		return StorageQuota{}, ErrBadRequest
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return StorageQuota{}, err
	}
	defer tx.Rollback(ctx)
	if err = requireCurrentRolePolicyAdmin(ctx, tx, realm, actor); err != nil {
		return StorageQuota{}, err
	}
	if err = storageledger.Lock(ctx, tx, realm, project); err != nil {
		return StorageQuota{}, err
	}
	if err = requireCurrentRolePolicyAdmin(ctx, tx, realm, actor); err != nil {
		return StorageQuota{}, err
	}
	before, err := storageQuotaTx(ctx, tx, realm, project)
	if err != nil {
		return before, err
	}
	if expected != nil {
		if before.Revision != *expected {
			return before, ErrConflict
		}
		if _, err = tx.Exec(ctx, `UPDATE platform_storage_limits SET limit_bytes=$4,revision=revision+1,updated_at=clock_timestamp() WHERE realm=$1 AND scope=$2 AND scope_id=$3`, realm, before.Scope, project, limit); err != nil {
			return before, err
		}
		if err = recordUserAdminEvent(ctx, tx, realm, actor, "storage_quota_updated", actor, map[string]any{"scope": before.Scope, "project_id": project, "before": before.LimitBytes, "limit_bytes": limit, "revision": before.Revision + 1}); err != nil {
			return before, err
		}
	}
	out, err := storageQuotaTx(ctx, tx, realm, project)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
