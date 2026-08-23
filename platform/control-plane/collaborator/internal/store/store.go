// Package store 实现协作服务的持久化：Redis WAL（热）+ PostgreSQL 快照（权威）。
//
// §5.4.7.4 的核心契约：**确认给客户端之前必须已落 WAL**——否则出现
// 「显示已保存实则丢失」。RPO 目标 0（WAL 已确认即不丢）、RTO 目标 < 10s。
package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

// DDL 协作服务的表结构（幂等）。
const DDL = `
CREATE TABLE IF NOT EXISTS collab_documents (
  doc_id            TEXT PRIMARY KEY,
  realm             TEXT NOT NULL,
  space             TEXT NOT NULL,
  title             TEXT NOT NULL,
  published_version INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_docs_space ON collab_documents (realm, space);

-- CRDT 状态快照（权威持久层；WAL 尾部用于重建到最新）
CREATE TABLE IF NOT EXISTS collab_state (
  doc_id     TEXT PRIMARY KEY REFERENCES collab_documents(doc_id) ON DELETE CASCADE,
  state      BYTEA NOT NULL,
  wal_seq    BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 不可变发布快照（§5.4.7.1；模型只读此表内容 —— 铁律 17）
CREATE TABLE IF NOT EXISTS collab_snapshots (
  doc_id     TEXT NOT NULL REFERENCES collab_documents(doc_id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  publisher  TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, version)
);

-- 发布 outbox：与快照同事务写入，由 §5.4.3 管道消费触发向量重建
CREATE TABLE IF NOT EXISTS collab_publish_outbox (
  id         BIGSERIAL PRIMARY KEY,
  doc_id     TEXT NOT NULL,
  realm      TEXT NOT NULL,
  space      TEXT NOT NULL,
  version    INTEGER NOT NULL,
  dispatched BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_outbox_pending
  ON collab_publish_outbox (dispatched, id) WHERE dispatched = false;

-- 评论线程（锚定文档位置，不进 CRDT 正文）
CREATE TABLE IF NOT EXISTS collab_comments (
  comment_id TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES collab_documents(doc_id) ON DELETE CASCADE,
  anchor     TEXT NOT NULL,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  resolved   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 空间级授权（read/edit/comment/publish 独立；OPA 的下沉实现）
CREATE TABLE IF NOT EXISTS collab_space_grants (
  space       TEXT NOT NULL,
  realm       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  permissions TEXT[] NOT NULL,
  PRIMARY KEY (space, subject)
);
`

// Store 组合 PG（权威）与 Redis（WAL 热层）。
type Store struct {
	pg  *pgxpool.Pool
	rdb *redis.Client
}

// New 建立连接池；调用方负责 Close。
func New(ctx context.Context, pgDSN, redisAddr string) (*Store, error) {
	pool, err := pgxpool.New(ctx, pgDSN)
	if err != nil {
		return nil, fmt.Errorf("collaborator: 连接 PG 失败: %w", err)
	}
	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	if err := rdb.Ping(ctx).Err(); err != nil {
		pool.Close()
		return nil, fmt.Errorf("collaborator: 连接 Redis 失败: %w", err)
	}
	return &Store{pg: pool, rdb: rdb}, nil
}

// Init 幂等建表。
func (s *Store) Init(ctx context.Context) error {
	if _, err := s.pg.Exec(ctx, DDL); err != nil {
		return fmt.Errorf("collaborator: 建表失败: %w", err)
	}
	return nil
}

func (s *Store) Close() {
	s.pg.Close()
	_ = s.rdb.Close()
}

func walKey(id domain.DocumentID) string { return "collab:wal:" + string(id) }

// AppendWAL 追加一条 CRDT update 到 WAL，返回分配的序号。
//
// **这是确认给客户端的前提**：本调用返回后数据已在 Redis AOF 中；
// 调用方必须在本调用成功后才向客户端 ack（RPO 0 的实现点）。
func (s *Store) AppendWAL(ctx context.Context, u domain.Update) (int64, error) {
	blob, err := json.Marshal(u)
	if err != nil {
		return 0, fmt.Errorf("collaborator: 序列化 update 失败: %w", err)
	}
	seq, err := s.rdb.RPush(ctx, walKey(u.DocID), blob).Result()
	if err != nil {
		return 0, fmt.Errorf("collaborator: 写 WAL 失败: %w", err)
	}
	return seq, nil
}

