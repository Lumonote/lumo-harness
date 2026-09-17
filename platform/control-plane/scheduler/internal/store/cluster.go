// 联邦注册表的持久化（§7.4.1）。
//
// 两个写入侧的约定必须写在这里，否则很容易在别处被顺手改掉：
//
//	① **时间一律库端。** registered_at / last_seen_at 都用写语句里的 now()，读的时候
//	   直接由 SQL 给出**年龄**（`nowMS - last_seen_at`），应用侧不做任何时钟相减。
//	   自报来自多台主机，拿读取方自己的时钟去减会引入无界偏差，产出任何测试都钉不住
//	   的 flake。这样切分还有个好处：「年龄 → 状态」在 domain 里是纯函数，无库可测。
//
//	② **只有一个写入方。** 存活列只由自报刷新（RegisterCluster）。刻意**不**在节点
//	   注册（catalog.Upsert）时顺手 touch 它：那会把「流量驱动的信号」伪装成自报，
//	   而空转集群恰恰没有流量——一次目录/流量抖动就会被判成失联，正是本设计否掉
//	   「从节点目录派生存活」的同一条理由。
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// ErrClusterNotRegistered 注册表里没有这个集群。
//
// 与「已注册但失联」必须分开报：前者是配置事实（重试无用，去补上报方），
// 后者是故障（去查那个集群）。同一条判据见 E4/D6：拒绝码要分永久与临时。
var ErrClusterNotRegistered = errors.New("scheduler: 集群不在联邦注册表中")

// ErrClusterRealmConflict 该 cluster_id 已属于另一个 realm。
//
// 集群 id 是全局主键，所以一次跨 realm 的同名注册会**覆盖**别人的记录。realm 来自
// 网关注入的身份，是这条端点上唯一可信的隔离依据（同 E7：隔离维度只信身份），
// 因此首次带 realm 的注册即为该集群归属，后来的不同 realm 一律拒绝而不是覆盖。
var ErrClusterRealmConflict = errors.New("scheduler: 集群已属于另一个 realm")

// RegisterCluster 注册或刷新一个集群（幂等）。
//
// 首次注册写入 registered_at；此后每次调用只刷新 last_seen_at，registered_at 保持
// 不动——「刚上线」与「注册了很久、一直在报」是两件不同的事，合并成一个时间戳就
// 再也分不出来。
//
// **元数据列（namespace / capabilities / version）的口径是「省略即保持原值」。**
// 空体是合法的纯心跳（见 server 的 clusterReport 注释），按「谁后写谁赢」处理会让
// 一次心跳把别人声明的元数据清空——而一个集群有**多个上报方**（调度实例与集群侧
// 节点各报各的），心跳远比声明频繁，于是「这个集群是什么样」将长期等于最后一次
// 心跳的空值。与 E8 的配置面写入口径同一条判据：可选字段一律按指针处理，省略不动。
//
// **「省略」与「声明了一个空值」靠 declared 标记区分——但只有 capabilities 需要它。**
// 此前 capabilities 是靠 `IN (”, '[]', 'null')` 反推「其实就是没给」，代价是
// **「声明空能力集」与「未声明」在协议上不可区分**（那一档差异当时无消费者，所以
// 记下了这笔账）。空能力集是一个真实约束（这个集群没有 GPU），所以这笔账必须还：
// `capabilities_declared` 成为显式列，且：
//
//   - **标记单调**（`OR`）：声明过就一直是声明过。心跳省略元数据**不撤销**声明——
//     否则「谁后写谁赢」会以另一种形式回来（一个心跳把 declared 翻回 false）。
//   - **值按标记走**：`NOT declared` 时保持原值，`declared` 时写入新值。
//     于是「显式声明空能力集」现在真的能把集合清空，而这是此前做不到的。
//
// **version 刻意没有配套标记。** 判据是「空值是不是一种有意义的声明」：空版本号不是，
// 所以「说没说版本」就是 `version <> ”` 本身。第一版按对称性也给它加了一列，代价是
// `RegisterCluster(Version: "v3")` 静默变成空操作（版本没写进去，返回值看起来正常），
// 且迁移默认 false 会把所有既有行判成「未声明」。详见 domain.Cluster.Version。
func (s *Store) RegisterCluster(ctx context.Context, c domain.Cluster) (domain.Cluster, error) {
	caps, err := json.Marshal(c.Capabilities)
	if err != nil {
		return domain.Cluster{}, fmt.Errorf("scheduler: 序列化集群能力失败: %w", err)
	}
	capsDeclared := c.CapabilitiesDeclared
	// 省略即保持：空版本号表示「这次没说版本」，于是保持原值。
	// 冲突分支的 WHERE 同时承担两件事：realm 已声明时不许被别的 realm 改写，
	// 而任一为空时放行（未声明 realm 不是一种归属）。条件不成立 → 不返回行 →
	// pgx.ErrNoRows，据此报 ErrClusterRealmConflict。
	row := s.pool.QueryRow(ctx, `
		INSERT INTO scheduler_clusters
			(cluster_id, realm, namespace, capabilities, capabilities_declared,
			 version, registered_at, last_seen_at)
		VALUES ($1, $2, $3, $4, $5, $6, `+nowMS+`, `+nowMS+`)
		ON CONFLICT (cluster_id) DO UPDATE SET
			namespace = CASE WHEN EXCLUDED.namespace = ''
				THEN scheduler_clusters.namespace ELSE EXCLUDED.namespace END,
			capabilities = CASE WHEN NOT EXCLUDED.capabilities_declared
				THEN scheduler_clusters.capabilities ELSE EXCLUDED.capabilities END,
			capabilities_declared = scheduler_clusters.capabilities_declared
				OR EXCLUDED.capabilities_declared,
			version = CASE WHEN EXCLUDED.version = ''
				THEN scheduler_clusters.version ELSE EXCLUDED.version END,
			realm = CASE WHEN scheduler_clusters.realm = ''
				THEN EXCLUDED.realm ELSE scheduler_clusters.realm END,
			last_seen_at = EXCLUDED.last_seen_at
		WHERE scheduler_clusters.realm = '' OR EXCLUDED.realm = ''
			OR scheduler_clusters.realm = EXCLUDED.realm
		RETURNING cluster_id, realm, namespace, capabilities, capabilities_declared,
			version, registered_at, last_seen_at,
			(`+nowMS+` - last_seen_at) AS age_ms`,
		c.ClusterID, c.Realm, c.Namespace, string(caps), capsDeclared,
		c.Version)
	out, err := scanCluster(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Cluster{}, fmt.Errorf("%w: cluster_id=%s 请求 realm=%s",
			ErrClusterRealmConflict, c.ClusterID, c.Realm)
	}
	if err != nil {
		return domain.Cluster{}, fmt.Errorf("scheduler: 注册集群失败: %w", err)
	}
	return out, nil
}

