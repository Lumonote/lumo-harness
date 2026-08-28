// Package server 项目工作区 HTTP 接入面（§11.1 端点表，设计说明 §4）。
//
// 身份由边缘/终端网关注入（X-Lumo-User / X-Lumo-Realm，与 connector-gateway 同
// 约定）：本服务**不自行签发身份**，也不接受客户端自报 realm——realm 决定能看
// 见哪些项目，自报即越权。
package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/projects/internal/domain"
	"github.com/lumo-harness/platform/projects/internal/store"
)

type Server struct {
	store *store.Store
	log   *slog.Logger
}

func New(st *store.Store, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{store: st, log: log}
}

// caller 从头解析身份。缺头即 401——匿名没有项目语义。
type caller struct {
	user  string
	realm string
}

func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (caller, bool) {
	user := r.Header.Get("X-Lumo-User")
	realm := r.Header.Get("X-Lumo-Realm")
	if user == "" || realm == "" {
		http.Error(w, `{"error":"missing identity headers"}`, http.StatusUnauthorized)
		return caller{}, false
	}
	return caller{user: user, realm: realm}, true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// require 权限执法：非成员 404（不可见）、无权 403、闭集漂移 500。
func (s *Server) require(w http.ResponseWriter, r *http.Request, projectID string, action string) (domain.Project, string, bool) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return domain.Project{}, "", false
	}
	p, role, err := s.store.GetProject(r.Context(), projectID, c.realm, c.user)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, `{"error":"project not found"}`, http.StatusNotFound)
			return domain.Project{}, "", false
		}
		s.log.Error("GetProject 失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return domain.Project{}, "", false
	}
	allowed, err := domain.CanProject(role, action)
	if err != nil {
		s.log.Error("能力矩阵闭集漂移", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return domain.Project{}, "", false
	}
	if !allowed {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return domain.Project{}, "", false
	}
	return p, role, true
}

// Register 路由（Go 1.22+ method patterns）。
func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/projects", s.create)
	mux.HandleFunc("GET /v1/projects", s.list)
	mux.HandleFunc("GET /v1/projects/{id}", s.get)
	mux.HandleFunc("GET /v1/projects/{id}/members", s.listMembers)
	mux.HandleFunc("POST /v1/projects/{id}/members", s.addMember)
	mux.HandleFunc("PATCH /v1/projects/{id}/members/{userId}", s.updateMember)
	mux.HandleFunc("DELETE /v1/projects/{id}/members/{userId}", s.removeMember)
	mux.HandleFunc("GET /v1/projects/{id}/artifacts", s.listArtifacts)
	mux.HandleFunc("PUT /v1/projects/{id}/artifacts/{kind}/{name}", s.putArtifact)
	mux.HandleFunc("GET /v1/projects/{id}/spaces", s.listSpaces)
	mux.HandleFunc("POST /v1/projects/{id}/spaces", s.createSpace)
	mux.HandleFunc("GET /v1/projects/{id}/automations", s.listAutomations)
	mux.HandleFunc("PUT /v1/projects/{id}/automations/{automationId}", s.putAutomation)
	mux.HandleFunc("GET /v1/projects/{id}/dashboard", s.dashboard)
	mux.HandleFunc("POST /v1/projects/{id}/archive", s.archive)
	mux.HandleFunc("POST /v1/projects/{id}/unarchive", s.unarchive)
	mux.HandleFunc("DELETE /v1/projects/{id}", s.delete)
	mux.HandleFunc("GET /v1/projects/{id}/usage", s.usage)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /metrics", metrics)
}

func metrics(w http.ResponseWriter, _ *http.Request) {
	observability.Handler(w, nil)
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, `{"error":"name required"}`, http.StatusBadRequest)
		return
	}
	// ID 服务侧生成（uuid 形态可读前缀）；调用方不自带——ID 是引用键不是自由文本。
	id, err := newProjectID()
	if err != nil {
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	p, err := s.store.CreateProject(r.Context(), id, c.realm, req.Name, c.user)
	if err != nil {
		if errors.Is(err, store.ErrNameTaken) {
			http.Error(w, `{"error":"name taken in realm"}`, http.StatusConflict)
			return
		}
		if errors.Is(err, store.ErrMeteringNotReady) {
			// 装配顺序的如实暴露：metering 建表先于项目创建（standalone 拓扑
			// 未部署 dsh-node 时会走到这里）。503 而非 500——这是待装配不是故障。
			http.Error(w, `{"error":"metering tables not initialized; run metering plugin init first"}`, http.StatusServiceUnavailable)
			return
		}
		s.log.Error("创建项目失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	projects, err := s.store.ListProjects(r.Context(), c.realm, c.user)
	if err != nil {
		s.log.Error("列项目失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": projects})
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, role, ok := s.require(w, r, id, domain.ActionRead)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"project": p, "yourRole": role})
}

