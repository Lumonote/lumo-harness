// Package store 实现协作服务的持久化：Redis WAL（热）+ PostgreSQL 快照（权威）。
//
// §5.4.7.4 的核心契约：**确认给客户端之前必须已落 WAL**——否则出现
// 「显示已保存实则丢失」。RPO 目标 0（WAL 已确认即不丢）、RTO 目标 < 10s。
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
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
--
-- realm/space 冻结在 outbox 行上而不是派发时回查 collab_documents：
-- 派发可能晚于一次空间迁移，回查会把旧事件投影到新空间（跨空间泄漏路径）。
CREATE TABLE IF NOT EXISTS collab_publish_outbox (
  id         BIGSERIAL PRIMARY KEY,
  doc_id     TEXT NOT NULL,
  realm      TEXT NOT NULL,
  space      TEXT NOT NULL,
  version    INTEGER NOT NULL,
  dispatched BOOLEAN NOT NULL DEFAULT false,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CREATE TABLE IF NOT EXISTS 不会给已存在的库补列，必须显式 ALTER（幂等）
ALTER TABLE collab_publish_outbox ADD COLUMN IF NOT EXISTS attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collab_publish_outbox ADD COLUMN IF NOT EXISTS last_error TEXT NOT NULL DEFAULT '';

-- 扫描条件是 dispatched = false（attempts 用尽的行由查询侧过滤）。
-- 局部索引里 dispatched 恒为常量，因此 (dispatched, id) 实际等价于按 id 排序的
-- 局部索引，可直接支撑 ORDER BY o.id LIMIT n，无需另建索引。
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
  PRIMARY KEY (realm, space, subject)
);

-- 把主键修正到 (realm, space, subject)。旧 local-lite 的 DDL 用的是 (space, subject)，
-- 两个 realm 会在同一个 space id 上互相覆盖 —— 这是租户隔离缺陷，不是格式问题。
-- CREATE TABLE IF NOT EXISTS 对已存在的库是空操作，所以必须显式 ALTER；语句与
-- deploy/migrations/002_collaborator_realm_grants.sql 逐字相同（漂移由
-- shared/__tests__/ddl-ownership.spec.ts 的迁移↔服务收敛用例看守）。
-- 代价是每次启动都 DROP+ADD 一次主键（与 control-plane/heartbeat 的 SchemaSQL 同款做法）：
-- 换掉它就意味着「只跑服务 DDL 的 Compose 部署永远修不好这条主键」。
ALTER TABLE collab_space_grants
  DROP CONSTRAINT IF EXISTS collab_space_grants_pkey;

ALTER TABLE collab_space_grants
  ADD CONSTRAINT collab_space_grants_pkey PRIMARY KEY (realm, space, subject);
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

// NewPGOnly 只用 PostgreSQL 构造 Store（Redis 为空）。
//
// 存在意义是让「只碰 PG 的那一半」可被单独装配与测试：发布 outbox 的读取/确认/失败
// 记录都只走 s.pg。**生产装配必须用 New**——任何 WAL/快照方法在 nil Redis 客户端上
// 都会失败，而这是运行时才暴露的错误。
func NewPGOnly(pool *pgxpool.Pool) *Store { return &Store{pg: pool} }

// Init 幂等建表。
func (s *Store) Init(ctx context.Context) error {
	if _, err := s.pg.Exec(ctx, DDL); err != nil {
		return fmt.Errorf("collaborator: 建表失败: %w", err)
	}
	return nil
}

func (s *Store) Close() {
	s.pg.Close()
	if s.rdb != nil {
		_ = s.rdb.Close()
	}
}

// Pool 暴露连接池给同进程的心跳上报（心跳表由 heartbeat 包与平台迁移
// 004_service_heartbeats.sql 共同维护，见 platform/control-plane/heartbeat）。
func (s *Store) Pool() *pgxpool.Pool { return s.pg }

func walKey(id domain.DocumentID) string { return "collab:wal:" + string(id) }

func walSeqKey(id domain.DocumentID) string { return "collab:wal-seq:" + string(id) }