// ReadWALFrom 读取 WAL 中自 from（含）起的增量，用于崩溃后重建。
func (s *Store) ReadWALFrom(ctx context.Context, id domain.DocumentID, from int64) ([]domain.Update, error) {
	raw, err := s.rdb.LRange(ctx, walKey(id), from, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("collaborator: 读 WAL 失败: %w", err)
	}
	out := make([]domain.Update, 0, len(raw))
	for _, item := range raw {
		var u domain.Update
		if err := json.Unmarshal([]byte(item), &u); err != nil {
			return nil, fmt.Errorf("collaborator: 解析 WAL 记录失败: %w", err)
		}
		out = append(out, u)
	}
	return out, nil
}

// TrimWAL 快照落库后裁剪 WAL 前缀（快照已覆盖的部分）。
func (s *Store) TrimWAL(ctx context.Context, id domain.DocumentID, upto int64) error {
	if err := s.rdb.LTrim(ctx, walKey(id), upto, -1).Err(); err != nil {
		return fmt.Errorf("collaborator: 裁剪 WAL 失败: %w", err)
	}
	return nil
}

// SaveState 周期性把内存 CRDT 状态合并落 PG（权威层）。
func (s *Store) SaveState(ctx context.Context, id domain.DocumentID, state []byte, walSeq int64) error {
	_, err := s.pg.Exec(ctx,
		`INSERT INTO collab_state (doc_id, state, wal_seq, updated_at)
		 VALUES ($1,$2,$3, now())
		 ON CONFLICT (doc_id) DO UPDATE SET
		   state = EXCLUDED.state, wal_seq = EXCLUDED.wal_seq, updated_at = now()`,
		string(id), state, walSeq)
	if err != nil {
		return fmt.Errorf("collaborator: 保存状态失败: %w", err)
	}
	return nil
}

// LoadState 读取最近的 CRDT 状态快照与其 WAL 位点（崩溃恢复入口）。
func (s *Store) LoadState(ctx context.Context, id domain.DocumentID) ([]byte, int64, error) {
	var state []byte
	var seq int64
	err := s.pg.QueryRow(ctx,
		`SELECT state, wal_seq FROM collab_state WHERE doc_id = $1`, string(id)).Scan(&state, &seq)
	if err != nil {
		// 无状态记录 = 新文档，从空开始
		return nil, 0, nil
	}
	return state, seq, nil
}

// EnsureDocument 幂等登记文档元数据。
func (s *Store) EnsureDocument(ctx context.Context, d domain.Document) error {
	_, err := s.pg.Exec(ctx,
		`INSERT INTO collab_documents (doc_id, realm, space, title)
		 VALUES ($1,$2,$3,$4)
		 ON CONFLICT (doc_id) DO UPDATE SET title = EXCLUDED.title, updated_at = now()`,
		string(d.ID), string(d.Realm), string(d.Space), d.Title)
	if err != nil {
		return fmt.Errorf("collaborator: 登记文档失败: %w", err)
	}
	return nil
}

