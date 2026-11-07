package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
)

func TestUserDirectoryQueryValidation(t *testing.T) {
	options, err := parseUserDirectoryOptions(url.Values{})
	if err != nil || options.Limit != 200 || options.Offset != 0 {
		t.Fatalf("compatible defaults = %#v, %v", options, err)
	}
	options, err = parseUserDirectoryOptions(url.Values{"q": {" Person "}, "status": {"suspended"}, "department_id": {" sales "}, "limit": {"50"}, "offset": {"200"}})
	if err != nil || options.Query != "Person" || options.DepartmentID != "sales" || options.Status != "suspended" || options.Limit != 50 || options.Offset != 200 {
		t.Fatalf("filtered page = %#v, %v", options, err)
	}
	for _, raw := range []string{
		"limit=0", "limit=201", "limit=-1", "limit=1.5", "limit=", "limit=%2B2", "limit=99999999999999999999999",
		"offset=-1", "offset=", "offset=1.5", "status=all", "status=deleted", "department_id=../other",
		"limit=50&limit=100", "offset=0&offset=1", "q=a&q=b", "status=active&status=disabled",
		"department_id=sales&department_id=hr", "q=" + strings.Repeat("x", 201),
	} {
		values, _ := url.ParseQuery(raw)
		if _, err := parseUserDirectoryOptions(values); !errors.Is(err, store.ErrBadRequest) {
			t.Fatalf("accepted invalid query %q: %v", raw, err)
		}
	}
}

func TestUserDirectoryHTTPPagesKeepExistingAuthorityBoundary(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	if _, err := pool.Exec(context.Background(), `INSERT INTO governance_users(realm,id,display_name,primary_dept_id,status)
		SELECT 'r1','directory-'||lpad(n::text,3,'0'),'Person',
		CASE WHEN n>200 THEN 'late' ELSE 'main' END,CASE WHEN n>200 THEN 'disabled' ELSE 'active' END
		FROM generate_series(1,205) n;
		INSERT INTO governance_users(realm,id,display_name,status) VALUES ('r2','private','Person','active')`); err != nil {
		t.Fatal(err)
	}
	handler := receiptHTTPHandler(t, st)
	request := func(path, realm, role string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("X-Lumo-Realm", realm)
		r.Header.Set("X-Lumo-User", "u1")
		r.Header.Set("X-Lumo-Roles", role)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, role := range []string{"platform_admin", "realm_admin", "manager"} {
		w := request("/v1/users?q=Person&limit=200", "r1", role)
		var page store.UserDirectoryPage
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &page) != nil || page.Total != 205 || len(page.Users) != 200 || !page.HasMore || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("role %s page: %d %s", role, w.Code, w.Body)
		}
		last := request("/v1/users?q=Person&offset=200&limit=200", "r1", role)
		if last.Code != http.StatusOK || json.Unmarshal(last.Body.Bytes(), &page) != nil || page.Total != 205 || len(page.Users) != 5 || page.HasMore || page.Users[0].ID != "directory-201" {
			t.Fatalf("role %s last page: %d %s", role, last.Code, last.Body)
		}
	}
	var filtered struct {
		Users []domain.User `json:"users"`
		Total int           `json:"total"`
	}
	w := request("/v1/users?status=disabled&department_id=late", "r1", "platform_admin")
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &filtered) != nil || filtered.Total != 5 || len(filtered.Users) != 5 {
		t.Fatalf("global filters: %d %s", w.Code, w.Body)
	}
	for _, tc := range []struct {
		path, realm, role string
		want              int
	}{
		{"/v1/users?limit=50&offset=200", "r1", "viewer", http.StatusForbidden},
		{"/v1/users?limit=50&offset=200", "r1", "employee", http.StatusForbidden},
		{"/v1/users?limit=50&offset=200", "r1", "", http.StatusForbidden},
		{"/v1/users?limit=50&offset=200", "", "platform_admin", http.StatusUnauthorized},
		{"/v1/users?limit=201", "r1", "platform_admin", http.StatusBadRequest},
	} {
		w := request(tc.path, tc.realm, tc.role)
		if w.Code != tc.want {
			t.Fatalf("realm=%s role=%s path=%s: %d want %d: %s", tc.realm, tc.role, tc.path, w.Code, tc.want, w.Body)
		}
	}
	w = request("/v1/users?q=Person", "r2", "platform_admin")
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &filtered) != nil || filtered.Total != 1 || len(filtered.Users) != 1 || filtered.Users[0].ID != "private" {
		t.Fatalf("realm scope: %d %s", w.Code, w.Body)
	}
}
