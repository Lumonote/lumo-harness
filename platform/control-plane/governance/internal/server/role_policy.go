package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/observability"
)

var errPermissionPolicyUnavailable = errors.New("permission policy unavailable")

func (s *Server) registerRolePolicyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/permission-actions", s.permissionActionCatalog)
	mux.HandleFunc("GET /v1/roles/{roleID}/permissions", s.rolePermissions)
	mux.HandleFunc("PUT /v1/roles/{roleID}/permissions", s.rolePermissions)
	mux.HandleFunc("DELETE /v1/roles/{roleID}/permissions", s.rolePermissions)
	mux.HandleFunc("PUT /v1/roles/{roleID}/parent", s.roleParent)
}

func (s *Server) permissionActionCatalog(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	if _, ok := s.caller(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"actions": domain.PermissionActionCatalog(), "max_role_depth": domain.MaxRoleDepth, "combining": "deny-overrides", "inherit_default": "absence restores built-in compatibility defaults"})
}

func (s *Server) rolePermissions(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		state, err := s.store.RolePolicy(r.Context(), c.realm, r.PathValue("roleID"))
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
		return
	}
	if !requireRealmAdmin(w, c) {
		return
	}
	var expected int64
	var rules []domain.RolePermission
	if r.Method == http.MethodDelete {
		var req struct {
			ExpectedRevision int64 `json:"expected_revision"`
		}
		if !decodeRolePolicyJSON(w, r, &req) {
			return
		}
		expected = req.ExpectedRevision
	} else {
		var req struct {
			ExpectedRevision int64                    `json:"expected_revision"`
			Permissions      *[]domain.RolePermission `json:"permissions"`
		}
		if !decodeRolePolicyJSON(w, r, &req) {
			return
		}
		if req.Permissions == nil {
			writeError(w, 400, "bad_request", "permissions must be an array; empty restores defaults")
			return
		}
		expected = req.ExpectedRevision
		rules = *req.Permissions
	}
	state, err := s.store.SetRolePermissions(r.Context(), c.realm, r.PathValue("roleID"), c.userID, expected, rules)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (s *Server) roleParent(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req struct {
		ExpectedRevision int64           `json:"expected_revision"`
		ParentRoleID     json.RawMessage `json:"parent_role_id"`
	}
	if !decodeRolePolicyJSON(w, r, &req) {
		return
	}
	var parent *string
	if len(req.ParentRoleID) == 0 || json.Unmarshal(req.ParentRoleID, &parent) != nil {
		writeError(w, 400, "bad_request", "parent_role_id must be a role ID or null")
		return
	}
	id := ""
	if parent != nil {
		id = *parent
	}
	state, err := s.store.SetRoleParent(r.Context(), c.realm, r.PathValue("roleID"), id, c.userID, req.ExpectedRevision)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func decodeRolePolicyJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, 400, "bad_request", "invalid role policy JSON body")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeError(w, 400, "bad_request", "one role policy JSON body is required")
		return false
	}
	return true
}

func (s *Server) resolveRolePolicy(ctx context.Context, c caller) (domain.RoleResolution, error) {
	if s.store != nil {
		return s.store.ResolveRoles(ctx, c.realm, c.roleNames())
	}
	return domain.ResolveRolePolicy(c.roleNames(), nil)
}

// This preflight checks only the current role facts. Resource decisions follow
// after decoding/loading the authoritative resource, so OPA never has to decide
// a project operation against an empty preliminary scope.
func (s *Server) requireDelegationAuthority(w http.ResponseWriter, r *http.Request, c caller) bool {
	return s.requireRoleAction(w, r, c, actionDelegate)
}
func (s *Server) requireRoleAction(w http.ResponseWriter, r *http.Request, c caller, action delegationAction) bool {
	roles, err := s.resolveRolePolicy(r.Context(), c)
	if err != nil {
		s.respondStoreError(w, err)
		return false
	}
	if !roles.Actions[action].Allowed {
		writeError(w, http.StatusForbidden, "forbidden", string(action)+" permission required")
		return false
	}
	return true
}
func (s *Server) requireExecutionReporter(w http.ResponseWriter, r *http.Request, c caller) bool {
	if !s.requireRoleAction(w, r, c, actionExecutionUpdate) {
		return false
	}
	task, err := s.store.GetDelegationTask(r.Context(), c.realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
		return false
	}
	return s.requirePermission(r.Context(), w, c, actionExecutionUpdate, domain.PermissionResource{Realm: c.realm, Kind: "task", ID: task.ID, ProjectID: task.ProjectID})
}

func validatePermissionPolicyURL(raw string) error {
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" || !strings.HasPrefix(u.Path, "/v1/data/") || strings.HasSuffix(u.Path, "/") || strings.Contains(u.Path, "\\") {
		return fmt.Errorf("governance: LUMO_GOVERNANCE_POLICY_URL must be an exact trusted OPA decision URL")
	}
	for _, segment := range strings.Split(strings.TrimPrefix(u.Path, "/"), "/") {
		if segment == "" || segment == "." || segment == ".." {
			return fmt.Errorf("governance: LUMO_GOVERNANCE_POLICY_URL must be an exact trusted OPA decision URL")
		}
	}
	return nil
}

// OPA receives the exact same facts as the built-in adapter. Its sole power
// is further restriction: a true response cannot override local deny or scope.
func (s *Server) applyPermissionOPA(ctx context.Context, request domain.PermissionRequest, roles domain.RoleResolution, decision domain.PermissionDecision) (domain.PermissionDecision, error) {
	if s.cfg.PermissionPolicyURL == "" {
		return decision, nil
	}
	decision.PolicyAdapter = "opa:postgres-role-facts"
	if !decision.Allowed {
		return decision, nil
	}
	body, err := json.Marshal(map[string]any{"input": map[string]any{"request": request, "role_facts": roles, "proposed": decision}})
	if err != nil {
		return domain.PermissionDecision{}, errPermissionPolicyUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.PermissionPolicyURL, bytes.NewReader(body))
	if err != nil {
		return domain.PermissionDecision{}, errPermissionPolicyUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	if s.cfg.ControlPlaneToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.cfg.ControlPlaneToken)
	}
	client := observability.ConfiguredHTTPClient(3 * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := client.Do(req)
	if err != nil {
		return domain.PermissionDecision{}, errPermissionPolicyUnavailable
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return domain.PermissionDecision{}, errPermissionPolicyUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, (64<<10)+1))
	if err != nil || len(raw) > 64<<10 {
		return domain.PermissionDecision{}, errPermissionPolicyUnavailable
	}
	var result struct {
		Result *bool `json:"result"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Result == nil {
		return domain.PermissionDecision{}, errPermissionPolicyUnavailable
	}
	decision.MatchedPolicies = append(decision.MatchedPolicies, "opa:governance")
	if !*result.Result {
		decision.Allowed = false
		decision.Reason = "OPA 根据同一角色与作用域事实收窄了该动作"
	}
	return decision, nil
}