// Publish 发布快照：**快照 + 版本号 + outbox 同事务**。
//
// outbox 是「向量–源一致」的实现点（§5.4.3）：发布即源写入，
// 由同一条 reindex 管道消费，不另起机制。
func (s *Store) Publish(ctx context.Context, doc domain.Document, publisher, content string) (int, error) {
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("collaborator: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var next int
	if err := tx.QueryRow(ctx,
		`UPDATE collab_documents SET published_version = published_version + 1, updated_at = now()
		 WHERE doc_id = $1 RETURNING published_version`,
		string(doc.ID)).Scan(&next); err != nil {
		return 0, fmt.Errorf("collaborator: 递增版本失败: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO collab_snapshots (doc_id, version, publisher, content) VALUES ($1,$2,$3,$4)`,
		string(doc.ID), next, publisher, content); err != nil {
		return 0, fmt.Errorf("collaborator: 写快照失败: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO collab_publish_outbox (doc_id, realm, space, version) VALUES ($1,$2,$3,$4)`,
		string(doc.ID), string(doc.Realm), string(doc.Space), next); err != nil {
		return 0, fmt.Errorf("collaborator: 写 outbox 失败: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("collaborator: 提交发布事务失败: %w", err)
	}
	return next, nil
}

// LatestSnapshot 读取最新发布快照（模型可见内容的唯一来源，铁律 17）。
func (s *Store) LatestSnapshot(ctx context.Context, id domain.DocumentID) (*domain.Snapshot, error) {
	var snap domain.Snapshot
	err := s.pg.QueryRow(ctx,
		`SELECT doc_id, version, publisher, content, created_at
		 FROM collab_snapshots WHERE doc_id = $1 ORDER BY version DESC LIMIT 1`,
		string(id)).Scan(&snap.DocID, &snap.Version, &snap.Publisher, &snap.Content, &snap.CreatedAt)
	if err != nil {
		return nil, nil
	}
	return &snap, nil
}

// SnapshotAt 读取指定版本（回滚到任意 published 的实现）。
func (s *Store) SnapshotAt(ctx context.Context, id domain.DocumentID, version int) (*domain.Snapshot, error) {
	var snap domain.Snapshot
	err := s.pg.QueryRow(ctx,
		`SELECT doc_id, version, publisher, content, created_at
		 FROM collab_snapshots WHERE doc_id = $1 AND version = $2`,
		string(id), version).Scan(&snap.DocID, &snap.Version, &snap.Publisher, &snap.Content, &snap.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("collaborator: 版本 %d 不存在: %w", version, err)
	}
	return &snap, nil
}

// PendingPublishes 供 reindex 管道消费的未派发 outbox 记录。
func (s *Store) PendingPublishes(ctx context.Context, limit int) ([]domain.Snapshot, error) {
	rows, err := s.pg.Query(ctx,
		`SELECT o.doc_id, o.version, s.publisher, s.content, s.created_at
		 FROM collab_publish_outbox o
		 JOIN collab_snapshots s ON s.doc_id = o.doc_id AND s.version = o.version
		 WHERE o.dispatched = false ORDER BY o.id LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("collaborator: 读 outbox 失败: %w", err)
	}
	defer rows.Close()

	var out []domain.Snapshot
	for rows.Next() {
		var s domain.Snapshot
		if err := rows.Scan(&s.DocID, &s.Version, &s.Publisher, &s.Content, &s.CreatedAt); err != nil {
			return nil, fmt.Errorf("collaborator: 扫描 outbox 失败: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// MarkDispatched 标记 outbox 记录已被 reindex 管道消费。
func (s *Store) MarkDispatched(ctx context.Context, id domain.DocumentID, version int) error {
	_, err := s.pg.Exec(ctx,
		`UPDATE collab_publish_outbox SET dispatched = true WHERE doc_id = $1 AND version = $2`,
		string(id), version)
	if err != nil {
		return fmt.Errorf("collaborator: 标记 outbox 失败: %w", err)
	}
	return nil
}

// Permissions 查询主体在空间上的权限集合（空 = 无任何权限）。
func (s *Store) Permissions(ctx context.Context, space domain.SpaceID, subject string) ([]domain.Permission, error) {
	var perms []string
	err := s.pg.QueryRow(ctx,
		`SELECT permissions FROM collab_space_grants WHERE space = $1 AND subject = $2`,
		string(space), subject).Scan(&perms)
	if err != nil {
		return nil, nil
	}
	out := make([]domain.Permission, 0, len(perms))
	for _, p := range perms {
		out = append(out, domain.Permission(p))
	}
	return out, nil
}

// Grant 授予空间权限（装配/管理接口）。
func (s *Store) Grant(ctx context.Context, space domain.SpaceID, realm domain.RealmID, subject string, perms []domain.Permission) error {
	raw := make([]string, 0, len(perms))
	for _, p := range perms {
		raw = append(raw, string(p))
	}
	_, err := s.pg.Exec(ctx,
		`INSERT INTO collab_space_grants (space, realm, subject, permissions) VALUES ($1,$2,$3,$4)
		 ON CONFLICT (space, subject) DO UPDATE SET permissions = EXCLUDED.permissions`,
		string(space), string(realm), subject, raw)
	if err != nil {
		return fmt.Errorf("collaborator: 授权失败: %w", err)
	}
	return nil
}

// AddComment 新增评论（存 PG，不进 CRDT 正文）。
func (s *Store) AddComment(ctx context.Context, c domain.Comment) error {
	_, err := s.pg.Exec(ctx,
		`INSERT INTO collab_comments (comment_id, doc_id, anchor, author, body) VALUES ($1,$2,$3,$4,$5)`,
		c.ID, string(c.DocID), c.Anchor, c.Author, c.Body)
	if err != nil {
		return fmt.Errorf("collaborator: 写评论失败: %w", err)
	}
	return nil
}

// Comments 读取文档评论。
func (s *Store) Comments(ctx context.Context, id domain.DocumentID) ([]domain.Comment, error) {
	rows, err := s.pg.Query(ctx,
		`SELECT comment_id, doc_id, anchor, author, body, resolved, created_at
		 FROM collab_comments WHERE doc_id = $1 ORDER BY created_at`, string(id))
	if err != nil {
		return nil, fmt.Errorf("collaborator: 读评论失败: %w", err)
	}
	defer rows.Close()

	var out []domain.Comment
	for rows.Next() {
		var c domain.Comment
		if err := rows.Scan(&c.ID, &c.DocID, &c.Anchor, &c.Author, &c.Body, &c.Resolved, &c.CreatedAt); err != nil {
			return nil, fmt.Errorf("collaborator: 扫描评论失败: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
