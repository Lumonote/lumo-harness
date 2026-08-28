// Package server exposes the Cluster-only governance API. Authentication is
// deliberately limited to gateway-injected headers in this first slice; the
// service never accepts a caller identity in the request body.
package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
	"github.com/lumo-harness/platform/observability"
)

type Config struct {
	DeploymentMode domain.DeploymentMode
	ClusterStatus  string
}

type Server struct {
	store *store.Store
	cfg   Config
	log   *slog.Logger
}

func New(st *store.Store, cfg Config, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{store: st, cfg: cfg, log: log}
}

func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /metrics", metrics)
	mux.HandleFunc("GET /v1/features", s.features)
	mux.HandleFunc("PUT /v1/users/{userID}", s.upsertUser)
	mux.HandleFunc("GET /v1/users/{userID}/effective-skills", s.effectiveSkills)
	mux.HandleFunc("GET /v1/departments/tree", s.listDepartments)
	mux.HandleFunc("POST /v1/departments", s.createDepartment)
	mux.HandleFunc("GET /v1/roles", s.listRoles)
	mux.HandleFunc("POST /v1/roles", s.createRole)
	mux.HandleFunc("PUT /v1/users/{userID}/roles/{roleID}", s.assignRole)
	mux.HandleFunc("GET /v1/skills", s.listSkills)
	mux.HandleFunc("POST /v1/skills", s.createSkill)
	mux.HandleFunc("POST /v1/skills/{skillID}/grants", s.grantSkill)
	mux.HandleFunc("POST /v1/skills/{skillID}/revocations", s.revokeSkill)
	mux.HandleFunc("GET /v1/desktop-nodes", s.listDesktopNodes)
	mux.HandleFunc("POST /v1/desktop-nodes", s.registerDesktopNode)
	mux.HandleFunc("POST /v1/desktop-nodes/{nodeID}/heartbeat", s.heartbeatDesktopNode)
}

type caller struct {
	userID string
	realm  string
	roles  map[string]bool
}

func (s *Server) caller(w http.ResponseWriter, r *http.Request) (caller, bool) {
	userID, realm := r.Header.Get("X-Lumo-User"), r.Header.Get("X-Lumo-Realm")
	if userID == "" || realm == "" {
		writeError(w, http.StatusUnauthorized, "missing_identity", "X-Lumo-User and X-Lumo-Realm are required")
		return caller{}, false
	}
	return caller{userID: userID, realm: realm, roles: store.NormalizeRoles(r.Header.Get("X-Lumo-Roles"))}, true
}

func (s *Server) requireCluster(w http.ResponseWriter) bool {
	if err := domain.RequireCluster(s.cfg.DeploymentMode, s.cfg.ClusterStatus); err != nil {
		writeError(w, http.StatusForbidden, "CLUSTER_ONLY", "该功能仅在状态为 ready 的 Cluster 部署中可用")
		return false
	}
	return true
}

func isRealmAdmin(c caller) bool {
	return c.roles["platform_admin"] || c.roles["realm_admin"] || c.roles["admin"]
}

func requireRealmAdmin(w http.ResponseWriter, c caller) bool {
	if isRealmAdmin(c) {
		return true
	}
	writeError(w, http.StatusForbidden, "forbidden", "realm_admin role required")
	return false
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "features": domain.NewFeatures(s.cfg.DeploymentMode, s.cfg.ClusterStatus)})
}

func metrics(w http.ResponseWriter, _ *http.Request) { observability.Handler(w, nil) }

func (s *Server) features(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, domain.NewFeatures(s.cfg.DeploymentMode, s.cfg.ClusterStatus))
}

type userRequest struct {
	DisplayName   string `json:"display_name"`
	PrimaryDeptID string `json:"primary_dept_id"`
	Status        string `json:"status"`
}

func (s *Server) upsertUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	userID := r.PathValue("userID")
	if userID != c.userID && !requireRealmAdmin(w, c) {
		return
	}
	var req userRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	user, err := s.store.UpsertUser(r.Context(), domain.User{
		ID: userID, Realm: c.realm, DisplayName: req.DisplayName, PrimaryDeptID: req.PrimaryDeptID,
		Status: req.Status, Source: "gateway",
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) effectiveSkills(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	userID := r.PathValue("userID")
	if userID != c.userID && !requireRealmAdmin(w, c) {
		return
	}
	skills, err := s.store.EffectiveSkills(r.Context(), c.realm, userID, r.URL.Query().Get("project_id"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"skills": skills})
}

type departmentRequest struct {
	ID            string `json:"id"`
	ParentDeptID  string `json:"parent_dept_id"`
	Name          string `json:"name"`
	ManagerUserID string `json:"manager_user_id"`
}

func (s *Server) listDepartments(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	departments, err := s.store.ListDepartments(r.Context(), c.realm)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"departments": departments})
}

