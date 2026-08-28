// Package flows 第五类制品 HTTP 接入面（§11 后半，设计说明 §4 端点表）。
//
// 身份头同 projects（X-Lumo-User/Realm/Roles，可选 X-Lumo-Dept）；本服务不自签身份。
// 审核执法：manager/admin 且非作者（dept 归属校验随组织树 P2，设计 §4 诚实边界）。
package server

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/engine"
	"github.com/lumo-harness/platform/flows/internal/store"
	"github.com/lumo-harness/platform/observability"
)

type Server struct {
	store  *store.Store
	log    *slog.Logger
	engine *engine.Engine
}

func New(st *store.Store, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{store: st, log: log, engine: engine.New()}
}

type caller struct {
	user  string
	realm string
	roles []string
	depts []string
}

func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (caller, bool) {
	user, realm := r.Header.Get("X-Lumo-User"), r.Header.Get("X-Lumo-Realm")
	if user == "" || realm == "" {
		http.Error(w, `{"error":"missing identity headers"}`, http.StatusUnauthorized)
		return caller{}, false
	}
	c := caller{
		user:  user,
		realm: realm,
		roles: splitCSV(r.Header.Get("X-Lumo-Roles")),
		depts: splitCSV(r.Header.Get("X-Lumo-Dept")),
	}
	return c, true
}

