// Package registry 连接器目录（§10.1「注册进 Nacos，全局可发现复用」）。
//
// 形态替代（铁律 21）：Local-lite 用 PG 表 + TTL 缓存轮询；Standalone+ 换 Nacos
// Config 推送实现同一 Registry 接口。Gateway 只依赖接口，不感知来源。
package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
)

// DDL 幂等建表。manifest 整体存 JSONB：连接器 schema 演进不需要 DDL 迁移，
// 而 id/realm/enabled 提到列上是因为它们参与查询与索引。
const DDL = `
CREATE TABLE IF NOT EXISTS connectors (
  id         TEXT NOT NULL,
  realm      TEXT NOT NULL,
  name       TEXT NOT NULL,
  manifest   JSONB NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, realm)
);

CREATE INDEX IF NOT EXISTS idx_connectors_realm ON connectors (realm) WHERE enabled;
`

// Registry 连接器发现接口。
type Registry interface {
	// Lookup 取单个连接器。不存在、跨 realm、已停用一律返回 ErrNotFound
	// —— 三种情况回同一个错误，避免通过错误码探测他 realm 的连接器是否存在。
	Lookup(ctx context.Context, realm domain.RealmID, id string) (domain.Connector, error)
	List(ctx context.Context, realm domain.RealmID) ([]domain.Connector, error)
	Upsert(ctx context.Context, c domain.Connector) error
	Disable(ctx context.Context, realm domain.RealmID, id string) error
}

type cacheEntry struct {
	conn domain.Connector
	at   time.Time
}

// PgRegistry PG 实现，带短 TTL 缓存（Nacos 是推送，PG 只能拉，所以缓存要短）。
type PgRegistry struct {
	pool *pgxpool.Pool
	ttl  time.Duration

	mu    sync.RWMutex
	cache map[string]cacheEntry
}

func NewPg(pool *pgxpool.Pool, ttl time.Duration) *PgRegistry {
	if ttl <= 0 {
		ttl = 10 * time.Second
	}
	return &PgRegistry{pool: pool, ttl: ttl, cache: map[string]cacheEntry{}}
}

func (r *PgRegistry) Init(ctx context.Context) error {
	_, err := r.pool.Exec(ctx, DDL)
	return err
}

func cacheKey(realm domain.RealmID, id string) string { return string(realm) + "\x00" + id }

func (r *PgRegistry) Lookup(ctx context.Context, realm domain.RealmID, id string) (domain.Connector, error) {
	key := cacheKey(realm, id)
	r.mu.RLock()
	hit, ok := r.cache[key]
	r.mu.RUnlock()
	if ok && time.Since(hit.at) < r.ttl {
		return hit.conn, nil
	}

	var raw []byte
	var version int
	err := r.pool.QueryRow(ctx,
		`SELECT manifest, version FROM connectors WHERE id = $1 AND realm = $2 AND enabled`,
		id, string(realm),
	).Scan(&raw, &version)
	if err != nil {
		// 缓存穿透不区分「查不到」与「查错了」对上层的语义：都不给调用方放行
		return domain.Connector{}, fmt.Errorf("%w: %s", domain.ErrNotFound, id)
	}

	var c domain.Connector
	if err := json.Unmarshal(raw, &c); err != nil {
		return domain.Connector{}, fmt.Errorf("connector %s manifest 解析失败: %w", id, err)
	}
	// 权威字段以列为准，防止 manifest 内的 realm/id 与行不一致造成越权
	c.ID, c.Realm, c.Version, c.Enabled = id, realm, version, true

	r.mu.Lock()
	r.cache[key] = cacheEntry{conn: c, at: time.Now()}
	r.mu.Unlock()
	return c, nil
}

func (r *PgRegistry) List(ctx context.Context, realm domain.RealmID) ([]domain.Connector, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT id, manifest, version FROM connectors WHERE realm = $1 AND enabled ORDER BY id`,
		string(realm))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []domain.Connector
	for rows.Next() {
		var id string
		var raw []byte
		var version int
		if err := rows.Scan(&id, &raw, &version); err != nil {
			return nil, err
		}
		var c domain.Connector
		if err := json.Unmarshal(raw, &c); err != nil {
			return nil, fmt.Errorf("connector %s manifest 解析失败: %w", id, err)
		}
		c.ID, c.Realm, c.Version, c.Enabled = id, realm, version, true
		out = append(out, c)
	}
	return out, rows.Err()
}

func (r *PgRegistry) Upsert(ctx context.Context, c domain.Connector) error {
	if err := Validate(c); err != nil {
		return err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	_, err = r.pool.Exec(ctx,
		`INSERT INTO connectors (id, realm, name, manifest, version, enabled, updated_at)
		 VALUES ($1,$2,$3,$4,$5,true, now())
		 ON CONFLICT (id, realm) DO UPDATE SET
		   name = EXCLUDED.name, manifest = EXCLUDED.manifest,
		   version = connectors.version + 1, enabled = true, updated_at = now()`,
		c.ID, string(c.Realm), c.Name, raw, c.Version)
	if err != nil {
		return err
	}
	r.invalidate(c.Realm, c.ID)
	return nil
}

func (r *PgRegistry) Disable(ctx context.Context, realm domain.RealmID, id string) error {
	// 停用而非删除：连接器可能已被流程/专家引用，删除会破坏引用（同 §11.1 归档优先）
	_, err := r.pool.Exec(ctx,
		`UPDATE connectors SET enabled = false, updated_at = now() WHERE id = $1 AND realm = $2`,
		id, string(realm))
	if err != nil {
		return err
	}
	r.invalidate(realm, id)
	return nil
}

func (r *PgRegistry) invalidate(realm domain.RealmID, id string) {
	r.mu.Lock()
	delete(r.cache, cacheKey(realm, id))
	r.mu.Unlock()
}