// 序号必须在 Redis 内分配，不能先 JSON 序列化再依赖 RPush 的返回值；否则
// 持久化的 WAL 记录拿不到自己的全局序号。
var appendWALScript = redis.NewScript(`
local seq = redis.call('INCR', KEYS[2])
redis.call('RPUSH', KEYS[1], '{"seq":' .. seq .. ',"update":' .. ARGV[1] .. '}')
return seq
`)

// 恢复时以 PG 快照/WAL 中已知的最大序号抬升 Redis 计数器。这样即使
// Redis 计数 key 因故丢失，重启后的新 update 也不会复用旧序号。
var ensureWALSeqScript = redis.NewScript(`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local desired = tonumber(ARGV[1])
if current < desired then
  redis.call('SET', KEYS[1], desired)
  return desired
end
return current
`)

// Redis list 裁剪使用的是物理下标，而应用序号在前缀裁剪后仍需单调递增；
// 扫描 envelope 找到第一个未覆盖序号，避免把全局 seq 当 list index。
var trimWALScript = redis.NewScript(`
local values = redis.call('LRANGE', KEYS[1], 0, -1)
for i, value in ipairs(values) do
  local seq = string.match(value, '^%{"seq":([0-9]+),')
  if seq == nil then
    return -1
  end
  if tonumber(seq) > tonumber(ARGV[1]) then
    redis.call('LTRIM', KEYS[1], i - 1, -1)
    return i - 1
  end
end
redis.call('DEL', KEYS[1])
return 0
`)

type walEntry struct {
	Seq    int64         `json:"seq"`
	Update domain.Update `json:"update"`
}

// AppendWAL 追加一条 CRDT update 到 WAL，返回分配的序号。
//
// **这是确认给客户端的前提**：本调用返回后数据已在 Redis AOF 中；
// 调用方必须在本调用成功后才向客户端 ack（RPO 0 的实现点）。
func (s *Store) AppendWAL(ctx context.Context, u domain.Update) (int64, error) {
	blob, err := json.Marshal(u)
	if err != nil {
		return 0, fmt.Errorf("collaborator: 序列化 update 失败: %w", err)
	}
	seq, err := appendWALScript.Run(ctx, s.rdb, []string{walKey(u.DocID), walSeqKey(u.DocID)}, blob).Int64()
	if err != nil {
		return 0, fmt.Errorf("collaborator: 写 WAL 失败: %w", err)
	}
	return seq, nil
}

// EnsureWALSeq 将 Redis 中的序号至少推进到 atLeast，且不会回退已有序号。
// 该操作在文档恢复时调用，兼容 Redis 热层重建或计数 key 缺失的场景。
func (s *Store) EnsureWALSeq(ctx context.Context, id domain.DocumentID, atLeast int64) error {
	if atLeast < 0 {
		atLeast = 0
	}
	if _, err := ensureWALSeqScript.Run(ctx, s.rdb, []string{walSeqKey(id)}, atLeast).Int64(); err != nil {
		return fmt.Errorf("collaborator: 校准 WAL 序号失败: %w", err)
	}
	return nil
}

// ReadWALFrom 读取 WAL 中序号大于 from 的增量，用于崩溃后重建。
// Redis list 可能已经裁剪过前缀，因此必须按 envelope 中的全局 seq 过滤。
func (s *Store) ReadWALFrom(ctx context.Context, id domain.DocumentID, from int64) ([]domain.Update, error) {
	raw, err := s.rdb.LRange(ctx, walKey(id), 0, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("collaborator: 读 WAL 失败: %w", err)
	}
	out := make([]domain.Update, 0, len(raw))
	for _, item := range raw {
		var entry walEntry
		if err := json.Unmarshal([]byte(item), &entry); err == nil && entry.Update.DocID != "" {
			entry.Update.Seq = entry.Seq
			if entry.Seq > 0 && entry.Seq <= from {
				continue
			}
			out = append(out, entry.Update)
			continue
		}

		// 兼容旧版直接存 domain.Update 的 WAL。旧记录没有可靠全局序号，
		// from>0 时宁可重复交给 CRDT（幂等）也不能静默漏掉更新。
		var u domain.Update
		if err := json.Unmarshal([]byte(item), &u); err != nil {
			return nil, fmt.Errorf("collaborator: 解析 WAL 记录失败: %w", err)
		}
		if u.Seq > 0 && u.Seq <= from {
			continue
		}
		out = append(out, u)
	}
	return out, nil
}

