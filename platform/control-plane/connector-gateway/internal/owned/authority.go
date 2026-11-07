package owned

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
)

type Grant struct {
	Realm       string `json:"realm"`
	ProjectID   string `json:"project_id"`
	ConnectorID string `json:"connector_id"`
	Operation   string `json:"operation"`
}
type Authority struct {
	Store       *Store
	Grants      []Grant
	base, token string
	client      *http.Client
}

func NewAuthority(store *Store, base, token string, grants []Grant) (*Authority, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.TrimSpace(token) == "" || len(grants) > 100 {
		return nil, ErrDenied
	}
	for _, g := range grants {
		for _, v := range []string{g.Realm, g.ProjectID, g.ConnectorID, g.Operation} {
			if v == "" || len(v) > 128 || strings.ContainsAny(v, "\x00\r\n/") {
				return nil, ErrDenied
			}
		}
	}
	return &Authority{Store: store, Grants: append([]Grant(nil), grants...), base: strings.TrimRight(base, "/"), token: token, client: &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect denied") }}}, nil
}
func (a *Authority) Allowed(scope Scope, connector, operation string) bool {
	for _, g := range a.Grants {
		if g.Realm == scope.Realm && g.ProjectID == scope.ProjectID && g.ConnectorID == connector && g.Operation == operation {
			return true
		}
	}
	return false
}
func (a *Authority) json(ctx context.Context, path, credential string, headers map[string]string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base+path, nil)
	if err != nil {
		return ErrDenied
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	if credential != "" {
		req.Header.Set("X-Lumo-Session", credential)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	res, err := a.client.Do(req)
	if err != nil {
		return ErrDenied
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return ErrDenied
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 128*1024+1))
	if err != nil || len(raw) > 128*1024 || json.Unmarshal(raw, out) != nil {
		return ErrDenied
	}
	return nil
}

// Resolve independently authenticates the login and current project permission;
// arbitrary X-Lumo user/roles headers never supply the owned execution identity.
func (a *Authority) Resolve(ctx context.Context, credential string, in Scope) (domain.Caller, error) {
	if len(credential) < 1 || len(credential) > 4096 || strings.ContainsAny(credential, "\r\n\x00") {
		return domain.Caller{}, ErrDenied
	}
	var auth struct {
		Principal struct {
			Realm  string   `json:"realm"`
			UserID string   `json:"user_id"`
			Roles  []string `json:"roles"`
			DeptID string   `json:"primary_dept_id"`
		} `json:"principal"`
	}
	if a.json(ctx, "/v1/auth/session", credential, nil, &auth) != nil || auth.Principal.Realm == "" || auth.Principal.UserID == "" {
		return domain.Caller{}, ErrDenied
	}
	in.Realm = auth.Principal.Realm
	in.UserID = auth.Principal.UserID
	var permission struct {
		Decisions []struct {
			Action  string `json:"action"`
			Allowed bool   `json:"allowed"`
		} `json:"decisions"`
	}
	if a.json(ctx, "/v1/effective-permissions?project_id="+url.QueryEscape(in.ProjectID), "", map[string]string{"X-Lumo-Realm": in.Realm, "X-Lumo-User": in.UserID, "X-Lumo-Roles": strings.Join(auth.Principal.Roles, ",")}, &permission) != nil {
		return domain.Caller{}, ErrDenied
	}
	granted := false
	for _, decision := range permission.Decisions {
		if decision.Action == "task:delegate" && decision.Allowed {
			granted = true
		}
	}
	if !granted || a.Store.Authorize(ctx, in) != nil {
		return domain.Caller{}, ErrDenied
	}
	return domain.Caller{Realm: domain.RealmID(in.Realm), UserID: in.UserID, Roles: auth.Principal.Roles, ProjectID: in.ProjectID, SessionID: in.SessionRef, DeptID: auth.Principal.DeptID, AgentID: "lumo-user-session", ComponentID: "user-auth", Feature: "session:connector"}, nil
}
