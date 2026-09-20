package server

// 线程档位的 HTTP 面（§24.2）。协作服务是本表的唯一写入方，因此这里是**唯一**的写入口。
//
// 授权口径与文档面同训（见 server.go 的包注释）：**realm 由服务端从身份解析，不接受
// 客户端传参**。线程行的 body 里没有 realm 字段——就算有也会被忽略，因为一个能自报
// realm 的写入口等于没有租户边界。
//
// 这里不做任何状态判断：转移合法性、工作目录归属、节点丢失的处置结论全在
// `internal/domain/thread.go` 的纯函数里。挂点只做三件事——解身份、解 body、映射错误码。
// （判据散在挂点里会漂移，这是 `control/src/gate.ts` 那条既有训诫的同一条理由。）

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

// threadCreateRequest 建线程的请求体（字段名与 threads 表的列名一致，见 §11）。
type threadCreateRequest struct {
	ID                    string `json:"id"`
	ProjectID             string `json:"project_id"`
	TaskID                string `json:"task_id"`
	CoordinatorSessionRef string `json:"coordinator_session_ref"`
	SessionRef            string `json:"session_ref"`
	NodeID                string `json:"node_id"`
	// Workspace 省略时按 `thread/<id>/` 派生（§24.3.2 的唯一合法值）。
	// 给出了就必须逐字等于派生值——**归属判据是等值判据**，见 domain.ValidateThreadWorkspace。
	Workspace string `json:"workspace"`
}

func (s *Server) handleCreateThread(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	var body threadCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	workspace := body.Workspace
	if strings.TrimSpace(workspace) == "" {
		workspace = domain.ThreadWorkspaceDir(body.ID)
	}
	created, err := s.store.CreateThread(r.Context(), domain.Thread{
		ID:                    body.ID,
		Realm:                 string(ident.Realm),
		ProjectID:             body.ProjectID,
		TaskID:                body.TaskID,
		CoordinatorSessionRef: body.CoordinatorSessionRef,
		SessionRef:            body.SessionRef,
		NodeID:                body.NodeID,
		Workspace:             workspace,
		// 新建即 idle：domain 会把别的值拒掉（一出生就 running = 还没放上去就先报在跑）。
		State: domain.ThreadStateIdle,
	})
	if err != nil {
		writeThreadErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleGetThread(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	t, err := s.store.GetThread(r.Context(), string(ident.Realm), r.PathValue("threadID"))
	if err != nil {
		writeThreadErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// handleListThreads 列表读面。`state` 过滤会把闭集外的值拒掉（400）而不是返回空集：
// 空集让「我拼错了状态名」与「确实没有这种线程」看起来一样，而看板会照着这个空集说
// 「全都在跑」——一个看不见的谎。
func (s *Server) handleListThreads(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	// limit 解析失败按「未指定」处理（store 会给默认上限）：这里**不能** fail-closed 报错，
	// 因为上限是服务端自己兜底的，一个手输错的 limit 不该让看板整页打不开。
	limit := 0
	if raw := query.Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	list, err := s.store.ListThreads(r.Context(), string(ident.Realm),
		query.Get("project_id"), domain.ThreadState(query.Get("state")), limit)
	if err != nil {
		writeThreadErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleThreadState 状态转移（唯一的状态写入口）。
func (s *Server) handleThreadState(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	var body struct {
		To string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	updated, err := s.store.TransitionThread(r.Context(), string(ident.Realm),
		r.PathValue("threadID"), domain.ThreadState(body.To))
	if err != nil {
		writeThreadErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleThreadNodeLoss 承载节点丢失的上报入口（§24.2.1 末段）。
//
// 上报方必须给出它认为承载该线程的 node_id：与行上的 node_id 不符即拒（409）。
// 这个入口**不是**迁移入口——它只会把线程推到 failed，并让调用方去重派新 Run。
func (s *Server) handleThreadNodeLoss(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	var body struct {
		NodeID string `json:"node_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	updated, err := s.store.FailThreadOnNodeLoss(r.Context(), string(ident.Realm),
		r.PathValue("threadID"), body.NodeID)
	if err != nil {
		writeThreadErr(w, err)
		return
	}
	s.log.Info("线程随承载节点终止", "thread", updated.ID, "node", body.NodeID, "state", string(updated.State))
	writeJSON(w, http.StatusOK, updated)
}

// handleNodeLoss 按**节点**上报失联（§24.2.3(4) 的信号链起点，上报方是心跳侧）。
//
// 请求体只有 `node_id`：上报方手里只有「这台机器没了」这一个事实，它无从知道该节点上挂着
// 哪些线程——那是本服务的真相。realm 照旧取自身份，请求体里没有也不接受 realm 字段。
//
// 与单条入口（`POST /threads/{id}/node-loss`）的关系：两者共用同一行判据（`failThreadRow`），
// 差别只在「谁指认线程」——单条入口由上报方指认（并要求它引对 node_id，见下），本入口由
// 注册表自己按 node_id 查。**两个入口都不迁移**：它们只把线程推到 failed，重不重派由协调者定。
func (s *Server) handleNodeLoss(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	var body struct {
		NodeID string `json:"node_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	outcome, err := s.store.FailThreadsOnNodeLoss(r.Context(), string(ident.Realm), body.NodeID)
	if err != nil {
		writeThreadErr(w, err)
		return
	}
	s.log.Info("节点失联：线程随承载节点终止",
		"node", outcome.NodeID, "failed", len(outcome.Failed), "ignored", len(outcome.Ignored))
	writeJSON(w, http.StatusOK, outcome)
}

// handleNodeLossNotices 读节点失联通知的增量（游标 = `seq`，供协调者消费后决定重派）。
//
// 读面**不改状态**：通知的消费（把它投进协调者的唤醒通道、或据此重派）由持有 mailbox 的
// 那一侧完成，本服务不替它做决定——「重不重派」是协调者的判断（§24.2.3(4) 的两件事分开）。
func (s *Server) handleNodeLossNotices(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.threadIdentity(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	// 游标解析失败按「从头拉」处理（0）：游标是消费方的本地状态，一个手输错的游标不该让
	// 协调者**读不到通知**——读不到通知的后果是线程永远不被重派，比重复投递贵得多
	// （重复投递是安全的：mailbox 的兑现「首次为准」）。
	var since int64
	if raw := query.Get("since"); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil && parsed > 0 {
			since = parsed
		}
	}
	limit := 0
	if raw := query.Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	notices, err := s.store.ListNodeLossNotices(r.Context(), string(ident.Realm), since, limit)
	if err != nil {
		writeThreadErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, notices)
}

// threadIdentity 解析身份；realm 取自身份（**不接受客户端传参**）。
func (s *Server) threadIdentity(w http.ResponseWriter, r *http.Request) (Identity, bool) {
	ident, err := s.auth.Authenticate(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return Identity{}, false
	}
	return ident, true
}

// writeThreadErr 线程面的错误映射。
//
// 三种「冲突」分开报（session 被占 / 状态被抢 / 节点不符），因为它们要触发完全不同的
// 处置：前者是调用方选错了 id，中者是重读后再决定，后者是**上报来源有问题**——把它
// 混成 409「冲突」，现场就会去查数据库而真正的问题在心跳或调度器。
func writeThreadErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrThreadNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, store.ErrThreadSessionTaken):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, store.ErrThreadIDTaken):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, store.ErrThreadConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, store.ErrThreadNodeMismatch):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, domain.ErrInvalidThread):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}
