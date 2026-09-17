// 联邦注册表的服务端面（§7.4.1）：注册/自报、查询，以及本实例的自报循环。
//
// 为什么注册表要有自己的端点而不是复用节点注册：集群存活与「这台机器还在报」是
// 两件事。Nacos 目录只返回健康实例，所以失联集群的节点会**静默消失**，目录里
// 「没有它的节点」同时也是「这个集群从未部署过」的样子——目录原理上回答不了
// 「挂了还是没部署」。
//
// 端点始终可用，与本实例是否参与判定无关：PUT/GET /v1/clusters 是**别的集群**上报
// 与被查的入口。关掉本实例的判定不会让上报失败，否则一次配置变更就变成了上游故障。
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// defaultClusterReportInterval 兜底自报周期。正常路径由阈值派生
// （domain.ClusterThresholds.ReportInterval），这里只在调用方没给周期时使用。
const defaultClusterReportInterval = 10 * time.Second

// clusterDirectory 联邦注册表的读写面。生产实现是 *store.Store。
//
// 抽成接口是为了让 handler 的契约测试可以不依赖数据库（同 leaderState 与
// catalog.WorkerDirectory 的做法）：这些用例要验证的是**响应形状与状态码**，
// 不是 SQL。
type clusterDirectory interface {
	RegisterCluster(ctx context.Context, c domain.Cluster) (domain.Cluster, error)
	ClusterAges(ctx context.Context) ([]domain.Cluster, error)
	ClusterByID(ctx context.Context, clusterID string) (domain.Cluster, error)
}

// SetClusterRegistry 装配联邦注册表。
//
// 三个角色被同一个开关（LUMO_SCHEDULER_CLUSTER_ID）驱动，但只有两个随它启停：
// 上报/查询接口始终可用，自报循环、放置闸门与集群维度指标只在本实例参与判定
// （enforce）时生效。半开的注册表是自伤——闸门开着而没有任何上报方时，所有集群
// 都会走到 down，把所有节点挡在放置之外。
// versionGate 是**第二个**独立开关（LUMO_CLUSTER_VERSION_GATE）：它消费注册表里的
// 版本声明而不是存活年龄，失效形态也不同（版本分叉只拦**全局**任务，不会让集群一起
// down）。合成一个开关会让「只想拦版本不一致」的部署被迫连存活闸门一起开——那是把
// 一个部署决策偷换成另一个。
func (s *Server) SetClusterRegistry(dir clusterDirectory, t domain.ClusterThresholds, enforce, versionGate bool) {
	s.clusters, s.clusterThresholds, s.clusterEnforced, s.versionGate = dir, t, enforce, versionGate
}

// clusterReport 自报体。字段全部可选：一个纯心跳（空体）也必须是合法的，
// 否则上报方会被迫每次都重发一份可能过期的元数据。
//
// Capabilities 用**指针**而不是值类型：注册表的口径是「省略即保持原值」，
// 而「省略」与「声明了一个空值」必须分得开——`"capabilities": []` 是一次**声明**
// （把集合清空），缺席才是「不动」。用值类型接它时两者都会变成零值，于是
// 「显式清空」会被静默当成「没给」，而空能力集是一个真实约束（见 domain.Cluster）。
//
// Version 同样用指针，但**不是为了分「声明空集」与「没声明」**——空版本号不是一种
// 有意义的声明，两者本就等价（见 domain.Cluster.Version）。用指针纯粹是为了不让
// 缺席被当成 `""` 去覆盖：值类型的零值恰好等于「省略」，行为上没错，但读代码的人
// 会以为这里有三种状态，而实际只有两种。
type clusterReport struct {
	Namespace    string    `json:"namespace"`
	Capabilities *[]string `json:"capabilities"`
	Version      *string   `json:"version"`
}

// handleReportCluster 注册或刷新一个集群（PUT /v1/clusters/{clusterId}）。
//
// 幂等：既是首次注册，也是心跳。realm 取自网关注入的身份而不是请求体——
// 让请求体声明 realm 等于让调用方自选隔离域。
func (s *Server) handleReportCluster(w http.ResponseWriter, r *http.Request) {
	realm, ok := requestRealm(w, r)
	if !ok {
		return
	}
	if s.clusters == nil {
		writeError(w, http.StatusServiceUnavailable, "cluster-registry-unavailable", "本实例未装配联邦注册表")
		return
	}
	clusterID := strings.TrimSpace(r.PathValue("clusterId"))
	if clusterID == "" {
		writeError(w, http.StatusBadRequest, "bad-request", "缺少 cluster_id")
		return
	}
	var req clusterReport
	// 空体（io.EOF）是合法的纯心跳；其余解码失败是坏请求。
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "bad-request", "请求体非法")
		return
	}
	c, err := s.clusters.RegisterCluster(r.Context(), domain.Cluster{
		ClusterID: clusterID, Realm: realm, Namespace: req.Namespace,
		Capabilities: declaredCapabilities(req.Capabilities), CapabilitiesDeclared: req.Capabilities != nil,
		Version: declaredVersion(req.Version),
	})
	if errors.Is(err, store.ErrClusterRealmConflict) {
		writeError(w, http.StatusConflict, "cluster-realm-conflict",
			"该 cluster_id 已属于另一个 realm，拒绝跨域覆盖")
		return
	}
	if err != nil {
		s.log.Error("注册集群失败", "cluster_id", clusterID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "注册集群失败")
		return
	}
	writeJSON(w, http.StatusOK, s.evaluated(c))
}