// TrimWAL 快照落库后裁剪 WAL 前缀（快照已覆盖的部分）。
func (s *Store) TrimWAL(ctx context.Context, id domain.DocumentID, upto int64) error {
	trimmed, err := trimWALScript.Run(ctx, s.rdb, []string{walKey(id)}, upto).Int64()
	if err != nil {
		return fmt.Errorf("collaborator: 裁剪 WAL 失败: %w", err)
	}
	if trimmed < 0 {
		// 旧格式没有 envelope 序号，保留数据等待自然迁移，不能冒险删除。
		return nil
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
	if errors.Is(err, pgx.ErrNoRows) {
		// 无状态记录 = 新文档，从空开始
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, fmt.Errorf("collaborator: 读取状态失败: %w", err)
	}
	return state, seq, nil
}

// FindDocument 读取文档权威元数据，并在查询时固定 realm 边界。
// 调用方不得用请求体提供的 space/realm 替代此查询结果。
func (s *Store) FindDocument(ctx context.Context, id domain.DocumentID, realm domain.RealmID) (*domain.Document, error) {
	var d domain.Document
	err := s.pg.QueryRow(ctx,
		`SELECT doc_id, realm, space, title, published_version, updated_at
		 FROM collab_documents WHERE doc_id = $1 AND realm = $2`,
		string(id), string(realm)).Scan(
		&d.ID, &d.Realm, &d.Space, &d.Title, &d.PublishedVersion, &d.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("collaborator: 读取文档元数据失败: %w", err)
	}
	return &d, nil
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
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("collaborator: 读取最新快照失败: %w", err)
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

// PendingPublish 一条待派发的发布事件（outbox 行 + 其快照 + 文档标题）。
//
// 这是**投影管道的输入契约**，与 domain.Snapshot 刻意分开：Snapshot 是「模型可见
// 内容的唯一来源」（铁律 17）的读取形状，它没有 realm/space（快照表也不存）；
// 而 outbox 事件必须带 realm/space 才能把投影写进正确的租户与空间。
// 把两者合成一个结构会让「读快照」的路径被迫返回空 realm —— 那种字段迟早被用错。
type PendingPublish struct {
	DocID     domain.DocumentID
	Realm     domain.RealmID
	Space     domain.SpaceID
	Title     string
	Version   int
	Publisher string
	Content   string
	Attempts  int
	CreatedAt time.Time
}

// PendingPublishes 读取尚未派发的发布事件，按 outbox 写入顺序（= 发布版本顺序）。
//
// 语义要点：
//
//  1. **至少一次，不是恰好一次。** 这里不加 FOR UPDATE SKIP LOCKED：不持有事务时
//     它毫无作用（锁在语句结束即释放），而把 SELECT 与 MarkDispatched 合成一个事务
//     意味着把 embedding 网络调用圈进数据库事务里。多副本同时扫到同一行是可接受
//     的，因为下游 ingest 按 (doc_id, chunk_index) upsert 且带源版本单调校验。
//  2. **按 id 升序**，所以同一文档的版本严格递增地到达下游，不会出现「先新后旧」
//     把旧内容盖掉（ingest 侧遇到旧版本会显式拒绝，见 indexing.ErrSuperseded）。
//  3. attempts 用尽的行不再返回：否则一条永久失败的行会长期占据 LIMIT 配额，
//     把它后面所有新发布饿死。失败原因留在 last_error 供排查，见 CountStalledPublishes。
//  4. INNER JOIN 快照/文档：文档被删除后其快照级联消失，残留的 outbox 行没有可投影
//     的内容，跳过才是正确行为。**若将来新增删除文档的路径，必须同时清掉它的待派发行。**
func (s *Store) PendingPublishes(ctx context.Context, limit, maxAttempts int) ([]PendingPublish, error) {
	rows, err := s.pg.Query(ctx,
		`SELECT o.doc_id, o.realm, o.space, d.title, o.version, s.publisher, s.content, o.attempts, s.created_at
		 FROM collab_publish_outbox o
		 JOIN collab_snapshots s ON s.doc_id = o.doc_id AND s.version = o.version
		 JOIN collab_documents d ON d.doc_id = o.doc_id
		 WHERE o.dispatched = false AND o.attempts < $1
		 ORDER BY o.id LIMIT $2`, maxAttempts, limit)
	if err != nil {
		return nil, fmt.Errorf("collaborator: 读 outbox 失败: %w", err)
	}
	defer rows.Close()

	var out []PendingPublish
	for rows.Next() {
		var p PendingPublish
		if err := rows.Scan(&p.DocID, &p.Realm, &p.Space, &p.Title, &p.Version,
			&p.Publisher, &p.Content, &p.Attempts, &p.CreatedAt); err != nil {
			return nil, fmt.Errorf("collaborator: 扫描 outbox 失败: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// MarkDispatched 标记 outbox 记录已被 reindex 管道消费。
//
// 只在**下游确认写入成功后**调用；调用失败或未调用都意味着下一轮重扫，重扫是安全的
// （下游 upsert 幂等）。所以这里是「确认」，不是「认领」——没有认领列就没有超时回收。
func (s *Store) MarkDispatched(ctx context.Context, id domain.DocumentID, version int) error {
	_, err := s.pg.Exec(ctx,
		`UPDATE collab_publish_outbox SET dispatched = true, last_error = ''
		 WHERE doc_id = $1 AND version = $2 AND dispatched = false`,
		string(id), version)
	if err != nil {
		return fmt.Errorf("collaborator: 标记 outbox 失败: %w", err)
	}
	return nil
}

// RecordDispatchFailure 记一次派发失败：累加 attempts 并保留最后一次原因，
// 返回累加后的 attempts（调用方据此判断这一行是否刚刚触到停滞阈值）。
//
// terminal 为真表示「重试同一个载荷不可能成功」（契约不匹配等），直接把 attempts
// 推到上限，避免把 embedding 调用白烧 maxAttempts 轮；原因仍留在 last_error。
// 停滞的行不是静默丢弃：调用方会就这一次跨越阈值打日志，而且该文档下次发布会产生
// 一条 attempts 归零的新行，天然自愈。
func (s *Store) RecordDispatchFailure(ctx context.Context, id domain.DocumentID, version int, reason string, maxAttempts int, terminal bool) (int, error) {
	var attempts int
	err := s.pg.QueryRow(ctx,
		`UPDATE collab_publish_outbox
		    SET attempts = CASE WHEN $4 THEN $5 ELSE attempts + 1 END, last_error = $3
		  WHERE doc_id = $1 AND version = $2 AND dispatched = false
		 RETURNING attempts`,
		string(id), version, reason, terminal, maxAttempts).Scan(&attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		// 行已被确认（或不存在）：不是错误，交给调用方当作「无需记录」。
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("collaborator: 记录派发失败失败: %w", err)
	}
	return attempts, nil
}

// Permissions 查询主体在空间上的权限集合（空 = 无任何权限）。
func (s *Store) Permissions(ctx context.Context, realm domain.RealmID, space domain.SpaceID, subject string) ([]domain.Permission, error) {
	var perms []string
	err := s.pg.QueryRow(ctx,
		`SELECT permissions FROM collab_space_grants WHERE realm = $1 AND space = $2 AND subject = $3`,
		string(realm), string(space), subject).Scan(&perms)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("collaborator: 读取空间权限失败: %w", err)
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
		 ON CONFLICT (realm, space, subject) DO UPDATE SET permissions = EXCLUDED.permissions`,
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
