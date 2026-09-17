// Package store 是注册表的 PG 索引层。
//
// 关键定位：**PG 是索引，不是真相源**。这里落的 scopes/requires/deps 供查询、
// 列表与依赖图遍历使用；任何一处执法判断都不得以它为输入（见 plan 包）。
// 因此本包也刻意不建 publisher 表——信任根在配置文件里，
// 否则写穿数据库就等于换掉信任根。
package store

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lumo-harness/platform/registry/internal/bundle"

	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/plan"
	"github.com/lumo-harness/platform/registry/internal/resolve"
	"github.com/lumo-harness/platform/registry/internal/trust"
)

var (
	// ErrVersionImmutable 表示同 (name, version) 已存在且内容不同。
	ErrVersionImmutable = errors.New("registry: 版本已发布且内容不同，请提版本号")
	// ErrNotFound 表示制品未发布。
	ErrNotFound = errors.New("registry: 制品未发布")
	// ErrInvalidRollout 表示通道状态无法安全地选择一个节点目标。
	ErrInvalidRollout = errors.New("registry: 灰度发布配置非法")
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
-- previous_version 是 holdback：部分节点继续使用它，直到目标版本扩大到 100%。
-- 两个版本都只是 Registry 中已发布的不可变制品，不是制品内容、签名或信任根。
CREATE TABLE IF NOT EXISTS registry_rollouts (
    channel    TEXT        NOT NULL,
    name       TEXT        NOT NULL,
    version    TEXT        NOT NULL,
	previous_version TEXT    NOT NULL DEFAULT '',
    percent    INT         NOT NULL DEFAULT 100,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel, name)
);

ALTER TABLE registry_rollouts
    ADD COLUMN IF NOT EXISTS previous_version TEXT NOT NULL DEFAULT '';

