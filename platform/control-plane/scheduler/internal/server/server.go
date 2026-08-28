// Package server 调度服务 HTTP API。
//
// 身份经网关注入头传递（collaborator 同款）：X-Lumo-Realm 必填，
// 生产形态下边缘网关完成认证并注入；本服务不自行签发凭证（§6.3）。
package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// Server 调度服务 HTTP 层。
type Server struct {
	store   *store.Store
	elec    *election.State
	catalog catalog.Catalog
	log     *slog.Logger
}

// New 装配 HTTP 层。
func New(st *store.Store, elec *election.State, cat catalog.Catalog, log *slog.Logger) *Server {
	return &Server{store: st, elec: elec, catalog: cat, log: log}
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
	mux.HandleFunc("POST /v1/tasks/{taskId}/result", s.handleResult)
	mux.HandleFunc("POST /v1/nodes", s.handleUpsertNode)
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
	if pending, err := s.store.PendingCount(r.Context()); err == nil {
		observability.SetGauge("lumo_scheduler_pending_tasks", float64(pending))
	} else {
		s.log.Warn("采集排队任务指标失败", "err", err)
	}
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
	ClusterID  string               `json:"cluster_id"`
	Requires   []domain.Requirement `json:"requires"`
	Priority   int                  `json:"priority"`
	Residency  string               `json:"residency"`
	DeadlineMS int64                `json:"deadline_ms"`
	Queue      string               `json:"queue"`
	Weight     int                  `json:"weight"`
	AvoidNodes []string             `json:"avoid_nodes"`
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
	// 降级语义（spec §6）：无 leader 快速失败，绝不挂起等待。
	lease := s.elec.Current()
	if lease == nil {
		writeError(w, http.StatusServiceUnavailable, "no-leader", "当前无 leader，请稍后重试")
		return
	}
	task := domain.Task{
		TaskID: req.TaskID, Realm: realm, ClusterID: req.ClusterID,
		Requires: req.Requires, Priority: req.Priority, Residency: req.Residency,
		DeadlineMS: req.DeadlineMS, Queue: req.Queue, Weight: req.Weight, AvoidNodes: req.AvoidNodes,
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

	n := planner.Pick(task, nodes, active)
	if n == nil {
		state, err := s.store.QueueTask(r.Context(), lease, task)
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"task_id": task.TaskID, "state": state})
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
		state, err2 := s.store.QueueTask(r.Context(), lease, task)
		if err2 != nil {
			s.respondStoreError(w, err2)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"task_id": task.TaskID, "state": state})
		return
	}
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
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
