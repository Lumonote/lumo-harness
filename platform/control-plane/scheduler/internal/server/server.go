// Package server 调度服务 HTTP API。
//
// 身份经网关注入头传递（collaborator 同款）：X-Lumo-Realm 必填，
// 生产形态下边缘网关完成认证并注入；本服务不自行签发凭证（§6.3）。
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// leaderState 本进程的领导权状态。
//
// 抽成接口只有一个目的：让测试能构造出「我是 leader」这一态。election.State 的
// 领导权只能由真实租约驱动，而收割循环要验证的是**拿到领导权之后**的行为
// （以及「不是 leader 时必须在碰库之前返回」这个次序），不是选举本身。
// 生产装配仍传 *election.State，New 的签名不变。
type leaderState interface {
	Current() *domain.Lease
	IsLeader() bool
}

// Server 调度服务 HTTP 层。
type Server struct {
	store        *store.Store
	elec         leaderState
	catalog      catalog.Catalog
	log          *slog.Logger
	controlToken string
	workers      catalog.WorkerDirectory

	// nodeMu / nodeSnap 缓存目录里的节点快照。见 metrics.go 的包注释：
	// /metrics 是抓取路径，不能在里面查目录，所以存活信息在这里缓存。
	nodeMu   sync.RWMutex
	nodeSnap nodeSnapshot

	// clusters / clusterThresholds / clusterEnforced 是联邦注册表的装配结果
	// （见 cluster.go）。enforced 表示**本实例参与判定**：闸门、自报与集群维度
	// 指标随之启停；上报与查询端点不受它影响。
	clusters          clusterDirectory
	clusterThresholds domain.ClusterThresholds
	clusterEnforced   bool
	// versionGate 版本一致性前置的生效开关（§7.4.1）。与 clusterEnforced 独立：
	// 它消费版本声明而不是存活年龄，且只拦**全局**任务。
	versionGate bool
	// placementWeights 偏好打分权重（见 domain.PlacementWeights）。零值时用默认值
	// （见 Weights），这样就地构造的测试 Server 不必关心它。
	placementWeights domain.PlacementWeights

	// localClusterID / clusterElec 是**降级放置**的装配（见 degradedPlacement）。
	// localClusterID 为空表示本实例没有集群身份——它无从判断「本地」是什么，因此
	// 无全局 leader 时对所有放置返回 503（也就是今天的行为，保持不变）。
	localClusterID string
	clusterElec    leaderState
	degraded       atomic.Int64
}

// SetPlacementWeights 装配偏好打分权重。
func (s *Server) SetPlacementWeights(w domain.PlacementWeights) { s.placementWeights = w }

func (s *Server) SetWorkerDirectory(directory catalog.WorkerDirectory) { s.workers = directory }

// SetClusterPlacement 装配本实例的集群身份与本地租约，从而启用**降级放置**。
//
// 不装配（clusterID 为空）时行为与今天完全一致：无全局 leader 即 503。
// 这不是保守，而是判据本身要求的——没有集群身份的实例无从判断「本地」是什么。
func (s *Server) SetClusterPlacement(clusterID string, local leaderState) {
	s.localClusterID = strings.TrimSpace(clusterID)
	s.clusterElec = local
}

// DegradedPlacements 降级期间成功放行的次数（指标用）。
func (s *Server) DegradedPlacements() int64 { return s.degraded.Load() }

// degradedPlacement 在没有全局租约时，判断这次放置能否走**本地**降级路径。
// 可以则返回本地租约，否则 nil（调用方照旧 503）。
//
// 三条判据缺一不可，每一条都对应一种「放行会比 503 更坏」的情形：
//
//	① 本实例有集群身份——没有身份就无从判断「本地」；
//	② 请求的目标集群 == 本实例的集群——跨集群放置是**真正的全局决策**，
//	   用本地锁去批准它会造出两个集群各自以为自己是决策者；
//	③ 本实例持有该集群的本地租约——**降级是换一把更小的锁，不是把锁拿掉**。
//	   没有这一条，同一集群的多个实例会同时放行，那正是 fencing 存在要防的事。
func (s *Server) degradedPlacement(targetCluster string) *domain.Lease {
	if s.localClusterID == "" || s.clusterElec == nil {
		return nil
	}
	if strings.TrimSpace(targetCluster) != s.localClusterID {
		return nil
	}
	lease := s.clusterElec.Current()
	if lease == nil {
		return nil
	}
	s.degraded.Add(1)
	return lease
}