func (s *Server) createDepartment(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req departmentRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ID == "" {
		req.ID = newID("dept")
	}
	department, err := s.store.CreateDepartment(r.Context(), domain.Department{
		ID: req.ID, Realm: c.realm, ParentDeptID: req.ParentDeptID, Name: req.Name, ManagerUserID: req.ManagerUserID,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, department)
}

func (s *Server) listRoles(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	roles, err := s.store.ListRoles(r.Context(), c.realm)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": roles})
}

type roleRequest struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (s *Server) createRole(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req roleRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ID == "" {
		req.ID = newID("role")
	}
	role, err := s.store.CreateRole(r.Context(), domain.Role{ID: req.ID, Realm: c.realm, Name: req.Name, Description: req.Description})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, role)
}

type assignRoleRequest struct {
	ExpiresAt *time.Time `json:"expires_at"`
}

func (s *Server) assignRole(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req assignRoleRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.store.AssignRole(r.Context(), c.realm, r.PathValue("userID"), r.PathValue("roleID"), c.userID, req.ExpiresAt); err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type skillRequest struct {
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	Kind           domain.SkillKind `json:"kind"`
	Visibility     string           `json:"visibility"`
	CurrentVersion string           `json:"current_version"`
}

func (s *Server) listSkills(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	skills, err := s.store.ListSkills(r.Context(), c.realm)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"skills": skills})
}

func (s *Server) createSkill(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	var req skillRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ID == "" {
		req.ID = newID("skill")
	}
	// Every user may create a low-risk private skill. Publishing tool or
	// connector skills requires the same governance authority as a rollout.
	if (req.Kind == domain.SkillTool || req.Kind == domain.SkillConnector || req.Visibility != "" && req.Visibility != "private") && !requireRealmAdmin(w, c) {
		return
	}
	skill, err := s.store.CreateSkill(r.Context(), domain.Skill{
		ID: req.ID, Realm: c.realm, Name: req.Name, Kind: req.Kind, Visibility: req.Visibility,
		CurrentVersion: req.CurrentVersion, CreatedBy: c.userID,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, skill)
}

type skillGrantRequest struct {
	VersionConstraint string             `json:"version_constraint"`
	SubjectType       domain.SubjectType `json:"subject_type"`
	SubjectID         string             `json:"subject_id"`
	IncludeChildren   bool               `json:"include_children"`
	ExpiresAt         *time.Time         `json:"expires_at"`
}

func (s *Server) grantSkill(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req skillGrantRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	err := s.store.GrantSkill(r.Context(), domain.SkillGrant{
		ID: newID("grant"), Realm: c.realm, SkillID: r.PathValue("skillID"), VersionConstraint: req.VersionConstraint,
		SubjectType: req.SubjectType, SubjectID: req.SubjectID, IncludeChildren: req.IncludeChildren,
		ExpiresAt: req.ExpiresAt, GrantedBy: c.userID,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type skillRevocationRequest struct {
	SubjectType domain.SubjectType `json:"subject_type"`
	SubjectID   string             `json:"subject_id"`
	Reason      string             `json:"reason"`
	ExpiresAt   *time.Time         `json:"expires_at"`
}

func (s *Server) revokeSkill(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	var req skillRevocationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	// A user may explicitly revoke their own inherited skill; broader revokes
	// change other people's access and require realm administration.
	if (req.SubjectType != domain.SubjectUser || req.SubjectID != c.userID) && !requireRealmAdmin(w, c) {
		return
	}
	err := s.store.RevokeSkill(r.Context(), domain.SkillRevocation{
		ID: newID("revoke"), Realm: c.realm, SkillID: r.PathValue("skillID"), SubjectType: req.SubjectType,
		SubjectID: req.SubjectID, Reason: req.Reason, ExpiresAt: req.ExpiresAt, RevokedBy: c.userID,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type desktopNodeRequest struct {
	ID            string   `json:"id"`
	ClusterID     string   `json:"cluster_id"`
	DisplayName   string   `json:"display_name"`
	OS            string   `json:"os"`
	Arch          string   `json:"arch"`
	ClientVersion string   `json:"client_version"`
	Capacity      int      `json:"capacity"`
	Capabilities  []string `json:"capabilities"`
	Residency     string   `json:"residency"`
}

func (s *Server) registerDesktopNode(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	var req desktopNodeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ID == "" {
		req.ID = newID("desktop")
	}
	node, err := s.store.RegisterDesktopNode(r.Context(), domain.DesktopNode{
		ID: req.ID, Realm: c.realm, ClusterID: req.ClusterID, OwnerUserID: c.userID, DisplayName: req.DisplayName,
		OS: req.OS, Arch: req.Arch, ClientVersion: req.ClientVersion, Capacity: req.Capacity,
		Capabilities: req.Capabilities, Residency: req.Residency,
	})
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, node)
}

func (s *Server) heartbeatDesktopNode(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	node, err := s.store.HeartbeatDesktopNode(r.Context(), c.realm, r.PathValue("nodeID"), c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, node)
}

func (s *Server) listDesktopNodes(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	nodes, err := s.store.ListDesktopNodes(r.Context(), c.realm, c.userID, isRealmAdmin(c))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": nodes})
}

func (s *Server) respondStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "resource not found")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "resource already exists")
	case errors.Is(err, store.ErrBadRequest):
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, store.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "operation not permitted")
	default:
		s.log.Error("governance request failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "internal service error")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func newID(prefix string) string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return prefix + "-" + strings.ToLower(hex.EncodeToString(raw[:]))
}
