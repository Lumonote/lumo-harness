package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
)

type botTeam struct {
	Realm    string `json:"realm"`
	ID       string `json:"id"`
	Owner    string `json:"owner_user_id"`
	Captain  string `json:"captain_session_ref"`
	Revision string `json:"revision"`
}

func (s *Server) currentBotTeam(ctx context.Context, realm, id string) (botTeam, error) {
	var team botTeam
	base, err := url.Parse(s.cfg.BotTeamsURL)
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.RawQuery != "" || base.Fragment != "" || s.cfg.ControlPlaneToken == "" {
		return team, fmt.Errorf("trusted team authorization source unavailable")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.cfg.BotTeamsURL, "/")+"/lumo/runtime/teams/"+url.PathEscape(id), nil)
	if err != nil {
		return team, err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.ControlPlaneToken)
	req.Header.Set("X-Lumo-Realm", realm)
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return team, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return team, fmt.Errorf("trusted team source refused current team")
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<10+1))
	if err != nil || len(raw) > 64<<10 {
		return team, fmt.Errorf("invalid trusted team response")
	}
	if err = json.Unmarshal(raw, &team); err != nil || team.Realm != realm || team.ID != id || team.Owner == "" || team.Captain == "" || team.Revision == "" {
		return team, fmt.Errorf("inconsistent trusted team response")
	}
	return team, nil
}

