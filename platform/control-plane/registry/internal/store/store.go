// Package store 是注册表的 PG 索引层。
//
// 关键定位：**PG 是索引，不是真相源**。这里落的 scopes/requires/deps 供查询、
// 列表与依赖图遍历使用；任何一处执法判断都不得以它为输入（见 plan 包）。
// 因此本包也刻意不建 publisher 表——信任根在配置文件里，
// 否则写穿数据库就等于换掉信任根。
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/resolve"
	"github.com/lumo-harness/platform/registry/internal/trust"
)

var (
	// ErrVersionImmutable 表示同 (name, version) 已存在且内容不同。
	ErrVersionImmutable = errors.New("registry: 版本已发布且内容不同，请提版本号")
	// ErrNotFound 表示制品未发布。
	ErrNotFound = errors.New("registry: 制品未发布")
)

const ddl = `
CREATE TABLE IF NOT EXISTS registry_artifacts (
    name          TEXT        NOT NULL,
    version       TEXT        NOT NULL,
    kind          TEXT        NOT NULL,
    publisher     TEXT        NOT NULL,
    digest        TEXT        NOT NULL,
    sig           BYTEA       NOT NULL,
    scopes        TEXT[]      NOT NULL,
    requires      JSONB       NOT NULL,
    published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (name, version)
);

CREATE TABLE IF NOT EXISTS registry_artifact_deps (
    name        TEXT NOT NULL,
    version     TEXT NOT NULL,
    dep_name    TEXT NOT NULL,
    dep_version TEXT NOT NULL,
    PRIMARY KEY (name, version, dep_name),
    FOREIGN KEY (name, version) REFERENCES registry_artifacts(name, version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS registry_artifact_deps_dep_idx
    ON registry_artifact_deps (dep_name, dep_version);

-- rollouts 是 Nacos Config 的位置，本期用 PG 顶（偏离声明见设计说明 §6）。
CREATE TABLE IF NOT EXISTS registry_rollouts (
    channel    TEXT        NOT NULL,
    name       TEXT        NOT NULL,
    version    TEXT        NOT NULL,
    percent    INT         NOT NULL DEFAULT 100,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel, name)
);
`

// Record 是一条制品索引记录。
//
// 注意 Scopes/Requires 两个字段：它们是**查询用**的投影，
// 安装端执法必须走 plan 包从 Digest 取字节重解析，不得读这里。
type Record struct {
	Name       string            `json:"name"`
	Version    string            `json:"version"`
	Kind       manifest.Kind     `json:"kind"`
	Publisher  string            `json:"publisher"`
	Digest     string            `json:"digest"`
	Sig        []byte            `json:"-"`
	Scopes     []string          `json:"scopes"`
	Requires   manifest.Requires `json:"requires"`
	Deps       []manifest.Dep    `json:"deps,omitempty"`
	Idempotent bool              `json:"idempotent,omitempty"` // 本次 Publish 是否命中同 digest 幂等路径
}

// Store 持有 PG 连接池、对象存储与信任表。
type Store struct {
	pool  *pgxpool.Pool
	objs  objstore.Store
	trust *trust.Store
}

// New 建连接池。
func New(ctx context.Context, dsn string, objs objstore.Store, ts *trust.Store) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("registry: 连库失败: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("registry: 库不可达: %w", err)
	}
	return &Store{pool: pool, objs: objs, trust: ts}, nil
}

// Close 关闭连接池。
func (s *Store) Close() { s.pool.Close() }

// Init 建表。幂等。
func (s *Store) Init(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, ddl); err != nil {
		return fmt.Errorf("registry: 建表失败: %w", err)
	}
	return nil
}

// TruncateForTest 清空注册表相关表，仅供集成测试使用。
func (s *Store) TruncateForTest(ctx context.Context) error {
	_, err := s.pool.Exec(ctx,
		`TRUNCATE registry_artifact_deps, registry_artifacts, registry_rollouts`)
	return err
}

// ExecForTest 执行任意 SQL，仅供集成测试模拟「有人写穿数据库」。
func (s *Store) ExecForTest(ctx context.Context, sql string, args ...any) error {
	_, err := s.pool.Exec(ctx, sql, args...)
	return err
}

