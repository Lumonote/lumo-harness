// Package managedcontent changes managed object pins only inside an existing
// authoritative transaction. It never writes or deletes object-store bytes.
package managedcontent

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

var suffix = regexp.MustCompile(`^managed-content/v1/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/([a-f0-9]{64})$`)

func Parse(realm, key string) (id, digest string, ok bool) {
	if realm == "" || strings.ContainsAny(realm, "/\\\x00") || !strings.HasPrefix(key, realm+"/") {
		return
	}
	m := suffix.FindStringSubmatch(strings.TrimPrefix(key, realm+"/"))
	if m != nil {
		return m[1], m[2], true
	}
	return
}

func IsManaged(key string) bool {
	return strings.HasPrefix(key, "managed-content/") || strings.Contains(key, "/managed-content/")
}

type Reference struct {
	Realm, Kind, ReferenceID, ObjectKey, SHA256 string
	Bytes                                       int64
}

func Pin(ctx context.Context, tx pgx.Tx, ref Reference) error {
	if !IsManaged(ref.ObjectKey) {
		return nil
	}
	id, digest, ok := Parse(ref.Realm, ref.ObjectKey)
	if !ok || digest != ref.SHA256 || ref.Kind != "task-artifact" || ref.Bytes < 0 {
		return errors.New("managed content identity mismatch")
	}
	var state, hash, key, kind, reserved string
	var bytes int64
	err := tx.QueryRow(ctx, `SELECT state,sha256,byte_size,object_key,reservation_kind,reservation_id FROM managed_content_objects WHERE realm=$1 AND object_id=$2::uuid FOR UPDATE`, ref.Realm, id).Scan(&state, &hash, &bytes, &key, &kind, &reserved)
	if err != nil {
		return err
	}
	if state != "ready" || hash != ref.SHA256 || bytes != ref.Bytes || key != ref.ObjectKey || kind != ref.Kind || reserved != ref.ReferenceID {
		return errors.New("managed artifact is not ready or belongs to another reservation")
	}
	var prior string
	var released bool
	err = tx.QueryRow(ctx, `SELECT object_id::text,released_at IS NOT NULL FROM managed_content_references WHERE realm=$1 AND kind=$2 AND reference_id=$3`, ref.Realm, ref.Kind, ref.ReferenceID).Scan(&prior, &released)
	if err == nil && (prior != id || released) {
		return errors.New("managed reference cannot be reused or revived")
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err = tx.Exec(ctx, `INSERT INTO managed_content_references(realm,kind,reference_id,object_id)VALUES($1,$2,$3,$4::uuid)`, ref.Realm, ref.Kind, ref.ReferenceID, id); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE managed_content_objects SET reservation_active=false,unreferenced_at=NULL,collect_after=NULL,revision=revision+1 WHERE realm=$1 AND object_id=$2::uuid`, ref.Realm, id)
	return err
}

func Release(ctx context.Context, tx pgx.Tx, ref Reference) error {
	if !IsManaged(ref.ObjectKey) {
		return nil
	} // Legacy content is never collected.
	id, _, ok := Parse(ref.Realm, ref.ObjectKey)
	if !ok || ref.Kind != "task-artifact" {
		return errors.New("invalid managed release")
	}
	var state string
	if err := tx.QueryRow(ctx, `SELECT state FROM managed_content_objects WHERE realm=$1 AND object_id=$2::uuid FOR UPDATE`, ref.Realm, id).Scan(&state); err != nil {
		return err
	}
	var prior string
	if err := tx.QueryRow(ctx, `SELECT object_id::text FROM managed_content_references WHERE realm=$1 AND kind=$2 AND reference_id=$3`, ref.Realm, ref.Kind, ref.ReferenceID).Scan(&prior); err != nil {
		return err
	}
	if prior != id {
		return errors.New("managed reference belongs to another object")
	}
	if _, err := tx.Exec(ctx, `UPDATE managed_content_references SET released_at=COALESCE(released_at,now()) WHERE realm=$1 AND kind=$2 AND reference_id=$3`, ref.Realm, ref.Kind, ref.ReferenceID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE managed_content_objects o SET unreferenced_at=COALESCE(unreferenced_at,now()),collect_after=COALESCE(collect_after,GREATEST(retain_until,now()+grace_ms*interval '1 millisecond')),revision=revision+1 WHERE realm=$1 AND object_id=$2::uuid AND NOT EXISTS(SELECT 1 FROM managed_content_references r WHERE r.realm=o.realm AND r.object_id=o.object_id AND r.released_at IS NULL)`, ref.Realm, id)
	return err
}
