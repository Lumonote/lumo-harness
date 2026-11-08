package server

import (
	"context"
	"net/url"
	"strings"
	"testing"
)

func TestUserSecurityPaginationValidation(t *testing.T) {
	for _, query := range []string{"limit=0", "limit=101", "offset=-1", "offset=1000001", "limit=25&limit=10", "offset=", "realm=other", "limit=%2B5", "limit=999999999999999999999"} {
		values, _ := url.ParseQuery(query)
		if _, err := parseUserSecurityPage(values); err == nil {
			t.Fatalf("accepted invalid query %q", query)
		}
	}
	options, err := parseUserSecurityPage(url.Values{"limit": {"10"}, "offset": {"20"}})
	if err != nil || options.Limit != 10 || options.Offset != 20 {
		t.Fatalf("valid page: %+v %v", options, err)
	}
}

func TestUserSecurityHTTPAuthorityPrivacyAndRevocation(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO governance_roles(realm,id,name,status) VALUES('r1','realm_admin','Admin','active');
 INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('r1','u1','realm_admin','u1');
 INSERT INTO governance_auth_sessions(token_hash,session_id,realm,user_id,client_ip,expires_at) VALUES('top-secret-hash','session-http','r1','worker','127.0.0.1',now()+interval '1 day')`); err != nil {
		t.Fatal(err)
	}
	handler := receiptHTTPHandler(t, st)
	for _, suffix := range []string{"security", "sessions", "security-events"} {
		path := "/v1/users/worker/" + suffix
		w := rolePolicyRequest(handler, "GET", path, "viewer", "")
		if w.Code != 403 {
			t.Fatalf("viewer security access: %s %d", suffix, w.Code)
		}
		w = rolePolicyRequest(handler, "GET", path, "realm_admin", "")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "top-secret-hash") || strings.Contains(w.Body.String(), "token_hash") {
			t.Fatalf("admin projection %s: %d %s", suffix, w.Code, w.Body)
		}
	}
	for _, body := range []string{`{}`, `{"reason":" "}`, `{"reason":"lost","actor":"forged"}`, `{"reason":"lost"} {}`} {
		w := rolePolicyRequest(handler, "DELETE", "/v1/users/worker/sessions/session-http", "realm_admin", body)
		if w.Code != 400 {
			t.Fatalf("invalid revocation body: %s %d %s", body, w.Code, w.Body)
		}
	}
	w := rolePolicyRequest(handler, "DELETE", "/v1/users/worker/sessions/session-http", "realm_admin", `{"reason":"device lost"}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"revoked":1`) {
		t.Fatalf("revocation: %d %s", w.Code, w.Body)
	}
	w = rolePolicyRequest(handler, "GET", "/v1/users/worker/security-events", "realm_admin", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"actor":"u1"`) || !strings.Contains(w.Body.String(), `"reason":"device lost"`) {
		t.Fatalf("audit: %d %s", w.Code, w.Body)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM governance_user_roles WHERE realm='r1' AND user_id='u1'`); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"security", "sessions", "security-events"} {
		w = rolePolicyRequest(handler, "GET", "/v1/users/worker/"+suffix, "realm_admin", "")
		if w.Code != 403 {
			t.Fatalf("revoked actor reads %s: %d %s", suffix, w.Code, w.Body)
		}
	}
	w = rolePolicyRequest(handler, "DELETE", "/v1/users/worker/sessions", "realm_admin", `{"reason":"stale admin"}`)
	if w.Code != 403 {
		t.Fatalf("revoked actor can force logout: %d %s", w.Code, w.Body)
	}
}
