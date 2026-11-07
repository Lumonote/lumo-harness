package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/observability"
)

type botScopeKey struct{}
type botExecutionScope struct {
	Sender      domain.BotScope
	FlowID      string
	FlowVersion int
}

// WithBotScope accepts only durable server-side metadata. Event JSON remains
// ordinary input and cannot add or replace this execution boundary.
func WithBotScope(ctx context.Context, raw json.RawMessage, flowID string, version int) (context.Context, error) {
	if len(raw) == 0 {
		return ctx, nil
	}
	var scope domain.BotScope
	if err := json.Unmarshal(raw, &scope); err != nil || scope.Channel == "" || scope.MessageID == "" || flowID == "" || version < 1 {
		return ctx, fmt.Errorf("invalid durable Bot execution scope")
	}
	return context.WithValue(ctx, botScopeKey{}, botExecutionScope{scope, flowID, version}), nil
}

func (config RuntimeConfig) authorizeBot(ctx context.Context, identity observability.Identity, node domain.FlowNode) (observability.Identity, error) {
	scope, isBot := ctx.Value(botScopeKey{}).(botExecutionScope)
	if !isBot {
		return identity, nil
	}
	if scope.Sender.Subject == "" || scope.Sender.UserID == "" || scope.Sender.BindingRevision < 1 {
		return observability.Identity{}, fmt.Errorf("Bot operator requires an authenticated mapped sender")
	}
	if node.Operator != "delegation.create" {
		return observability.Identity{}, fmt.Errorf("Bot grants currently support only delegation.create")
	}
	team, _ := node.Config["teamId"].(string)
	captain, _ := node.Config["captainSessionRef"].(string)
	worker, _ := node.Config["assigneeWorkerId"].(string)
	if team == "" || captain == "" || !strings.HasPrefix(worker, "agent:") || strings.TrimPrefix(worker, "agent:") == "" {
		return observability.Identity{}, fmt.Errorf("Bot delegation requires reviewed teamId, captainSessionRef and Agent worker")
	}
	var grantRevision int64
	for _, grant := range scope.Sender.Grants {
		if grant.TeamID == team && grant.ProjectID == identity.ProjectID && grant.AgentID == strings.TrimPrefix(worker, "agent:") && grant.Capability == node.Operator {
			grantRevision = grant.Revision
			break
		}
	}
	if grantRevision < 1 {
		return observability.Identity{}, fmt.Errorf("Bot delegation requires a frozen capability grant from ingress")
	}
	body, _ := json.Marshal(map[string]any{"channel": scope.Sender.Channel, "subject": scope.Sender.Subject,
		"sender_user_id": scope.Sender.UserID, "binding_revision": scope.Sender.BindingRevision,
		"grant_revision": grantRevision,
		"flow_id":        scope.FlowID, "flow_version": scope.FlowVersion, "node_id": node.ID, "author_user_id": identity.UserID,
		"project_id": identity.ProjectID, "team_id": team, "captain_session_ref": captain, "agent_id": strings.TrimPrefix(worker, "agent:"),
		"capability": "delegation.create"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(config.GovernanceURL, "/")+"/v1/runtime/bot-authorization", bytes.NewReader(body))
	if err != nil {
		return observability.Identity{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+config.ControlToken)
	req.Header.Set("X-Lumo-Realm", identity.Realm)
	res, err := config.Client.Do(req)
	if err != nil {
		return observability.Identity{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return observability.Identity{}, fmt.Errorf("current Bot authorization denied: HTTP %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<10+1))
	if err != nil || len(raw) > 64<<10 {
		return observability.Identity{}, fmt.Errorf("invalid Bot authorization response")
	}
	var result struct {
		Realm        string   `json:"realm"`
		UserID       string   `json:"user_id"`
		AuthorUserID string   `json:"author_user_id"`
		ProjectID    string   `json:"project_id"`
		AgentID      string   `json:"agent_id"`
		TeamID       string   `json:"team_id"`
		Captain      string   `json:"captain_session_ref"`
		Capability   string   `json:"capability"`
		Roles        []string `json:"roles"`
	}
	if err := json.Unmarshal(raw, &result); err != nil || result.Realm != identity.Realm || result.UserID != scope.Sender.UserID || result.AuthorUserID != identity.UserID || result.ProjectID != identity.ProjectID || result.AgentID != strings.TrimPrefix(worker, "agent:") || result.TeamID != team || result.Captain != captain || result.Capability != "delegation.create" || len(result.Roles) == 0 {
		return observability.Identity{}, fmt.Errorf("inconsistent Bot authorization receipt")
	}
	identity.UserID, identity.Roles = result.UserID, result.Roles
	return identity, nil
}