func (s *Server) listMembers(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionRead); !ok {
		return
	}
	members, err := s.store.ListMembers(r.Context(), id)
	if err != nil {
		s.log.Error("列成员失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": members})
}

func (s *Server) listArtifacts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionRead); !ok {
		return
	}
	items, err := s.store.ListArtifacts(r.Context(), id)
	if err != nil {
		s.log.Error("列制品失败", "err", err)
		http.Error(w, `{"error":"internal"}`, 500)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"artifacts": items})
}

func (s *Server) putArtifact(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionEdit); !ok {
		return
	}
	var req struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil || req.Version == "" {
		http.Error(w, `{"error":"version required"}`, http.StatusBadRequest)
		return
	}
	a := domain.Artifact{ProjectID: id, Kind: r.PathValue("kind"), Name: r.PathValue("name"), Version: req.Version}
	if a.Name == "" {
		http.Error(w, `{"error":"name required"}`, http.StatusBadRequest)
		return
	}
	if err := s.store.UpsertArtifact(r.Context(), a); err != nil {
		http.Error(w, `{"error":"invalid artifact"}`, http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) listSpaces(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionRead); !ok {
		return
	}
	items, err := s.store.ListSpaces(r.Context(), id)
	if err != nil {
		s.log.Error("列空间失败", "err", err)
		http.Error(w, `{"error":"internal"}`, 500)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"spaces": items})
}

func (s *Server) createSpace(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, _, ok := s.require(w, r, id, domain.ActionEdit)
	if !ok {
		return
	}
	var req struct {
		ID   string `json:"spaceId"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, `{"error":"name required"}`, http.StatusBadRequest)
		return
	}
	if req.ID == "" {
		req.ID, _ = newID("space_")
	}
	space := domain.Space{ID: req.ID, ProjectID: id, Realm: p.Realm, Name: req.Name}
	if err := s.store.UpsertSpace(r.Context(), space); err != nil {
		s.log.Error("创建空间失败", "err", err)
		http.Error(w, `{"error":"space conflict"}`, http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusCreated, space)
}

func (s *Server) listAutomations(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionRead); !ok {
		return
	}
	items, err := s.store.ListAutomations(r.Context(), id)
	if err != nil {
		s.log.Error("列自动化失败", "err", err)
		http.Error(w, `{"error":"internal"}`, 500)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"automations": items})
}

func (s *Server) putAutomation(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionEdit); !ok {
		return
	}
	var a domain.Automation
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&a); err != nil {
		http.Error(w, `{"error":"invalid automation"}`, http.StatusBadRequest)
		return
	}
	a.ID, a.ProjectID = r.PathValue("automationId"), id
	if a.TriggerSpec == "" || a.FlowRef == "" {
		http.Error(w, `{"error":"triggerSpec and flowRef required"}`, http.StatusBadRequest)
		return
	}
	if err := s.store.UpsertAutomation(r.Context(), a); err != nil {
		http.Error(w, `{"error":"invalid automation"}`, http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, role, ok := s.require(w, r, id, domain.ActionRead)
	if !ok {
		return
	}
	members, err := s.store.ListMembers(r.Context(), id)
	if err != nil {
		http.Error(w, `{"error":"internal"}`, 500)
		return
	}
	artifacts, err := s.store.ListArtifacts(r.Context(), id)
	if err != nil {
		http.Error(w, `{"error":"internal"}`, 500)
		return
	}
	spaces, err := s.store.ListSpaces(r.Context(), id)
	if err != nil {
		http.Error(w, `{"error":"internal"}`, 500)
		return
	}
	automations, err := s.store.ListAutomations(r.Context(), id)
	if err != nil {
		http.Error(w, `{"error":"internal"}`, 500)
		return
	}
	items, budget, err := s.store.Usage(r.Context(), id)
	if err != nil {
		http.Error(w, `{"error":"internal"}`, 500)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"project": p, "yourRole": role, "members": members, "artifacts": artifacts, "spaces": spaces, "automations": automations, "usage": items, "budget": budget})
}

func (s *Server) addMember(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionMembersManage); !ok {
		return
	}
	var req struct {
		UserID string `json:"userId"`
		Role   string `json:"role"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil ||
		req.UserID == "" {
		http.Error(w, `{"error":"userId required"}`, http.StatusBadRequest)
		return
	}
	if req.Role == "" {
		req.Role = domain.RoleViewer
	}
	if req.Role != domain.RoleOwner && req.Role != domain.RoleEditor && req.Role != domain.RoleViewer {
		http.Error(w, `{"error":"unknown role"}`, http.StatusBadRequest)
		return
	}
	if err := s.store.AddMember(r.Context(), id, req.UserID, req.Role); err != nil {
		switch {
		case errors.Is(err, store.ErrAlreadyMember):
			http.Error(w, `{"error":"already a member"}`, http.StatusConflict)
		default:
			s.log.Error("加成员失败", "err", err)
			http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		}
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "added"})
}