// New 装配 HTTP 层。
// controlTokens is intentionally optional so existing in-process callers stay
// source-compatible. In deployed environments it carries the shared token
// expected by the execution node's /subagent/stop endpoint.
func New(st *store.Store, elec *election.State, cat catalog.Catalog, log *slog.Logger, controlTokens ...string) *Server {
	controlToken := ""
	if len(controlTokens) > 0 {
		controlToken = controlTokens[0]
	}
	return &Server{store: st, elec: elec, catalog: cat, log: log, controlToken: controlToken}
}

// Routes 路由表（Go 1.22+ 方法+通配语法）。
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("GET /v1/leader", s.handleLeader)
	mux.HandleFunc("GET /v1/nodes", s.handleNodes)
	mux.HandleFunc("POST /v1/placements", s.handlePlace)
	mux.HandleFunc("GET /v1/placements/{taskId}", s.handleGetPlacement)
	mux.HandleFunc("POST /v1/tasks/{taskId}/cancel", s.handleCancel)
	mux.HandleFunc("POST /v1/tasks/{taskId}/result", s.handleResult)
	mux.HandleFunc("POST /v1/nodes", s.handleUpsertNode)
	mux.HandleFunc("PUT /v1/clusters/{clusterId}", s.handleReportCluster)
	mux.HandleFunc("GET /v1/clusters", s.handleListClusters)
	mux.HandleFunc("GET /v1/clusters/{clusterId}", s.handleGetCluster)
	mux.HandleFunc("POST /v1/reconcile", s.handleReconcile)
	return mux
}

