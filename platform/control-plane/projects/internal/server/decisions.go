package server

// 项目决策记忆的 HTTP 面（§24.4）：追加（append-only + 显式取代）、索引读面、
// 正文按需读、固化报告。
//
// realm 一律来自身份头（X-Lumo-Realm），绝不来自 body 或查询串——决策的作用域是
// (realm, project_id)，自报 realm 等于自选能读哪个租户的记忆。require() 已经把
// 「项目存在 + 我是成员 + 角色够」三步做完，这里只消费它的结论。

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/lumo-harness/platform/projects/internal/domain"
	"github.com/lumo-harness/platform/projects/internal/store"
)

// registerDecisionRoutes 与 server.go 的 Register 分开：路由表是这张读面的契约，
// 单独一处便于 server 的 routes_test 逐条比对（PG 不参与，跑得住）。
func (s *Server) registerDecisionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/projects/{id}/decisions", s.appendDecision)
	mux.HandleFunc("GET /v1/projects/{id}/decisions", s.listDecisions)
	// 固化报告是**计算**不是存储：它没有表、没有 id，所以路径用的是固定字面量段。
	// 字面量段比 {decisionID} 更具体，Go 1.22 的 mux 因此把它优先匹配给这条路由
	// （两条并存不会 panic，见 routes_test 的断言）。
	mux.HandleFunc("GET /v1/projects/{id}/decisions/consolidation-report", s.decisionConsolidation)
	mux.HandleFunc("GET /v1/projects/{id}/decisions/{decisionID}", s.getDecision)
}

func (s *Server) appendDecision(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("id")
	p, _, ok := s.require(w, r, projectID, domain.ActionEdit)
	if !ok {
		return
	}
	c, _ := s.authenticate(w, r)
	// 严格解码（DisallowUnknownFields）：`supersedes` 拼错一个字母，松解码会当没写，
	// 于是本该取代旧条目的一条新决策变成**又一次并存**——多写者冲突里最贵的一种失误。
	var req struct {
		Kind       string                  `json:"kind"`
		Summary    string                  `json:"summary"`
		Body       string                  `json:"body"`
		Supersedes string                  `json:"supersedes"`
		Evidence   []domain.ReportEvidence `json:"evidence"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	id, err := newID("dec_")
	if err != nil {
		s.log.Error("生成决策 ID 失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	decision, err := s.store.AppendDecision(r.Context(), domain.Decision{
		ID: id, Realm: c.realm, ProjectID: p.ID, Kind: req.Kind,
		Summary: req.Summary, Body: req.Body, Supersedes: req.Supersedes, Evidence: req.Evidence,
	})
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrInvalidDecision):
			// 闭集外的 kind / 空 summary / 自取代：契约漂移，400 并带上合法取值。
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		case errors.Is(err, store.ErrDecisionNotFound):
			http.Error(w, `{"error":"supersedes target not found in this project"}`, http.StatusNotFound)
		case errors.Is(err, store.ErrDecisionSuperseded):
			// 409 而非 404：目标存在但已被取代，而**不重复取代**是 append-only 的一部分。
			http.Error(w, `{"error":"supersedes target already superseded"}`, http.StatusConflict)
		case errors.Is(err, store.ErrDecisionConflict):
			http.Error(w, `{"error":"concurrent supersede lost; re-read the target and append again"}`, http.StatusConflict)
		default:
			s.log.Error("追加决策失败", "err", err)
			http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		}
		return
	}
	writeJSON(w, http.StatusCreated, decision)
}

func (s *Server) listDecisions(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("id")
	if _, _, ok := s.require(w, r, projectID, domain.ActionRead); !ok {
		return
	}
	c, _ := s.authenticate(w, r)
	kind := r.URL.Query().Get("kind")
	if kind != "" {
		if err := domain.ValidDecisionKind(kind); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	limit, ok := decisionLimitParam(w, r)
	if !ok {
		return
	}
	rows, err := s.store.ListDecisionIndex(r.Context(), c.realm, projectID, kind, limit)
	if err != nil {
		s.log.Error("读决策索引失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	// 回带**生效后**的 limit：调用方据此知道 len(decisions) == limit 意味着索引被截断，
	// 而不是「这个项目只有这么多决策」。
	writeJSON(w, http.StatusOK, map[string]any{
		"decisions": rows,
		"limit":     domain.ResolveDecisionIndexLimit(limit),
	})
}

func (s *Server) getDecision(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("id")
	if _, _, ok := s.require(w, r, projectID, domain.ActionRead); !ok {
		return
	}
	c, _ := s.authenticate(w, r)
	decision, err := s.store.GetDecision(r.Context(), c.realm, projectID, r.PathValue("decisionID"))
	if errors.Is(err, store.ErrDecisionNotFound) {
		http.Error(w, `{"error":"decision not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		s.log.Error("读决策正文失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, decision)
}

// decisionConsolidation 固化任务的只读入口（§24.4 第 5 条）。
//
// 这是**唯一的执行入口**，两类调用方共用：人手工调（运维/协调者）与 TriggerBus 的定时
// 触发（flows 的 `decisions.consolidate` 算子，见 engine.RuntimeConfig.ProjectsURL）。
// 本服务不订阅任何东西、不跑任何定时器——定时机制只有一处（§9.2 的 TriggerBus），
// 在这里再复制一套只会让「它多久跑一次」有两个互不相同的答案。
//
// 报告是 flag-only——它不会改任何行，也不会告诉调用方哪条该赢。
func (s *Server) decisionConsolidation(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("id")
	if _, _, ok := s.require(w, r, projectID, domain.ActionRead); !ok {
		return
	}
	c, _ := s.authenticate(w, r)
	cap, ok := decisionLimitParam(w, r)
	if !ok {
		return
	}
	report, err := s.store.ConsolidateDecisions(r.Context(), c.realm, projectID, cap)
	if err != nil {
		s.log.Error("决策固化失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// decisionLimitParam 解析 limit（可选）。非法值报 400 而不是回落到缺省：
// `limit=abc` 静默变成 50 会让调用方以为自己读到了全部索引。
func decisionLimitParam(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return domain.DecisionIndexDefaultLimit, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		http.Error(w, `{"error":"limit must be a non-negative integer"}`, http.StatusBadRequest)
		return 0, false
	}
	return n, true
}