// ClusterAges 列出全部已注册集群，并带上**由库端时钟算出的**年龄。
//
// 年龄而不是时间戳：调用方（放置闸门、指标）只需要「多久没听到了」，让它拿到
// 绝对时刻就一定会有人想自己减一下——那正是跨主机时钟偏差进入判定路径的方式。
func (s *Store) ClusterAges(ctx context.Context) ([]domain.Cluster, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT cluster_id, realm, namespace, capabilities, capabilities_declared,
		       version, registered_at, last_seen_at,
		       (`+nowMS+` - last_seen_at) AS age_ms
		FROM scheduler_clusters
		ORDER BY cluster_id`)
	if err != nil {
		return nil, fmt.Errorf("scheduler: 列集群失败: %w", err)
	}
	defer rows.Close()
	out := make([]domain.Cluster, 0, 8)
	for rows.Next() {
		c, err := scanCluster(rows)
		if err != nil {
			return nil, fmt.Errorf("scheduler: 扫描集群失败: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ClusterByID 读单个集群；不存在时返回 ErrClusterNotRegistered。
//
// 年龄同样由 SQL 算：这个端点的全部价值就是「距上次自报多久」，让应用侧去减
// 等于把上面那条约定在第二个地方破一次。
func (s *Store) ClusterByID(ctx context.Context, clusterID string) (domain.Cluster, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT cluster_id, realm, namespace, capabilities, capabilities_declared,
		       version, registered_at, last_seen_at,
		       (`+nowMS+` - last_seen_at) AS age_ms
		FROM scheduler_clusters WHERE cluster_id = $1`, clusterID)
	c, err := scanCluster(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Cluster{}, fmt.Errorf("%w: cluster_id=%s", ErrClusterNotRegistered, clusterID)
	}
	if err != nil {
		return domain.Cluster{}, fmt.Errorf("scheduler: 查询集群失败: %w", err)
	}
	return c, nil
}

// scanCluster 扫描一行集群记录（含由 SQL 算出的 age_ms）。
func scanCluster(row pgx.Row) (domain.Cluster, error) {
	var c domain.Cluster
	var caps string
	if err := row.Scan(&c.ClusterID, &c.Realm, &c.Namespace, &caps, &c.CapabilitiesDeclared,
		&c.Version, &c.RegisteredAt, &c.LastSeenAt, &c.AgeMS); err != nil {
		return domain.Cluster{}, err
	}
	if err := json.Unmarshal([]byte(caps), &c.Capabilities); err != nil {
		return domain.Cluster{}, fmt.Errorf("解析集群 capabilities 失败: %w", err)
	}
	return c, nil
}