-- registry_installations 是节点 Provisioner 的实际回报读模型，不是安装信任根。
-- 每个节点只保留最近一次完整对账的结果；制品字节、签名与依赖执法仍由
-- Provisioner 按 /v1/plan 的原始签名字节完成。
CREATE TABLE IF NOT EXISTS registry_installations (
    node_id     TEXT        PRIMARY KEY,
    state       TEXT        NOT NULL CHECK (state IN ('converged', 'failed')),
    root        TEXT        NOT NULL,
    installed   JSONB       NOT NULL,
    shape       JSONB       NOT NULL,
    reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registry_installations_reported_idx
    ON registry_installations (reported_at DESC);
`

// Record 是一条制品索引记录。
//
// 注意 Scopes/Requires 两个字段：它们是**查询用**的投影，
// 安装端执法必须走 plan 包从 Digest 取字节重解析，不得读这里。
type Record struct {
	Name        string            `json:"name"`
	Version     string            `json:"version"`
	Kind        manifest.Kind     `json:"kind"`
	Publisher   string            `json:"publisher"`
	Digest      string            `json:"digest"`
	Sig         []byte            `json:"-"`
	Scopes      []string          `json:"scopes"`
	Requires    manifest.Requires `json:"requires"`
	Deps        []manifest.Dep    `json:"deps,omitempty"`
	PublishedAt time.Time         `json:"published_at"`
	Idempotent  bool              `json:"idempotent,omitempty"` // 本次 Publish 是否命中同 digest 幂等路径
}

// InstalledArtifact 是 Provisioner 已经二次 digest 校验并原子落盘的一项制品。
// Path、payload 内容和错误细节均不回传控制面，避免把节点本地拓扑或敏感诊断暴露到目录。
type InstalledArtifact struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Digest  string `json:"digest"`
}

// InstallationReport 是一个节点对当前安装闭包的事实回报。failed 表示最近一次
// 对账未收敛，不能被前端解释为仍在运行或已完成安装。
type InstallationReport struct {
	NodeID     string              `json:"node_id"`
	State      string              `json:"state"`
	Root       string              `json:"root"`
	Installed  []InstalledArtifact `json:"installed"`
	Shape      plan.Shape          `json:"shape"`
	ReportedAt time.Time           `json:"reported_at"`
}

// Rollout is a desired root version for one artifact in one release channel.
// PreviousVersion is the immutable holdback version selected for nodes outside
// the target cohort. It is captured when Version changes, so a gradual rollout
// can move forward or immediately roll back without guessing an old version.
type Rollout struct {
	Channel         string    `json:"channel"`
	Name            string    `json:"name"`
	Version         string    `json:"version"`
	PreviousVersion string    `json:"previous_version,omitempty"`
	Percent         int       `json:"percent"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// SelectRolloutVersion deterministically assigns a node to the target or
// holdback cohort. The hash intentionally excludes Version: increasing a
// percentage only adds nodes to the target cohort and never moves an already
// selected node back to holdback. A new target version receives the previous
// target as its explicit holdback through UpsertRollout.
func SelectRolloutVersion(rollout Rollout, nodeID string) (version, cohort string, err error) {
	if rollout.Channel == "" || rollout.Name == "" || rollout.Version == "" || rollout.Percent < 0 || rollout.Percent > 100 {
		return "", "", fmt.Errorf("%w: 通道、制品、目标版本必填，percent 必须为 0–100", ErrInvalidRollout)
	}
	if rollout.Percent == 100 {
		return rollout.Version, "target", nil
	}
	if rollout.PreviousVersion == "" {
		return "", "", fmt.Errorf("%w: 部分发布必须保留上一个已发布版本", ErrInvalidRollout)
	}
	if nodeID == "" {
		return "", "", fmt.Errorf("%w: 部分发布必须提供 node_id", ErrInvalidRollout)
	}
	if rollout.Percent == 0 {
		return rollout.PreviousVersion, "holdback", nil
	}
	sum := sha256.Sum256([]byte(rollout.Channel + "\x00" + rollout.Name + "\x00" + nodeID))
	bucket := binary.BigEndian.Uint64(sum[:8]) % 100
	if bucket < uint64(rollout.Percent) {
		return rollout.Version, "target", nil
	}
	return rollout.PreviousVersion, "holdback", nil
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

// Pool 暴露连接池给同进程的心跳上报（心跳表由 heartbeat 包与平台迁移
// 004_service_heartbeats.sql 共同维护，见 platform/control-plane/heartbeat）。
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

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
		`TRUNCATE registry_artifact_deps, registry_artifacts, registry_rollouts, registry_installations`)
	return err
}

// ExecForTest 执行任意 SQL，仅供集成测试模拟「有人写穿数据库」。
func (s *Store) ExecForTest(ctx context.Context, sql string, args ...any) error {
	_, err := s.pool.Exec(ctx, sql, args...)
	return err
}

// UpsertInstallation writes the latest fact reported by one Provisioner. It is
// deliberately an observation, not a desired-state command: accepting a report
// cannot make a node install, enable, or trust an artifact.
func (s *Store) UpsertInstallation(ctx context.Context, report InstallationReport) (InstallationReport, error) {
	installed, err := json.Marshal(report.Installed)
	if err != nil {
		return InstallationReport{}, fmt.Errorf("registry: 序列化已安装制品失败: %w", err)
	}
	shape, err := json.Marshal(report.Shape)
	if err != nil {
		return InstallationReport{}, fmt.Errorf("registry: 序列化节点形态失败: %w", err)
	}
	err = s.pool.QueryRow(ctx, `
		INSERT INTO registry_installations (node_id, state, root, installed, shape, reported_at)
		VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (node_id) DO UPDATE SET
			state = EXCLUDED.state, root = EXCLUDED.root, installed = EXCLUDED.installed,
			shape = EXCLUDED.shape, reported_at = now()
		RETURNING reported_at`,
		report.NodeID, report.State, report.Root, installed, shape,
	).Scan(&report.ReportedAt)
	if err != nil {
		return InstallationReport{}, fmt.Errorf("registry: 写入节点安装回报失败: %w", err)
	}
	return report, nil
}

