package server

import (
	"context"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
	"github.com/lumo-harness/platform/observability"
	"net/http"
	"time"
)

func (s *Server) registerRemoteComputerRoutes(mux *http.ServeMux) {
	mux.Handle("POST /v1/runtime/computer-use/requests", observability.RequireControlPlaneToken(s.cfg.ControlPlaneToken)(http.HandlerFunc(s.createRemoteComputerRequest)))
	mux.Handle("GET /v1/runtime/computer-use/requests/{requestID}", observability.RequireControlPlaneToken(s.cfg.ControlPlaneToken)(http.HandlerFunc(s.runtimeRemoteComputerReceipt)))
	mux.Handle("POST /v1/runtime/computer-use/requests/{requestID}/cancel", observability.RequireControlPlaneToken(s.cfg.ControlPlaneToken)(http.HandlerFunc(s.runtimeRemoteComputerCancel)))
	mux.HandleFunc("GET /v1/nodes/{nodeID}/computer-use/requests", s.remoteComputerRequests)
	mux.HandleFunc("POST /v1/nodes/{nodeID}/computer-use/requests/{requestID}/revoke", s.revokeRemoteComputerRequest)
}

func (s *Server) runtimeRemoteComputerReceipt(w http.ResponseWriter, r *http.Request) {
	if !s.remoteComputerEnabled(w) {
		return
	}
	request, err := s.store.RemoteComputerRequest(r.Context(), r.Header.Get("X-Lumo-Realm"), r.PathValue("requestID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	if err = s.authorizeRemoteComputer(r.Context(), request); err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, 200, request)
}
func (s *Server) runtimeRemoteComputerCancel(w http.ResponseWriter, r *http.Request) {
	if !s.remoteComputerEnabled(w) {
		return
	}
	request, err := s.store.RemoteComputerRequest(r.Context(), r.Header.Get("X-Lumo-Realm"), r.PathValue("requestID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	// A trusted Flow can only cancel its exact frozen sender's request; it cannot
	// grant new authority, change target or revive a terminal outcome.
	out, err := s.store.RevokeRemoteComputerRequest(r.Context(), request.Plan.Realm, request.Plan.NodeID, request.RequestID, request.Authority.Sender)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, 200, out)
}
func (s *Server) remoteComputerEnabled(w http.ResponseWriter) bool {
	if !s.requireCluster(w) {
		return false
	}
	if !s.cfg.RemoteComputerUse || s.cfg.DeviceGateway == nil {
		writeError(w, 404, "remote_computer_disabled", "Remote desktop requests are explicitly disabled")
		return false
	}
	return true
}
func (s *Server) authorizeRemoteComputer(ctx context.Context, r store.RemoteComputerRequest) error {
	a := r.Authority
	team, err := s.currentBotTeam(ctx, r.Plan.Realm, a.TeamID)
	if err != nil {
		return err
	}
	if err = r.ValidateTeam(team.Owner, team.Captain, team.Revision); err != nil {
		return err
	}
	author, project, operator, config, err := s.store.BotFlowNode(ctx, r.Plan.Realm, a.FlowID, a.FlowVersion, a.FlowNode)
	if err != nil || author != a.Author || project != a.ProjectID || operator != "computer-use.request" || config["deviceId"] != r.Plan.NodeID || config["sessionRef"] != r.Plan.SessionRef || config["capability"] != r.Plan.Capability || config["projectId"] != a.ProjectID || config["teamId"] != a.TeamID || config["captainSessionRef"] != a.Captain || config["assigneeWorkerId"] != "agent:"+a.AgentID {
		return store.ErrForbidden
	}
	for _, user := range []string{a.Sender, a.Author, a.TeamOwner, r.Plan.Owner} {
		principal, e := s.store.RuntimeThreadPrincipal(ctx, r.Plan.Realm, user)
		if e != nil {
			return e
		}
		member, e := s.store.ProjectMember(ctx, a.ProjectID, user)
		if e != nil || !member {
			return store.ErrForbidden
		}
		actor := caller{userID: user, realm: r.Plan.Realm, roles: map[string]bool{}}
		for _, role := range principal.Roles {
			actor.roles[role] = true
		}
		decision, e := s.permissionDecision(ctx, actor, actionDelegate, domain.PermissionResource{Realm: r.Plan.Realm, ProjectID: a.ProjectID, Kind: "remote-computer"})
		if e != nil {
			return e
		}
		if !decision.Allowed {
			return store.ErrForbidden
		}
	}
	return nil
}
func (s *Server) createRemoteComputerRequest(w http.ResponseWriter, r *http.Request) {
	if !s.remoteComputerEnabled(w) {
		return
	}
	realm := r.Header.Get("X-Lumo-Realm")
	if realm == "" {
		writeError(w, 401, "missing_realm", "Realm required")
		return
	}
	var input struct {
		store.RemoteComputerAuthority
		DeviceID     string `json:"device_id"`
		SessionRef   string `json:"session_ref"`
		Capability   string `json:"capability"`
		Intent       string `json:"intent"`
		TTLSeconds   int    `json:"ttl_seconds"`
		ExecutionKey string `json:"execution_key"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	a := input.RemoteComputerAuthority
	grant, err := s.store.BotCapabilityGrant(r.Context(), realm, a.Channel, a.Subject, a.TeamID, a.ProjectID, a.AgentID, "computer-use.request")
	if err != nil || grant.Status != "active" || grant.Revision != a.GrantRevision || grant.SubjectUserID != a.Sender || grant.SubjectRevision != a.BindingRevision {
		writeError(w, 403, "remote_computer_denied", "A current dedicated Bot computer-use grant is required")
		return
	}
	// These facts come from the current server grant, never a Bot's owner fields.
	a.TeamOwner = grant.TeamOwner
	a.TeamRevision = grant.TeamRevision
	a.PresetRevision = grant.PresetRevision
	d, err := s.store.Device(r.Context(), realm, input.DeviceID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	plan := store.RemoteComputerPlan{Realm: realm, NodeID: input.DeviceID, Owner: d.Owner, ProjectID: a.ProjectID, SessionRef: input.SessionRef, Capability: input.Capability}
	if err = s.authorizeRemoteComputer(r.Context(), store.RemoteComputerRequest{Authority: a, Plan: plan}); err != nil {
		s.respondStoreError(w, err)
		return
	}
	out, err := s.store.CreateRemoteComputerRequest(r.Context(), realm, input.DeviceID, input.ExecutionKey, a, input.SessionRef, input.Capability, input.Intent, time.Duration(input.TTLSeconds)*time.Second)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, out)
}
func (s *Server) remoteComputerRequests(w http.ResponseWriter, r *http.Request) {
	if !s.remoteComputerEnabled(w) {
		return
	}
	_, d, ok := s.deviceCaller(w, r)
	if !ok {
		return
	}
	out, err := s.store.ListRemoteComputerRequests(r.Context(), d.Realm, d.NodeID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"requests": out})
}
func (s *Server) revokeRemoteComputerRequest(w http.ResponseWriter, r *http.Request) {
	if !s.remoteComputerEnabled(w) {
		return
	}
	c, d, ok := s.deviceCaller(w, r)
	if !ok {
		return
	}
	out, err := s.store.RevokeRemoteComputerRequest(r.Context(), d.Realm, d.NodeID, r.PathValue("requestID"), c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, 200, out)
}
