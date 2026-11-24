package memsync

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DDL 与 deploy/migrations/050_memory_sync.sql 同文（两边幂等）。
const DDL = `
CREATE SEQUENCE IF NOT EXISTS memory_sync_seq;
CREATE TABLE IF NOT EXISTS memory_sync_items (
  realm      TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  workspace  TEXT NOT NULL,
  id         UUID NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '',
  hlc        TEXT NOT NULL,
  device     TEXT NOT NULL,
  deleted    BOOLEAN NOT NULL DEFAULT false,
  seq        BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, user_id, workspace, id)
);
CREATE INDEX IF NOT EXISTS memory_sync_items_pull ON memory_sync_items (realm, user_id, workspace, seq);
`

type Scope struct{ Realm, User, Workspace string }

// Backend 由 PG 实现；测试用内存实现。
type Backend interface {
	Pull(ctx context.Context, s Scope, since int64, limit int) ([]Item, int64, error)
	Push(ctx context.Context, s Scope, device string, changes []Change) ([]Result, error)
}

type PG struct{ pool *pgxpool.Pool }

func NewPG(pool *pgxpool.Pool) *PG { return &PG{pool: pool} }

func (p *PG) Init(ctx context.Context) error { _, err := p.pool.Exec(ctx, DDL); return err }

func (p *PG) Pull(ctx context.Context, s Scope, since int64, limit int) ([]Item, int64, error) {
	rows, err := p.pool.Query(ctx, `SELECT id::text, kind, payload, hlc, device, deleted, seq FROM memory_sync_items
WHERE realm=$1 AND user_id=$2 AND workspace=$3 AND seq>$4 ORDER BY seq LIMIT $5`, s.Realm, s.User, s.Workspace, since, limit)
	if err != nil {
		return nil, since, err
	}
	defer rows.Close()
	items := []Item{}
	cursor := since
	for rows.Next() {
		var it Item
		if err := rows.Scan(&it.ID, &it.Kind, &it.Payload, &it.HLC, &it.Device, &it.Deleted, &it.Seq); err != nil {
			return nil, since, err
		}
		cursor = it.Seq
		items = append(items, it)
	}
	return items, cursor, rows.Err()
}

func (p *PG) Push(ctx context.Context, s Scope, device string, changes []Change) ([]Result, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	out := make([]Result, 0, len(changes))
	for _, c := range changes {
		var cur Item
		var current *Item
		err := tx.QueryRow(ctx, `SELECT id::text, kind, payload, hlc, device, deleted, seq FROM memory_sync_items
WHERE realm=$1 AND user_id=$2 AND workspace=$3 AND id=$4 FOR UPDATE`, s.Realm, s.User, s.Workspace, c.ID).
			Scan(&cur.ID, &cur.Kind, &cur.Payload, &cur.HLC, &cur.Device, &cur.Deleted, &cur.Seq)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
		case err != nil:
			return nil, err
		default:
			current = &cur
		}
		r := Result{ID: c.ID, Outcome: Decide(current, c)}
		if r.Outcome == Accepted {
			if err := tx.QueryRow(ctx, `INSERT INTO memory_sync_items (realm,user_id,workspace,id,kind,payload,hlc,device,deleted,seq)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,nextval('memory_sync_seq'))
ON CONFLICT (realm,user_id,workspace,id) DO UPDATE SET kind=EXCLUDED.kind, payload=EXCLUDED.payload, hlc=EXCLUDED.hlc,
 device=EXCLUDED.device, deleted=EXCLUDED.deleted, seq=EXCLUDED.seq, updated_at=now()
RETURNING seq`, s.Realm, s.User, s.Workspace, c.ID, c.Kind, c.Payload, c.HLC, device, c.Deleted).Scan(&r.Seq); err != nil {
				return nil, err
			}
		} else {
			r.Current = current
			if current != nil {
				r.Seq = current.Seq
			}
		}
		out = append(out, r)
	}
	return out, tx.Commit(ctx)
}
