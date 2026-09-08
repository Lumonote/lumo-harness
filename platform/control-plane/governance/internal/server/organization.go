package server

import (
	"net/http"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func (s *Server) updateRole(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Status      string `json:"status"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	role, err := s.store.UpdateRole(r.Context(), domain.Role{ID: r.PathValue("roleID"), Realm: c.realm, Name: req.Name, Description: req.Description, Status: req.Status}, c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, role)
}

func (s *Server) updateDepartment(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req struct {
		Name          string `json:"name"`
		ParentDeptID  string `json:"parent_dept_id"`
		ManagerUserID string `json:"manager_user_id"`
		Status        string `json:"status"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	department, err := s.store.UpdateDepartment(r.Context(), domain.Department{ID: r.PathValue("departmentID"), Realm: c.realm, Name: req.Name, ParentDeptID: req.ParentDeptID, ManagerUserID: req.ManagerUserID, Status: req.Status}, c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, department)
}