// ListInstallations returns only the last report from each node. A missing
// report is intentionally different from an empty list of installed artifacts:
// the former means Registry has no evidence about that node.
func (s *Store) ListInstallations(ctx context.Context, limit int) ([]InstallationReport, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT node_id, state, root, installed, shape, reported_at
		FROM registry_installations
		ORDER BY reported_at DESC, node_id
		LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("registry: 列出节点安装回报失败: %w", err)
	}
	defer rows.Close()

	reports := make([]InstallationReport, 0)
	for rows.Next() {
		var report InstallationReport
		var installed, shape []byte
		if err := rows.Scan(&report.NodeID, &report.State, &report.Root, &installed, &shape, &report.ReportedAt); err != nil {
			return nil, fmt.Errorf("registry: 扫描节点安装回报失败: %w", err)
		}
		if err := json.Unmarshal(installed, &report.Installed); err != nil {
			return nil, fmt.Errorf("registry: 解析已安装制品回报失败: %w", err)
		}
		if err := json.Unmarshal(shape, &report.Shape); err != nil {
			return nil, fmt.Errorf("registry: 解析节点形态回报失败: %w", err)
		}
		reports = append(reports, report)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("registry: 遍历节点安装回报失败: %w", err)
	}
	return reports, nil
}

// UpsertRollout changes desired state only after confirming the target is an
// already-published artifact. Provisioners still rebuild a signed /v1/plan;
// a rollout row can choose a version but can never supply executable bytes or
// expand the artifact's capabilities.
func (s *Store) UpsertRollout(ctx context.Context, rollout Rollout) (Rollout, error) {
	if rollout.Channel == "" || rollout.Name == "" || rollout.Version == "" || rollout.Percent < 0 || rollout.Percent > 100 {
		return Rollout{}, fmt.Errorf("%w: 通道、制品、目标版本必填，percent 必须为 0–100", ErrInvalidRollout)
	}
	if _, err := s.Get(ctx, rollout.Name, rollout.Version); err != nil {
		return Rollout{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Rollout{}, fmt.Errorf("registry: 开启灰度发布事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var currentVersion, currentPrevious string
	err = tx.QueryRow(ctx,
		`SELECT version, previous_version FROM registry_rollouts WHERE channel = $1 AND name = $2 FOR UPDATE`,
		rollout.Channel, rollout.Name,
	).Scan(&currentVersion, &currentPrevious)
	switch {
	case err == nil:
		rollout.PreviousVersion = currentPrevious
		if currentVersion != rollout.Version {
			rollout.PreviousVersion = currentVersion
		}
	case errors.Is(err, pgx.ErrNoRows):
		rollout.PreviousVersion = ""
	default:
		return Rollout{}, fmt.Errorf("registry: 读取当前灰度发布失败: %w", err)
	}
	if rollout.Percent < 100 && rollout.PreviousVersion == "" {
		return Rollout{}, fmt.Errorf("%w: 首次发布必须为 100%%，部分发布需要上一个已发布版本", ErrInvalidRollout)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO registry_rollouts (channel, name, version, previous_version, percent, updated_at)
		VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (channel, name) DO UPDATE SET
			version = EXCLUDED.version, previous_version = EXCLUDED.previous_version,
			percent = EXCLUDED.percent, updated_at = now()
		RETURNING updated_at`,
		rollout.Channel, rollout.Name, rollout.Version, rollout.PreviousVersion, rollout.Percent,
	).Scan(&rollout.UpdatedAt); err != nil {
		return Rollout{}, fmt.Errorf("registry: 写入制品期望状态失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Rollout{}, fmt.Errorf("registry: 提交灰度发布失败: %w", err)
	}
	return rollout, nil
}

// GetRollout returns a desired target only while the selected immutable
// artifact remains present in the Registry index. This keeps read surfaces
// from presenting a manually-corrupted row as a deployable release.
func (s *Store) GetRollout(ctx context.Context, channel, name string) (Rollout, error) {
	var rollout Rollout
	err := s.pool.QueryRow(ctx, `
		SELECT r.channel, r.name, r.version, r.previous_version, r.percent, r.updated_at
		FROM registry_rollouts r
		JOIN registry_artifacts a ON a.name = r.name AND a.version = r.version
		LEFT JOIN registry_artifacts previous ON previous.name = r.name AND previous.version = r.previous_version
		WHERE r.channel = $1 AND r.name = $2 AND (r.previous_version = '' OR previous.name IS NOT NULL)`, channel, name,
	).Scan(&rollout.Channel, &rollout.Name, &rollout.Version, &rollout.PreviousVersion, &rollout.Percent, &rollout.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Rollout{}, ErrNotFound
	}
	if err != nil {
		return Rollout{}, fmt.Errorf("registry: 查询制品期望状态失败: %w", err)
	}
	return rollout, nil
}

// ListRollouts is a desired-state read model. It is deliberately separate
// from ListInstallations: an empty desired list does not imply that a node has
// uninstalled anything, and a desired target does not imply any node reached it.
func (s *Store) ListRollouts(ctx context.Context, channel string, limit int) ([]Rollout, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.channel, r.name, r.version, r.previous_version, r.percent, r.updated_at
		FROM registry_rollouts r
		JOIN registry_artifacts a ON a.name = r.name AND a.version = r.version
		LEFT JOIN registry_artifacts previous ON previous.name = r.name AND previous.version = r.previous_version
		WHERE r.channel = $1 AND (r.previous_version = '' OR previous.name IS NOT NULL)
		ORDER BY r.updated_at DESC, r.name
		LIMIT $2`, channel, limit)
	if err != nil {
		return nil, fmt.Errorf("registry: 列出制品期望状态失败: %w", err)
	}
	defer rows.Close()
	rollouts := make([]Rollout, 0)
	for rows.Next() {
		var rollout Rollout
		if err := rows.Scan(&rollout.Channel, &rollout.Name, &rollout.Version, &rollout.PreviousVersion, &rollout.Percent, &rollout.UpdatedAt); err != nil {
			return nil, fmt.Errorf("registry: 扫描制品期望状态失败: %w", err)
		}
		rollouts = append(rollouts, rollout)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("registry: 遍历制品期望状态失败: %w", err)
	}
	return rollouts, nil
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
	if m.PayloadDigest != "" {
		payload, err := s.objs.Get(ctx, m.PayloadDigest)
		if err != nil {
			return nil, fmt.Errorf("registry: 读取 payload %s 失败: %w", m.PayloadDigest, err)
		}
		parsed, err := bundle.Decode(payload)
		if err != nil {
			return nil, fmt.Errorf("registry: payload %s 非法: %w", m.PayloadDigest, err)
		}
		if parsed.Header.Bundle != m.Name || parsed.Header.Version != m.Version {
			return nil, fmt.Errorf("registry: payload header %s@%s 与 manifest %s@%s 不一致", parsed.Header.Bundle, parsed.Header.Version, m.Name, m.Version)
		}
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
		SELECT name, version, kind, publisher, digest, sig, scopes, requires, published_at
		  FROM registry_artifacts WHERE name = $1 AND version = $2`,
		name, version).Scan(&r.Name, &r.Version, &kind, &r.Publisher, &r.Digest, &r.Sig, &r.Scopes, &reqJSON, &r.PublishedAt)
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

// ListLatest 按制品名列出最新发布版本。它是目录浏览 API 的索引数据源，
// 不能被安装器用于权限或兼容性执法；那些判断必须走 plan 并重新解析签名字节。
func (s *Store) ListLatest(ctx context.Context, limit int) ([]Record, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT name, version FROM (
			SELECT DISTINCT ON (name) name, version, published_at
			  FROM registry_artifacts
			 ORDER BY name, published_at DESC, version DESC
		) latest
		ORDER BY name
		LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("registry: 列举目录失败: %w", err)
	}
	defer rows.Close()

	out := make([]Record, 0)
	for rows.Next() {
		var name, version string
		if err := rows.Scan(&name, &version); err != nil {
			return nil, err
		}
		r, err := s.Get(ctx, name, version)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
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