func (s *Server) updateMember(w http.ResponseWriter, r *http.Request) {
	id, uid := r.PathValue("id"), r.PathValue("userId")
	if _, _, ok := s.require(w, r, id, domain.ActionMembersManage); !ok {
		return
	}
	var req struct {
		Role string `json:"role"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil ||
		(req.Role != domain.RoleOwner && req.Role != domain.RoleEditor && req.Role != domain.RoleViewer) {
		http.Error(w, `{"error":"valid role required"}`, http.StatusBadRequest)
		return
	}
	if err := s.store.UpdateMemberRole(r.Context(), id, uid, req.Role); err != nil {
		switch {
		case errors.Is(err, store.ErrLastOwner):
			http.Error(w, `{"error":"cannot demote the last owner"}`, http.StatusConflict)
		case errors.Is(err, store.ErrNotFound):
			http.Error(w, `{"error":"member not found"}`, http.StatusNotFound)
		default:
			s.log.Error("改角色失败", "err", err)
			http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (s *Server) removeMember(w http.ResponseWriter, r *http.Request) {
	id, uid := r.PathValue("id"), r.PathValue("userId")
	if _, _, ok := s.require(w, r, id, domain.ActionMembersManage); !ok {
		return
	}
	if err := s.store.RemoveMember(r.Context(), id, uid); err != nil {
		switch {
		case errors.Is(err, store.ErrLastOwner):
			http.Error(w, `{"error":"cannot remove the last owner"}`, http.StatusConflict)
		case errors.Is(err, store.ErrNotFound):
			http.Error(w, `{"error":"member not found"}`, http.StatusNotFound)
		default:
			s.log.Error("移成员失败", "err", err)
			http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

func (s *Server) archive(w http.ResponseWriter, r *http.Request) {
	s.transition(w, r, "archive")
}

func (s *Server) unarchive(w http.ResponseWriter, r *http.Request) {
	s.transition(w, r, "unarchive")
}

func (s *Server) transition(w http.ResponseWriter, r *http.Request, event string) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionArchive); !ok {
		return
	}
	p, err := s.store.Transition(r.Context(), id, event)
	if err != nil {
		s.log.Error("生命周期转移失败", "err", err)
		http.Error(w, `{"error":"transition failed"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// delete 终局删除：两层显式授权——(1) 只接受 archived 态（先归档这道闸），
// (2) X-Lumo-Confirm 头必须等于项目 ID（防误触：确认的是「删这个」而不是「删某个」）。
func (s *Server) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionDelete); !ok {
		return
	}
	if r.Header.Get("X-Lumo-Confirm") != id {
		http.Error(w, `{"error":"explicit confirmation required (X-Lumo-Confirm: <project id>)"}`, http.StatusPreconditionRequired)
		return
	}
	if err := s.store.DeleteProject(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotArchived) {
			http.Error(w, `{"error":"must be archived before deletion"}`, http.StatusConflict)
			return
		}
		s.log.Error("删除项目失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) usage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := s.require(w, r, id, domain.ActionRead); !ok {
		return
	}
	items, budget, err := s.store.Usage(r.Context(), id)
	if err != nil {
		s.log.Error("用量聚合失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"usage": items, "budget": budget})
}