func (s *Server) handleNodes(w http.ResponseWriter, r *http.Request) {
	realm, ok := requestRealm(w, r)
	if !ok {
		return
	}
	nodes, err := s.catalog.List(r.Context())
	if err != nil {
		s.log.Error("列节点失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "列节点失败")
		return
	}
	visible := make([]domain.Node, 0, len(nodes))
	for _, node := range nodes {
		if node.Realm == realm {
			visible = append(visible, node)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": visible})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	s.publishSchedulerMetrics(r.Context())
	observability.Handler(w, nil)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleLeader(w http.ResponseWriter, _ *http.Request) {
	if l := s.elec.Current(); l != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"holder": l.Holder, "fencing_token": l.FencingToken, "expires_at": l.ExpiresAt,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"holder": nil})
}

// placeRequest 放置请求体。
type placeRequest struct {
	TaskID     string               `json:"task_id"`
	WorkerID   string               `json:"worker_id"`
	ProjectID  string               `json:"project_id"`
	ClusterID  string               `json:"cluster_id"`
	Requires   []domain.Requirement `json:"requires"`
	Priority   int                  `json:"priority"`
	Residency  string               `json:"residency"`
	DeadlineMS int64                `json:"deadline_ms"`
	Queue      string               `json:"queue"`
	Weight     int                  `json:"weight"`
	AvoidNodes []string             `json:"avoid_nodes"`
	// PreferredClusters 软集群偏好：只影响候选排序，不做硬绑定（ClusterID 才是硬绑定）。
	PreferredClusters []string `json:"preferred_clusters"`
}

func (s *Server) handlePlace(w http.ResponseWriter, r *http.Request) {
	realm, ok := requestRealm(w, r)
	if !ok {
		return
	}
	var req placeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.TaskID == "" {
		writeError(w, http.StatusBadRequest, "bad-request", "请求体非法或缺少 task_id")
		return
	}
	task := domain.Task{
		TaskID: req.TaskID, Realm: realm, ClusterID: req.ClusterID,
		WorkerID: req.WorkerID, ProjectID: req.ProjectID,
		Requires: req.Requires, Priority: req.Priority, Residency: req.Residency,
		DeadlineMS: req.DeadlineMS, Queue: req.Queue, Weight: req.Weight, AvoidNodes: req.AvoidNodes,
		PreferredClusters: req.PreferredClusters,
	}
	if prior, err := s.store.ExistingPlacement(r.Context(), task); err != nil {
		s.respondStoreError(w, err)
		return
	} else if prior != nil {
		writeJSON(w, http.StatusCreated, prior)
		return
	}
	// New placement requires a decision-maker and a current directory.
	//
	// 首选全局租约（跨集群唯一决策者）。它不在时，本集群的任务仍可**本地**放置——
	// 「本集群的任务落在本集群的节点上」本来就不需要任何跨集群信息（architecture §7.4.1
	// 的降级曲线）。但它不是「没 leader 就放行」：degradedPlacement 要求本实例有集群身份、
	// 目标集群就是它、且它持有该集群的本地租约——**换一把更小的锁，而不是把锁拿掉**。
	lease := s.elec.Current()
	degraded := false
	if lease == nil {
		lease = s.degradedPlacement(req.ClusterID)
		degraded = lease != nil
		if degraded {
			s.log.Warn("全局调度不可用，使用集群本地租约放置", "cluster_id", s.localClusterID, "task_id", req.TaskID)
		}
	}
	if lease == nil {
		writeError(w, http.StatusServiceUnavailable, "no-leader", "当前无 leader，请稍后重试")
		return
	}

	nodes, err := s.catalog.List(r.Context())
	if err != nil {
		s.log.Error("列节点失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "列节点失败")
		return
	}
	active, err := s.store.ActiveCounts(r.Context())
	if err != nil {
		s.log.Error("活跃计数失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "活跃计数失败")
		return
	}

	nodes, err = s.workers.Filter(r.Context(), task, nodes)
	if err != nil {
		s.log.Warn("Worker 设备目录不可用", "worker_id", task.WorkerID, "err", err)
		writeError(w, http.StatusServiceUnavailable, "worker-directory-unavailable", "无法确认执行者设备范围")
		return
	}
	s.PreparePlacement(r.Context(), []*domain.Task{&task})
	n := s.PickPrepared(r.Context(), task, nodes, active)
	if n == nil {
		s.queueAndMaybePreempt(w, r, lease, task, nodes)
		return
	}

	if err := s.store.SyncNodeSnapshot(r.Context(), *n); err != nil {
		s.log.Error("同步节点快照失败", "node_id", n.NodeID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "同步节点快照失败")
		return
	}
	p, err := s.store.PlaceTask(r.Context(), lease, task, n.NodeID)
	var ncap *domain.NoCapacityError
	if errors.As(err, &ncap) {
		// 规划后槽位被并发占用：转排队（罕见路径，drain 会接续）
		s.queueAndMaybePreempt(w, r, lease, task, nodes)
		return
	}
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	// 放置成功说明版本闸门这一刻没有拦住东西，清掉跃迁标记让下一次被拦重新打一条
	// 日志——否则「被拦 → 恢复 → 又被拦」只有第一条会被说出来。
	clearVersionBlock()
	if degraded {
		// 调用方要能区分「正常放置」与「降级放置」：两者的可用性含义不同，而响应体
		// 长得一样时，只有指标在动，读响应的人看不出这一次是降级——而「这次放置是在
		// 全局决策者缺席时做的」正是他需要知道的事。
		// 匿名嵌入而不是改 domain.Placement：那是任务侧也在消费的 wire 契约，
		// 为一个只在这一条路径上出现的字段改它，等于让所有消费方都跟着动。
		writeJSON(w, http.StatusCreated, struct {
			domain.Placement
			Degraded bool `json:"degraded"`
		}{Placement: p, Degraded: true})
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

// queueAndMaybePreempt durably accepts work before considering preemption. A
// successful stop request only changes the victim to CANCELLING; the new task
// remains PENDING until the execution node reports a terminal result and the
// leader drain loop obtains the released slot.
func (s *Server) queueAndMaybePreempt(w http.ResponseWriter, r *http.Request, lease *domain.Lease, task domain.Task, nodes []domain.Node) {
	state, err := s.store.QueueTask(r.Context(), lease, task)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if state != domain.StatePending {
		placement, err := s.store.GetPlacement(r.Context(), task.TaskID)
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, placement)
		return
	}
	response := map[string]any{"task_id": task.TaskID, "state": state}
	if state == domain.StatePending {
		if victim, err := s.requestPreemption(r, task, nodes); err != nil {
			// Queuing succeeded, so a transient control-plane failure must not be
			// presented as a failed submission. The durable pending state remains
			// eligible for a later normal drain or future preemption request.
			s.log.Warn("抢占停止请求未送达", "task_id", task.TaskID, "err", err)
		} else if victim != "" {
			response["preemption_requested_task_id"] = victim
		}
	}
	writeJSON(w, http.StatusAccepted, response)
}

// requestPreemption only targets a lower-priority task within the same realm
// and only on a hard-constraint-compatible node that is still full. It shares
// the exact node stop protocol used for an explicit cancellation and never
// returns a false ABORTED state.
func (s *Server) requestPreemption(r *http.Request, waiting domain.Task, nodes []domain.Node) (string, error) {
	active, err := s.store.ActiveCounts(r.Context())
	if err != nil {
		return "", err
	}
	full := planner.FullEligibleNodes(waiting, nodes, active)
	if len(full) == 0 {
		return "", nil
	}
	nodeIDs := make([]string, 0, len(full))
	for _, node := range full {
		// The final victim query uses the transactional node snapshot for its
		// capacity recheck. Refresh each candidate from the authoritative
		// catalog before asking it to free a slot.
		if err := s.store.SyncNodeSnapshot(r.Context(), node); err != nil {
			return "", err
		}
		nodeIDs = append(nodeIDs, node.NodeID)
	}
	victim, err := s.store.FindPreemptionVictim(r.Context(), waiting, nodeIDs)
	if err != nil || victim == nil {
		return "", err
	}
	started, err := s.store.RecordPreemptionIntent(r.Context(), victim.TaskID, victim.Attempt, waiting.TaskID)
	if err != nil || !started {
		return "", err
	}
	node, err := s.controlNode(r.Context(), waiting.Realm, victim.NodeID)
	if err != nil {
		_ = s.store.MarkPreemptionDeliveryFailed(r.Context(), victim.TaskID, err.Error())
		return "", err
	}
	if err := s.requestStop(r, node, waiting.Realm, victim.TaskID); err != nil {
		_ = s.store.MarkPreemptionDeliveryFailed(r.Context(), victim.TaskID, err.Error())
		return "", err
	}
	p, err := s.store.ConfirmPreemption(r.Context(), victim.TaskID, victim.Attempt)
	if err != nil {
		return "", err
	}
	if p.Attempt != victim.Attempt || p.State != domain.StateCancelling {
		// The task completed or retried while the control RPC was in flight.
		// It would be dishonest to claim a preemption in this response.
		return "", nil
	}
	return victim.TaskID, nil
}

func (s *Server) handleGetPlacement(w http.ResponseWriter, r *http.Request) {
	realm, ok := requestRealm(w, r)
	if !ok {
		return
	}
	p, err := s.store.GetPlacement(r.Context(), r.PathValue("taskId"))
	var nf *domain.TaskNotFoundError
	if errors.As(err, &nf) {
		writeError(w, http.StatusNotFound, "task-not-found", nf.Error())
		return
	}
	if err != nil {
		s.log.Error("查询放置失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "查询放置失败")
		return
	}
	if p.Realm != realm {
		writeError(w, http.StatusNotFound, "task-not-found", "任务不存在")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// handleCancel first asks the exact execution node that owns the placement to
// stop. Only after the node acknowledges the request do we persist CANCELLING.
// This deliberately prevents a control-plane/UI request from falsely claiming
// that already-running work was cancelled.
func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	realm, ok := requestRealm(w, r)
	if !ok {
		return
	}
	taskID := r.PathValue("taskId")
	current, err := s.store.GetPlacement(r.Context(), taskID)
	var nf *domain.TaskNotFoundError
	if errors.As(err, &nf) {
		writeError(w, http.StatusNotFound, "task-not-found", nf.Error())
		return
	}
	if err != nil {
		s.log.Error("读取待取消任务失败", "task_id", taskID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "读取任务失败")
		return
	}
	if current.Realm != realm {
		writeError(w, http.StatusNotFound, "task-not-found", "任务不存在")
		return
	}
	if err := s.store.RecordCancelIntent(r.Context(), taskID); err != nil {
		s.log.Error("持久化取消命令失败", "task_id", taskID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "无法持久化取消命令")
		return
	}

	if current.State == domain.StatePlaced || current.State == domain.StateRunning {
		node, err := s.controlNode(r.Context(), realm, current.NodeID)
		if err != nil {
			if markErr := s.store.MarkCancelDeliveryFailed(r.Context(), taskID, err.Error()); markErr != nil {
				s.log.Warn("记录取消命令失败状态失败", "task_id", taskID, "err", markErr)
			}
			s.log.Warn("取消请求没有可用执行节点", "task_id", taskID, "node_id", current.NodeID, "err", err)
			writeError(w, http.StatusServiceUnavailable, "cancel-unavailable", "执行节点不可用，未记录取消状态")
			return
		}
		if err := s.requestStop(r, node, realm, taskID); err != nil {
			if markErr := s.store.MarkCancelDeliveryFailed(r.Context(), taskID, err.Error()); markErr != nil {
				s.log.Warn("记录取消命令失败状态失败", "task_id", taskID, "err", markErr)
			}
			s.log.Warn("执行节点拒绝取消请求", "task_id", taskID, "node_id", current.NodeID, "err", err)
			writeError(w, http.StatusServiceUnavailable, "cancel-failed", "执行节点未确认停止，未记录取消状态")
			return
		}
	}

	p, err := s.store.RequestCancel(r.Context(), taskID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if p.State == domain.StateCancelling {
		writeJSON(w, http.StatusAccepted, p)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) controlNode(ctx context.Context, realm, nodeID string) (domain.Node, error) {
	nodes, err := s.catalog.List(ctx)
	if err != nil {
		return domain.Node{}, err
	}
	for _, node := range nodes {
		if node.NodeID == nodeID && node.Realm == realm && strings.TrimSpace(node.ControlURL) != "" {
			return node, nil
		}
	}
	return domain.Node{}, errors.New("node is absent from the control catalog")
}

func (s *Server) requestStop(r *http.Request, node domain.Node, realm, taskID string) error {
	payload, err := json.Marshal(map[string]string{"childId": taskID})
	if err != nil {
		return err
	}
	endpoint := strings.TrimRight(node.ControlURL, "/") + "/subagent/stop"
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lumo-Realm", realm)
	if s.controlToken != "" {
		req.Header.Set("X-Lumo-Seam-Token", s.controlToken)
	}
	res, err := observability.ConfiguredHTTPClient(10 * time.Second).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < http.StatusOK || res.StatusCode >= http.StatusMultipleChoices {
		return errors.New("execution node returned HTTP " + res.Status)
	}
	return nil
}

// resultRequest 终态回报体。
type resultRequest struct {
	State   domain.TaskState `json:"state"`
	Attempt int              `json:"attempt"`
}

func (s *Server) handleResult(w http.ResponseWriter, r *http.Request) {
	realm, ok := requestRealm(w, r)
	if !ok {
		return
	}
	var req resultRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !req.State.Terminal() {
		writeError(w, http.StatusBadRequest, "bad-request", "state 必须是 COMPLETED/FAILED/ABORTED")
		return
	}
	current, err := s.store.GetPlacement(r.Context(), r.PathValue("taskId"))
	var beforeNotFound *domain.TaskNotFoundError
	if errors.As(err, &beforeNotFound) {
		writeError(w, http.StatusNotFound, "task-not-found", beforeNotFound.Error())
		return
	}
	if err != nil {
		s.log.Error("读取任务 realm 失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "读取任务失败")
		return
	}
	if current.Realm != realm {
		writeError(w, http.StatusNotFound, "task-not-found", "任务不存在")
		return
	}
	p, err := s.store.CompleteTaskAttempt(r.Context(), r.PathValue("taskId"), req.Attempt, req.State)
	var nf *domain.TaskNotFoundError
	if errors.As(err, &nf) {
		writeError(w, http.StatusNotFound, "task-not-found", nf.Error())
		return
	}
	if err != nil {
		s.log.Error("回报终态失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "回报终态失败")
		return
	}
	if req.Attempt > 0 && p.Attempt == req.Attempt {
		if err := s.store.AckDispatch(r.Context(), r.PathValue("taskId"), req.Attempt); err != nil {
			s.log.Warn("确认派发失败", "task_id", r.PathValue("taskId"), "err", err)
		}
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleUpsertNode(w http.ResponseWriter, r *http.Request) {
	realm, ok := requestRealm(w, r)
	if !ok {
		return
	}
	var n domain.Node
	if err := json.NewDecoder(r.Body).Decode(&n); err != nil || n.NodeID == "" || n.ClusterID == "" || n.Capacity < 1 {
		writeError(w, http.StatusBadRequest, "bad-request", "node_id/cluster_id 必填且 capacity ≥ 1")
		return
	}
	n.Realm = realm
	// 节点登记不是放置决策，无需 leader（本地形态；生产走 Nacos Naming，不经此端点）
	if err := s.catalog.Upsert(r.Context(), n); err != nil {
		s.log.Error("登记节点失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "登记节点失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"node_id": n.NodeID})
}

// reconcileRequest 对账请求体（占位语义，spec §6）。
type reconcileRequest struct {
	Entries []store.ReconcileEntry `json:"entries"`
}

func (s *Server) handleReconcile(w http.ResponseWriter, r *http.Request) {
	realm, ok := requestRealm(w, r)
	if !ok {
		return
	}
	lease := s.elec.Current()
	if lease == nil {
		writeError(w, http.StatusServiceUnavailable, "no-leader", "当前无 leader，快速失败")
		return
	}
	var req reconcileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad-request", "请求体非法")
		return
	}
	recorded, err := s.store.ReconcileRealm(r.Context(), lease, realm, req.Entries)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recorded": recorded})
}

func requestRealm(w http.ResponseWriter, r *http.Request) (string, bool) {
	realm := r.Header.Get("X-Lumo-Realm")
	if realm == "" {
		writeError(w, http.StatusBadRequest, "missing-realm", "缺少网关注入的 X-Lumo-Realm 头")
		return "", false
	}
	return realm, true
}

// respondStoreError 领域错误 → HTTP 状态映射（spec §6 表）。
func (s *Server) respondStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrTaskIdentityConflict) {
		writeError(w, http.StatusConflict, "task-identity-conflict", "任务标识已绑定到其他执行身份")
		return
	}
	var fo *domain.FencedOutError
	if errors.As(err, &fo) {
		writeError(w, http.StatusServiceUnavailable, "fenced-out", "本节点已失去领导权，请向新 leader 重交")
		return
	}
	s.log.Error("调度操作失败", "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "调度操作失败")
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, codeStr, msg string) {
	writeJSON(w, code, map[string]string{"error": codeStr, "message": msg})
}