// handleListClusters 列出全部已注册集群及其派生状态（GET /v1/clusters）。
//
// 不做 realm 过滤：集群是基础设施事实而不是租户数据，而且被过滤掉的集群仍然在
// **全局限定放置**——把它藏起来会让「为什么这个集群的任务排不进去」无从查起。
// 本组端点整体在控制面令牌之后，realm 不是这里的鉴权边界（令牌才是）。
func (s *Server) handleListClusters(w http.ResponseWriter, r *http.Request) {
	if _, ok := requestRealm(w, r); !ok {
		return
	}
	if s.clusters == nil {
		writeError(w, http.StatusServiceUnavailable, "cluster-registry-unavailable", "本实例未装配联邦注册表")
		return
	}
	clusters, err := s.clusters.ClusterAges(r.Context())
	if err != nil {
		s.log.Error("列集群失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "列集群失败")
		return
	}
	out := make([]domain.Cluster, 0, len(clusters))
	for _, c := range clusters {
		out = append(out, s.evaluated(c))
	}
	// 版本一致性是**集合级**结论，必须与集群列表一并返回：只给每个集群的 version
	// 字段，读的人无从知道闸门会怎么裁——「A 报 v1、B 报 v2」是分叉，而
	// 「A 报 v1、B 什么都没说」在列表上看起来是同一件事，闸门却都拦。
	vc := domain.EvaluateVersionConsistency(clusters, s.clusterThresholds, s.clusterEnforced)
	writeJSON(w, http.StatusOK, map[string]any{
		"clusters": out,
		// enforced 与阈值一并返回：状态是「年龄 + 阈值」派生出来的，只给状态
		// 会让读的人无从判断这些阈值是哪一档，也无从知道本实例有没有在按它拦放置。
		"enforced":   s.clusterEnforced,
		"suspect_ms": s.clusterThresholds.SuspectMS,
		"down_ms":    s.clusterThresholds.DownMS,
		// version_gate 是生效的开关，fleet_version / version_consistent /
		// version_declared_clusters 是它的输入与结论。三者都要给：
		// 「闸门开着但没人声明版本」与「闸门开着且版本一致」在只看开关时一模一样，
		// 而前者意味着闸门一分钱的作用都没起（同 cluster-registry-check 的判据）。
		"version_gate":              s.versionGate,
		"fleet_version":             vc.FleetVersion,
		"version_consistent":        vc.Consistent,
		"version_declared_clusters": vc.Declared,
	})
}

// declaredCapabilities / declaredVersion 把指针解码结果还原成值。
//
// nil（字段缺席或显式 null）→ 零值 + Declared=false，即「不动原值」；
// 非 nil → 原样传递，Declared=true，即「这是一次声明」。
//
// 版本的额外一条：空字符串**不是**一种版本声明（`"version": ""` 在协议上就是
// 「没给」）。归一成未声明之后，「声明了空版本」不会变成一个谁都比不上的版本值
// 把全局放置整片拦掉。同一条归一也写在 store.RegisterCluster 里（唯一的写路径），
// 两处都做是因为这里能保住「响应里 declared 与值一致」这个可观察的性质。
func declaredCapabilities(v *[]string) []string {
	if v == nil {
		return nil
	}
	return *v
}

// declaredVersion 把指针解码结果还原成值。
//
// nil（字段缺席或显式 null）与 `""` 都归一成空串，即「这一次没说版本」——空版本号
// 不是一种有意义的声明（见 domain.Cluster.Version）。归一在这里与 store 的
// `CASE WHEN EXCLUDED.version = ”` 是同一条规则的两次表达：**任何**空版本都必须
// 走「保持原值」，而不是只在某个调用方记得时才是。
//
// 历史：这里曾经还有一个 declaredVersionFlag 配套函数（`v != nil && *v != ""`），
// 给 domain 上一个对称的 VersionDeclared 字段用。那个字段是冗余的，代价见
// domain.Cluster.Version —— 别再把它加回来。
func declaredVersion(v *string) string {
	if v == nil {
		return ""
	}
	return strings.TrimSpace(*v)
}

// handleGetCluster 读单个集群（GET /v1/clusters/{clusterId}）。
//
// 「不在注册表里」与「已注册但失联」必须报成两件事：前者是配置事实（重试无用），
// 后者是故障。同 E4/D6 的 403/503 之分——报错了会让人去改配置而真问题是服务挂了。
func (s *Server) handleGetCluster(w http.ResponseWriter, r *http.Request) {
	if _, ok := requestRealm(w, r); !ok {
		return
	}
	if s.clusters == nil {
		writeError(w, http.StatusServiceUnavailable, "cluster-registry-unavailable", "本实例未装配联邦注册表")
		return
	}
	c, err := s.clusters.ClusterByID(r.Context(), strings.TrimSpace(r.PathValue("clusterId")))
	if errors.Is(err, store.ErrClusterNotRegistered) {
		writeError(w, http.StatusNotFound, "cluster-not-registered",
			"该集群不在联邦注册表中：没有任何实例为它自报过（配置事实，重试无用）")
		return
	}
	if err != nil {
		s.log.Error("查询集群失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "查询集群失败")
		return
	}
	writeJSON(w, http.StatusOK, s.evaluated(c))
}

// evaluated 填上派生状态。状态不入库（见 domain.ClusterState 的注释），
// 唯一被存下来的是自报时刻，所以每次出站前都要现算一次。
func (s *Server) evaluated(c domain.Cluster) domain.Cluster {
	c.State = s.clusterThresholds.Evaluate(c.AgeMS)
	return c
}

// ClusterIdentity 本实例代表的集群（自报内容）。
type ClusterIdentity struct {
	ClusterID string
	Realm     string
	Namespace string
	// Version 本实例替这个集群声明的版本（LUMO_CLUSTER_VERSION）。空=不声明。
	//
	// 它是版本一致性前置（§7.4.1）的**唯一输入**。留空的后果与「版本分叉」不同但
	// 同样值得说清：所有集群都留空时闸门没有可比的东西，于是恒放行——闸门看起来
	// 开着，实际上一分作用都没起。`cluster-registry-check.py` 专门有一条静态规则
	// 抓这个组合（闸门开 + 整个拓扑没人声明版本）。
	Version string
	// Capabilities 本实例替这个集群声明的能力。**刻意不从这里报**：
	// 能力是**节点**的属性而不是**集群**的属性，把它当集群能力报上去是范畴错误
	// （同 dsh-node/cluster-reporter.ts 的「不声明集群能力」）。保留字段是为了让
	// 「注册表里那条 capabilities 是谁写的」有唯一答案：集群侧。
	Capabilities []string
}

// clusterMetadata 把身份转成注册请求体。
//
// 本实例的版本为空时是**不声明**——一台没配 LUMO_CLUSTER_VERSION 的调度器不该把
// 别人声明的版本清掉。这条不需要额外的标记：空版本号在 domain 里就是「没说」
// （见 domain.Cluster.Version），store 的 `CASE WHEN EXCLUDED.version = ”` 与它
// 是同一条规则的两次表达。
func (id ClusterIdentity) clusterMetadata() domain.Cluster {
	return domain.Cluster{
		ClusterID: id.ClusterID, Realm: id.Realm, Namespace: id.Namespace,
		Version: strings.TrimSpace(id.Version),
		// 能力是**节点**的属性，集群侧才是它的声明方（见 Capabilities 字段注释）。
		Capabilities: id.Capabilities, CapabilitiesDeclared: false,
	}
}

// RunClusterReporter 周期性为本实例代表的集群自报存活，直到 ctx 结束。
//
// 只在配置了集群身份时调用（见 main）：没有上报方的注册表会让所有集群走向 down，
// 而闸门随即挡掉全部放置——那是自伤，不是「功能未生效」。
//
// 失败只做**状态跃迁**日志（首次失败一条 Error、恢复时一条 Info），不每轮都打：
// 周期是秒级的，逐轮刷屏会让真正要看的那条被埋掉，而这条恰恰是「本集群马上会被
// 判成 down」的预警。
func (s *Server) RunClusterReporter(ctx context.Context, id ClusterIdentity, interval time.Duration) {
	if s.clusters == nil {
		s.log.Error("集群自报未启动：联邦注册表未装配", "cluster_id", id.ClusterID)
		return
	}
	if interval <= 0 {
		interval = defaultClusterReportInterval
	}
	failing := false
	report := func() {
		_, err := s.clusters.RegisterCluster(ctx, id.clusterMetadata())
		switch {
		case err != nil && !failing:
			failing = true
			s.log.Error("集群自报失败：本集群将被判成可疑/下线，新放置会被闸门拒绝",
				"cluster_id", id.ClusterID, "err", err)
		case err == nil && failing:
			failing = false
			s.log.Info("集群自报已恢复", "cluster_id", id.ClusterID)
		}
	}
	report()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			report()
		}
	}
}
