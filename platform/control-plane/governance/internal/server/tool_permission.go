package server

import (
	"context"
	"errors"
	"net/http"
	"slices"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
	"github.com/lumo-harness/platform/governance/permission"
)

func (s *Server) decideTool(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	c, ok := s.caller(w, r)
	if !ok {
		return
	}
	var in permission.Input
	if !decodeRolePolicyJSON(w, r, &in) {
		return
	}
	d, err := permission.Decide(r.Context(), c.realm, c.userID, in, s.authorizeTool)
	status := http.StatusOK
	if err != nil {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, struct {
		DecisionID string `json:"decision_id"`
		permission.Decision
	}{newID("decision"), d})
}

func (s *Server) authorizeTool(ctx context.Context, in permission.Input) (bool, []string, error) {
	if s.store == nil {
		return false, nil, errors.New("no governance store")
	}
	p, err := s.store.RuntimeThreadPrincipal(ctx, in.Realm, in.Principal.ID)
	if errors.Is(err, store.ErrNotFound) {
		return false, []string{"directory:inactive-or-absent"}, nil
	}
	if err != nil {
		return false, nil, err
	}
	action := domain.PermissionAction(in.Action)
	resource := domain.PermissionResource{Realm: in.Realm, Kind: in.Resource.Kind, ID: in.Resource.ID, ProjectID: in.Resource.ProjectID}
	// Project reads always require membership. Host engine inventory is restricted
	// to a direct administrator; inherited names and HTTP role headers do not count.
	admin := slices.Contains(p.Roles, "admin") || slices.Contains(p.Roles, "realm_admin") || slices.Contains(p.Roles, "platform_admin")
	realmAllowed := in.Action == permission.ProjectRead || (in.Action == permission.EngineList && admin)
	facts := domain.PermissionContext{RealmAllowed: realmAllowed}
	if realmAllowed && resource.ProjectID != "" {
		allowed, err := s.store.PermissionProjectAccess(ctx, p.Realm, resource.ProjectID, p.UserID, false)
		if err != nil {
			return false, nil, err
		}
		facts.ProjectAllowed = &allowed
	}
	req := domain.PermissionRequest{Actor: domain.PermissionActor{Realm: p.Realm, UserID: p.UserID, Roles: p.Roles}, Action: action, Resource: resource, Context: facts}
	d := domain.EvaluatePermission(req)
	roles := domain.RoleResolution{DirectRoles: p.Roles, EffectiveRoles: p.EffectiveRoles, Actions: map[domain.PermissionAction]domain.RoleActionDecision{action: {Allowed: realmAllowed}}}
	d, err = s.applyPermissionOPA(ctx, req, roles, d)
	return d.Allowed, d.MatchedPolicies, err
}
