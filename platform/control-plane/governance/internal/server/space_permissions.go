package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lumo-harness/platform/observability"
)

var errSpaceAuthorizationUnavailable = errors.New("trusted Space authorization unavailable")

func validateCollaboratorURL(raw, token string) error {
	if raw == "" {
		return nil
	}
	base, err := url.Parse(raw)
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.RawQuery != "" || base.Fragment != "" || token == "" {
		return fmt.Errorf("governance: LUMO_COLLABORATOR_URL requires a trusted HTTP(S) service URL and control-plane token")
	}
	return nil
}

// currentSpacePermission deliberately has no cache: every decision observes
// the authoritative service's current grant, including explicit revocation.
// The supported Governance actions can start or mutate work; both require
// read AND edit because Collaborator grants each permission independently.
func (s *Server) currentSpacePermission(ctx context.Context, c caller, spaceID string) (*bool, error) {
	if s.cfg.CollaboratorURL == "" {
		return nil, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.cfg.CollaboratorURL, "/")+"/v1/runtime/spaces/"+url.PathEscape(spaceID)+"/permissions", nil)
	if err != nil {
		return nil, errSpaceAuthorizationUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.ControlPlaneToken)
	req.Header.Set("X-Lumo-Realm", c.realm)
	req.Header.Set("X-Lumo-User", c.userID)
	client := observability.ConfiguredHTTPClient(3 * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := client.Do(req)
	if err != nil {
		return nil, errSpaceAuthorizationUnavailable
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, errSpaceAuthorizationUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, (16<<10)+1))
	if err != nil || len(raw) > 16<<10 {
		return nil, errSpaceAuthorizationUnavailable
	}
	var facts struct {
		Realm       string   `json:"realm"`
		SpaceID     string   `json:"space_id"`
		UserID      string   `json:"user_id"`
		Permissions []string `json:"permissions"`
	}
	if json.Unmarshal(raw, &facts) != nil || facts.Realm != c.realm || facts.SpaceID != spaceID || facts.UserID != c.userID || facts.Permissions == nil {
		return nil, errSpaceAuthorizationUnavailable
	}
	read, edit := false, false
	for _, permission := range facts.Permissions {
		switch permission {
		case "read":
			read = true
		case "edit":
			edit = true
		case "comment", "publish":
		default:
			return nil, errSpaceAuthorizationUnavailable
		}
	}
	allowed := read && edit
	return &allowed, nil
}