func splitCSV(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (c caller) hasRole(want string) bool {
	for _, r := range c.roles {
		if r == want {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// requireProjectMember 项目角色闸（编辑类动作须 editor+）。
func (s *Server) requireProjectMember(w http.ResponseWriter, r *http.Request, projectID string, c caller) (string, bool) {
	role, err := s.store.ProjectRole(r.Context(), projectID, c.realm, c.user)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, `{"error":"project not found"}`, http.StatusNotFound)
			return "", false
		}
		s.log.Error("查项目成员失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return "", false
	}
	if role != domain.RoleOwner && role != domain.RoleEditor {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return "", false
	}
	return role, true
}

// 可见性执法：draft/submitted 仅作者；published+ 项目成员或已分发可见。
// deprecated 详情仍可读（引用方需要知道它死了），只从面板剔除。
func canSee(f *domain.Flow, c caller) bool {
	switch f.Status {
	case domain.StatusDraft, domain.StatusSubmitted:
		return f.Author == c.user
	default:
		return true
	}
}

func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/projects/{pid}/flows", s.create)
	mux.HandleFunc("GET /v1/projects/{pid}/flows", s.listProject)
	mux.HandleFunc("GET /v1/flows", s.discover)
	mux.HandleFunc("GET /v1/flows/{id}", s.get)
	mux.HandleFunc("PUT /v1/flows/{id}/definition", s.updateDefinition)
	mux.HandleFunc("POST /v1/flows/{id}/submit", s.submit)
	mux.HandleFunc("POST /v1/flows/{id}/review", s.review)
	mux.HandleFunc("POST /v1/flows/{id}/target", s.target)
	mux.HandleFunc("POST /v1/flows/{id}/deprecate", s.deprecate)
	mux.HandleFunc("POST /v1/flows/{id}/rollback", s.rollback)
	mux.HandleFunc("POST /v1/flows/{id}/run", s.run)
	mux.HandleFunc("POST /v1/events/{name}", s.event)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /metrics", metrics)
}

// event 将外部事件安全落入持久 outbox；真正执行由 worker 完成，故入口快速返回 202。
func (s *Server) event(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	name := strings.TrimSpace(r.PathValue("name"))
	// "*" is reserved by the in-process wildcard subscriber; accepting it at
	// the ingress would make one event fan out twice and is never a valid
	// application event name.
	if name == "" || name == "*" || len(name) > 128 {
		http.Error(w, `{"error":"invalid event name"}`, http.StatusBadRequest)
		return
	}
	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil || len(payload) == 0 || !json.Valid(payload) {
		http.Error(w, `{"error":"JSON payload required"}`, http.StatusBadRequest)
		return
	}
	if err := s.store.EnqueueTrigger(r.Context(), c.realm, name, payload); err != nil {
		s.log.Error("事件入队失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "queued", "event": name})
}

func metrics(w http.ResponseWriter, _ *http.Request) {
	observability.Handler(w, nil)
}

// run 只执行已发布快照；运行时不读取 draft 定义，避免编辑态绕过审核进入生产。
func (s *Server) run(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !c.hasRole("admin") && !c.hasRole("manager") && !c.hasRole("editor") && !c.hasRole("owner") {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}
	definition, err := s.store.Definition(r.Context(), r.PathValue("id"), c.realm)
	if err != nil {
		http.Error(w, `{"error":"published flow not found"}`, http.StatusNotFound)
		return
	}
	var req struct {
		Input any `json:"input"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, `{"error":"invalid input"}`, http.StatusBadRequest)
		return
	}
	var def domain.Definition
	if err := json.Unmarshal(definition, &def); err != nil {
		http.Error(w, `{"error":"stored definition invalid"}`, http.StatusInternalServerError)
		return
	}
	result, err := s.engine.Run(r.Context(), &def, req.Input)
	if err != nil {
		http.Error(w, `{"error":"flow execution failed: `+err.Error()+`"}`, http.StatusUnprocessableEntity)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// parseDefinition 入库护栏（防环在两处跑：TS 前端提示 + Go 入库强制——Go 是执法位）。
func parseDefinition(body []byte) (json.RawMessage, *domain.Definition, error) {
	var def domain.Definition
	if err := json.Unmarshal(body, &def); err != nil {
		return nil, nil, err
	}
	if err := domain.ValidateDefinition(&def); err != nil {
		return nil, nil, err
	}
	// 重新序列化为规范 JSON 入库（RawMessage 保形状，规范字节利于快照比对）
	norm, err := json.Marshal(def)
	if err != nil {
		return nil, nil, err
	}
	return norm, &def, nil
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	pid := r.PathValue("pid")
	if _, ok := s.requireProjectMember(w, r, pid, c); !ok {
		return
	}
	var req struct {
		Name       string          `json:"name"`
		Definition json.RawMessage `json:"definition"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, `{"error":"name and definition required"}`, http.StatusBadRequest)
		return
	}
	norm, _, err := parseDefinition(req.Definition)
	if err != nil {
		http.Error(w, `{"error":"invalid definition: `+err.Error()+`"}`, http.StatusBadRequest)
		return
	}
	id, err := newFlowID()
	if err != nil {
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	f, err := s.store.CreateFlow(r.Context(), id, pid, c.realm, req.Name, c.user, norm)
	if err != nil {
		if errors.Is(err, store.ErrNameTaken) {
			http.Error(w, `{"error":"name taken in project"}`, http.StatusConflict)
			return
		}
		s.log.Error("建流程失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, f)
}

func (s *Server) listProject(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	pid := r.PathValue("pid")
	// viewer 也可看项目内清单（draft 只列本人由 store 过滤）
	if _, err := s.store.ProjectRole(r.Context(), pid, c.realm, c.user); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, `{"error":"project not found"}`, http.StatusNotFound)
			return
		}
		s.log.Error("查项目成员失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	flows, err := s.store.ListProjectFlows(r.Context(), pid, c.realm, c.user)
	if err != nil {
		s.log.Error("列流程失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"flows": flows})
}

// discover 流程面板（设计 §4：global ∪ targeted(命中) ∪ private(项目成员)）。
func (s *Server) discover(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	flows, err := s.store.Discoverable(r.Context(), c.realm, domain.Caller{User: c.user, Roles: c.roles, Depts: c.depts})
	if err != nil {
		s.log.Error("面板查询失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"flows": flows})
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	f, err := s.store.GetFlow(r.Context(), r.PathValue("id"), c.realm)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, `{"error":"flow not found"}`, http.StatusNotFound)
			return
		}
		s.log.Error("取流程失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if !canSee(f, c) {
		http.Error(w, `{"error":"flow not found"}`, http.StatusNotFound) // 不可见 ≠ 不存在（草稿保密）
		return
	}
	writeJSON(w, http.StatusOK, f)
}

func (s *Server) updateDefinition(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	f, err := s.store.GetFlow(r.Context(), r.PathValue("id"), c.realm)
	if err != nil {
		http.Error(w, `{"error":"flow not found"}`, http.StatusNotFound)
		return
	}
	if f.Author != c.user {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}
	var req struct {
		Definition json.RawMessage `json:"definition"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, `{"error":"definition required"}`, http.StatusBadRequest)
		return
	}
	norm, _, err := parseDefinition(req.Definition)
	if err != nil {
		http.Error(w, `{"error":"invalid definition: `+err.Error()+`"}`, http.StatusBadRequest)
		return
	}
	if err := s.store.UpdateDefinition(r.Context(), f.ID, norm); err != nil {
		if errors.Is(err, store.ErrOnlyDraft) {
			http.Error(w, `{"error":"only draft can be edited"}`, http.StatusConflict)
			return
		}
		s.log.Error("改定义失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	f, err := s.store.GetFlow(r.Context(), r.PathValue("id"), c.realm)
	if err != nil {
		http.Error(w, `{"error":"flow not found"}`, http.StatusNotFound)
		return
	}
	if f.Author != c.user {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}
	f, err = s.store.Transition(r.Context(), f.ID, domain.EventSubmit)
	if err != nil {
		http.Error(w, `{"error":"illegal transition: `+err.Error()+`"}`, http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, f)
}

// review FlowReview：审核人须 manager/admin 且非作者（职责分离——自审让「提升为
// 通用」的闸形同虚设）。dept 归属校验随组织树 P2。
func (s *Server) review(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !c.hasRole("manager") && !c.hasRole("admin") {
		http.Error(w, `{"error":"reviewer must be manager or admin"}`, http.StatusForbidden)
		return
	}
	f, err := s.store.GetFlow(r.Context(), r.PathValue("id"), c.realm)
	if err != nil {
		http.Error(w, `{"error":"flow not found"}`, http.StatusNotFound)
		return
	}
	if f.Author == c.user {
		http.Error(w, `{"error":"author cannot review their own flow"}`, http.StatusForbidden)
		return
	}
	var req struct {
		Approve bool   `json:"approve"`
		Comment string `json:"comment"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, `{"error":"approve required"}`, http.StatusBadRequest)
		return
	}
	f, err = s.store.Review(r.Context(), f.ID, c.user, req.Approve, req.Comment)
	if err != nil {
		http.Error(w, `{"error":"review failed: `+err.Error()+`"}`, http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, f)
}

// target 定向分发：项目 owner 的治理动作（发布后的受众决定权在 owner，不在作者）。
func (s *Server) target(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	f, err := s.store.GetFlow(r.Context(), r.PathValue("id"), c.realm)
	if err != nil {
		http.Error(w, `{"error":"flow not found"}`, http.StatusNotFound)
		return
	}
	role, err := s.store.ProjectRole(r.Context(), f.ProjectID, c.realm, c.user)
	if err != nil || role != domain.RoleOwner {
		if err != nil && errors.Is(err, store.ErrNotFound) {
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
			return
		}
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}
	var req struct {
		Audience   *domain.Audience `json:"audience"`
		Visibility string           `json:"visibility"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, `{"error":"audience required"}`, http.StatusBadRequest)
		return
	}
	visibility := req.Visibility
	if visibility == "" {
		visibility = domain.VisibilityTargeted
	}
	if visibility != domain.VisibilityTargeted && visibility != domain.VisibilityGlobal {
		http.Error(w, `{"error":"unknown visibility"}`, http.StatusBadRequest)
		return
	}
	if visibility == domain.VisibilityTargeted && !hasAudience(req.Audience) {
		http.Error(w, `{"error":"targeted visibility requires a non-empty audience"}`, http.StatusBadRequest)
		return
	}
	f, err = s.store.Target(r.Context(), f.ID, req.Audience, visibility)
	if err != nil {
		http.Error(w, `{"error":"target failed: `+err.Error()+`"}`, http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, f)
}

func hasAudience(a *domain.Audience) bool {
	return a != nil && (len(a.Roles) > 0 || len(a.Depts) > 0 || len(a.Users) > 0)
}

func (s *Server) deprecate(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	f, err := s.store.GetFlow(r.Context(), r.PathValue("id"), c.realm)
	if err != nil {
		http.Error(w, `{"error":"flow not found"}`, http.StatusNotFound)
		return
	}
	// 作者可弃自己的草稿；发布后的弃用是治理动作（owner/admin）
	if f.Author != c.user {
		role, err := s.store.ProjectRole(r.Context(), f.ProjectID, c.realm, c.user)
		if err != nil || (role != domain.RoleOwner && !c.hasRole("admin")) {
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
			return
		}
	}
	f, err = s.store.Transition(r.Context(), f.ID, domain.EventDeprecate)
	if err != nil {
		http.Error(w, `{"error":"illegal transition: `+err.Error()+`"}`, http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, f)
}

func (s *Server) rollback(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	f, err := s.store.GetFlow(r.Context(), r.PathValue("id"), c.realm)
	if err != nil {
		http.Error(w, `{"error":"flow not found"}`, http.StatusNotFound)
		return
	}
	role, err := s.store.ProjectRole(r.Context(), f.ProjectID, c.realm, c.user)
	if err != nil || role != domain.RoleOwner {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}
	var req struct {
		Version int `json:"version"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil || req.Version < 1 {
		http.Error(w, `{"error":"version required"}`, http.StatusBadRequest)
		return
	}
	f, err = s.store.Rollback(r.Context(), f.ID, req.Version)
	if err != nil {
		if errors.Is(err, store.ErrVersionGone) {
			http.Error(w, `{"error":"version not found"}`, http.StatusNotFound)
			return
		}
		s.log.Error("回滚失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, f)
}