func (s *Server) manageBotSubject(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req struct {
		UserID string `json:"user_id"`
		Status string `json:"status"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Status == "active" {
		if _, err := s.store.RuntimeThreadPrincipal(r.Context(), c.realm, req.UserID); err != nil {
			s.respondStoreError(w, err)
			return
		}
	}
	value, err := s.store.UpsertBotSubject(r.Context(), store.BotSubject{Realm: c.realm, Channel: r.PathValue("channel"), Subject: r.PathValue("subject"), UserID: req.UserID, Status: req.Status})
	if err != nil {
		writeError(w, 400, "invalid_bot_mapping", err.Error())
		return
	}
	writeJSON(w, 200, value)
}
func (s *Server) manageBotGrant(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var req struct {
		TeamID     string `json:"team_id"`
		ProjectID  string `json:"project_id"`
		AgentID    string `json:"agent_id"`
		Capability string `json:"capability"`
		Status     string `json:"status"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	var grant store.BotGrant
	var err error
	if req.Status == "revoked" {
		previous, e := s.store.BotGrant(r.Context(), c.realm, r.PathValue("channel"), r.PathValue("subject"), req.TeamID, req.ProjectID, req.AgentID)
		if e != nil {
			s.respondStoreError(w, e)
			return
		}
		grant = previous
	} else {
		mapping, e := s.store.BotSubject(r.Context(), c.realm, r.PathValue("channel"), r.PathValue("subject"))
		if e != nil || mapping.Status != "active" {
			writeError(w, 403, "invalid_bot_mapping", "an active sender mapping is required")
			return
		}
		team, e := s.currentBotTeam(r.Context(), c.realm, req.TeamID)
		err = e
		if err != nil {
			writeError(w, 503, "team_authorization_unavailable", err.Error())
			return
		}
		preset, e := s.store.GetAgentPreset(r.Context(), c.realm, req.AgentID)
		if e != nil || preset.Status != "active" || preset.ProjectID != req.ProjectID || req.ProjectID == "" || preset.OwnerUserID != team.Owner {
			writeError(w, 403, "invalid_bot_agent", "the current team owner's active project Agent is required")
			return
		}
		grant = store.BotGrant{BotSubject: mapping, TeamID: req.TeamID, TeamOwner: team.Owner, Captain: team.Captain, TeamRevision: team.Revision,
			SubjectUserID: mapping.UserID, SubjectRevision: mapping.Revision, PresetRevision: preset.Revision,
			ProjectID: req.ProjectID, AgentID: req.AgentID}
	}
	grant.Status, grant.Capability = req.Status, req.Capability
	value, err := s.store.UpsertBotGrant(r.Context(), grant)
	if err != nil {
		writeError(w, 400, "invalid_bot_grant", err.Error())
		return
	}
	writeJSON(w, 200, value)
}

func (s *Server) runtimeBotAuthorization(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	realm := r.Header.Get("X-Lumo-Realm")
	if realm == "" {
		writeError(w, 401, "missing_realm", "realm required")
		return
	}
	var req struct {
		Channel         string `json:"channel"`
		Subject         string `json:"subject"`
		Sender          string `json:"sender_user_id"`
		BindingRevision int64  `json:"binding_revision"`
		GrantRevision   int64  `json:"grant_revision"`
		FlowID          string `json:"flow_id"`
		FlowVersion     int    `json:"flow_version"`
		NodeID          string `json:"node_id"`
		Author          string `json:"author_user_id"`
		ProjectID       string `json:"project_id"`
		TeamID          string `json:"team_id"`
		Captain         string `json:"captain_session_ref"`
		AgentID         string `json:"agent_id"`
		Capability      string `json:"capability"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	deny := func() {
		writeError(w, 403, "bot_authorization_denied", "current sender, Flow author, team, project and Agent grant are required")
	}
	if req.Channel == "" || req.Subject == "" || req.Sender == "" || req.BindingRevision < 1 || req.GrantRevision < 1 || req.FlowID == "" || req.FlowVersion < 1 || req.NodeID == "" || req.Capability != "delegation.create" {
		deny()
		return
	}
	mapping, err := s.store.BotSubject(r.Context(), realm, req.Channel, req.Subject)
	if err != nil || mapping.Status != "active" || mapping.UserID != req.Sender || mapping.Revision != req.BindingRevision {
		deny()
		return
	}
	grant, err := s.store.BotGrant(r.Context(), realm, req.Channel, req.Subject, req.TeamID, req.ProjectID, req.AgentID)
	if err != nil || grant.Status != "active" || grant.Revision != req.GrantRevision || grant.Captain != req.Captain || grant.SubjectUserID != mapping.UserID || grant.SubjectRevision != mapping.Revision {
		deny()
		return
	}
	team, err := s.currentBotTeam(r.Context(), realm, req.TeamID)
	if err != nil || team.Owner != grant.TeamOwner || team.Captain != grant.Captain || team.Revision != grant.TeamRevision {
		deny()
		return
	}
	author, project, operator, config, err := s.store.BotFlowNode(r.Context(), realm, req.FlowID, req.FlowVersion, req.NodeID)
	if err != nil || author != req.Author || project != req.ProjectID || operator != req.Capability || config["teamId"] != req.TeamID || config["captainSessionRef"] != req.Captain || config["projectId"] != project || config["assigneeWorkerId"] != "agent:"+req.AgentID {
		deny()
		return
	}
	principals := map[string]store.AuthPrincipal{}
	for _, user := range []string{req.Sender, author, team.Owner} {
		principal, e := s.store.RuntimeThreadPrincipal(r.Context(), realm, user)
		if e != nil {
			deny()
			return
		}
		principals[user] = principal
		member, e := s.store.ProjectMember(r.Context(), project, user)
		if e != nil || !member {
			deny()
			return
		}
		actor := caller{userID: user, realm: realm, roles: map[string]bool{}}
		for _, role := range principal.Roles {
			actor.roles[role] = true
		}
		decision, e := s.permissionDecision(r.Context(), actor, actionDelegate, domain.PermissionResource{Realm: realm, ProjectID: project, Kind: "bot-delegation"})
		if e != nil || !decision.Allowed {
			deny()
			return
		}
	}
	preset, err := s.store.GetAgentPreset(r.Context(), realm, req.AgentID)
	if err != nil || preset.Status != "active" || preset.ProjectID != project || preset.OwnerUserID != team.Owner || preset.Revision != grant.PresetRevision {
		deny()
		return
	}
	writeJSON(w, 200, map[string]any{"realm": realm, "user_id": req.Sender, "author_user_id": author, "project_id": project, "team_id": team.ID, "captain_session_ref": team.Captain, "agent_id": req.AgentID, "capability": req.Capability, "roles": principals[req.Sender].Roles, "team_revision": team.Revision, "preset_revision": preset.Revision})
}