// Publish 发布一份制品。
//
// 顺序是刻意的：**先把字节写进对象存储，再写 PG 元数据**。
// 反过来会在库里留下「已发布但取不到字节」的记录，而这个错误要到安装期
// 才被发现——那时可能是几周后、在另一个集群、由不知情的人触发。
// 顺序对了以后，失败残留只是对象存储里的孤儿字节：内容寻址使其无害
// （同 digest 重传幂等，异步 GC 可后置）。
//
// 刻意**不做**「先查一次不可变性再决定要不要写字节」的前置检查：
// 那个检查省下的只是几个孤儿字节，代价是把冲突判定写成两份
// （前置检查一份、事务内一份），而并发发布下前者本就不可靠。
// 冲突判定只留事务内这一处。
//
// raw 必须是发布方签名时所覆盖的**原始字节**，本函数全程不得重序列化。
func (s *Store) Publish(ctx context.Context, raw, sig []byte) (*Record, error) {
	m, err := manifest.Parse(raw)
	if err != nil {
		return nil, err
	}
	// 验签在解析之后、落盘之前：签的是 raw 逐字节，不是解析结果。
	if err := s.trust.Verify(m.Publisher, raw, sig); err != nil {
		return nil, err
	}
	pub, ok := s.trust.Lookup(m.Publisher)
	if !ok {
		return nil, fmt.Errorf("%w: %q", trust.ErrUnknownPublisher, m.Publisher)
	}
	if bad, within := trust.ScopesWithin(m.Scopes, pub.MaxScopes); !within {
		return nil, fmt.Errorf("%w: %s", trust.ErrScopeEscalation, bad)
	}

	digest := objstore.Digest(raw)
	if err := s.objs.Put(ctx, digest, raw); err != nil {
		return nil, err
	}

	reqJSON, err := json.Marshal(m.Requires)
	if err != nil {
		return nil, fmt.Errorf("registry: requires 序列化失败: %w", err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("registry: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
		INSERT INTO registry_artifacts (name, version, kind, publisher, digest, sig, scopes, requires)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (name, version) DO NOTHING`,
		m.Name, m.Version, string(m.Kind), m.Publisher, digest, sig, m.Scopes, reqJSON)
	if err != nil {
		return nil, fmt.Errorf("registry: 写元数据失败: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// 该 (name, version) 已存在。同 digest 是幂等重发，不同 digest 是不可变性违规。
		existing, gerr := s.Get(ctx, m.Name, m.Version)
		if gerr != nil {
			return nil, gerr
		}
		if existing.Digest == digest {
			existing.Idempotent = true
			return existing, nil
		}
		return nil, fmt.Errorf("%w: %s@%s 已是 %s", ErrVersionImmutable, m.Name, m.Version, existing.Digest)
	}

	for _, d := range m.Deps {
		if _, err := tx.Exec(ctx, `
			INSERT INTO registry_artifact_deps (name, version, dep_name, dep_version)
			VALUES ($1,$2,$3,$4)`,
			m.Name, m.Version, d.Name, d.Version); err != nil {
			return nil, fmt.Errorf("registry: 写依赖失败: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("registry: 提交失败: %w", err)
	}

	return &Record{
		Name: m.Name, Version: m.Version, Kind: m.Kind, Publisher: m.Publisher,
		Digest: digest, Sig: sig, Scopes: m.Scopes, Requires: m.Requires, Deps: m.Deps,
	}, nil
}

// Get 按 (name, version) 查一条索引记录。查不到返回 ErrNotFound。
func (s *Store) Get(ctx context.Context, name, version string) (*Record, error) {
	var (
		r       Record
		kind    string
		reqJSON []byte
	)
	err := s.pool.QueryRow(ctx, `
		SELECT name, version, kind, publisher, digest, sig, scopes, requires
		  FROM registry_artifacts WHERE name = $1 AND version = $2`,
		name, version).Scan(&r.Name, &r.Version, &kind, &r.Publisher, &r.Digest, &r.Sig, &r.Scopes, &reqJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: %s@%s", ErrNotFound, name, version)
	}
	if err != nil {
		return nil, fmt.Errorf("registry: 查询失败: %w", err)
	}
	r.Kind = manifest.Kind(kind)
	if err := json.Unmarshal(reqJSON, &r.Requires); err != nil {
		return nil, fmt.Errorf("registry: requires 反序列化失败: %w", err)
	}

	rows, err := s.pool.Query(ctx, `
		SELECT dep_name, dep_version FROM registry_artifact_deps
		 WHERE name = $1 AND version = $2 ORDER BY dep_name`, name, version)
	if err != nil {
		return nil, fmt.Errorf("registry: 查依赖失败: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var d manifest.Dep
		if err := rows.Scan(&d.Name, &d.Version); err != nil {
			return nil, fmt.Errorf("registry: 读依赖失败: %w", err)
		}
		r.Deps = append(r.Deps, d)
	}
	return &r, rows.Err()
}

// List 列出某个名字下已发布的全部版本，供 UI 与运维使用。
func (s *Store) List(ctx context.Context, name string) ([]Record, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT version FROM registry_artifacts WHERE name = $1 ORDER BY published_at DESC`, name)
	if err != nil {
		return nil, fmt.Errorf("registry: 列举失败: %w", err)
	}
	defer rows.Close()
	var versions []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		versions = append(versions, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]Record, 0, len(versions))
	for _, v := range versions {
		r, err := s.Get(ctx, name, v)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, nil
}

// LookupNode 把 Store 适配成 resolve.LookupFunc。
//
// 只透传 Digest 与 Sig，**不透传 Scopes/Requires**——那两个字段留在 Record 里
// 供查询用，绝不能流进闭包解析与计划生成的路径，否则 PG 就变回真相源了。
func (s *Store) LookupNode(ctx context.Context, name, version string) (*resolve.Node, error) {
	r, err := s.Get(ctx, name, version)
	if errors.Is(err, ErrNotFound) {
		return nil, resolve.ErrMissing
	}
	if err != nil {
		return nil, err
	}
	return &resolve.Node{
		Name: r.Name, Version: r.Version, Digest: r.Digest, Sig: r.Sig, Deps: r.Deps,
	}, nil
}
