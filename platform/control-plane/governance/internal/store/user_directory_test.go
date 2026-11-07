package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestUserDirectoryPagesFilterTheWholeRealm(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	_, err := s.pool.Exec(ctx, `INSERT INTO governance_users(realm,id,display_name,primary_dept_id,status)
		SELECT 'directory','person-'||lpad(n::text,3,'0'),'Person',
		CASE WHEN n>200 THEN 'late-department' ELSE 'main' END,
		CASE WHEN n>200 THEN 'disabled' ELSE 'active' END FROM generate_series(1,205) n;
		INSERT INTO governance_users(realm,id,display_name,status) VALUES
		('other-realm','private','Person','active'),('directory','literal','100%_matched','suspended')`)
	if err != nil {
		t.Fatal(err)
	}
	options := UserDirectoryOptions{Query: "Person", Limit: 200}
	first, err := s.ListUsersPage(ctx, "directory", options)
	if err != nil || len(first.Users) != 200 || first.Total != 205 || !first.HasMore {
		t.Fatalf("first page = %#v, %v", first, err)
	}
	seen := map[string]bool{}
	for _, user := range first.Users {
		seen[user.ID] = true
		if user.Realm != "directory" {
			t.Fatalf("foreign realm user: %#v", user)
		}
	}
	options.Offset = 200
	second, err := s.ListUsersPage(ctx, "directory", options)
	if err != nil || len(second.Users) != 5 || second.Total != 205 || second.HasMore {
		t.Fatalf("second page = %#v, %v", second, err)
	}
	for index, user := range second.Users {
		if seen[user.ID] || user.ID != fmt.Sprintf("person-%03d", 201+index) {
			t.Fatalf("unstable ordering or duplicate: %#v", user)
		}
	}
	options.Offset = 0
	options.Status = "disabled"
	options.DepartmentID = "late-department"
	filtered, err := s.ListUsersPage(ctx, "directory", options)
	if err != nil || len(filtered.Users) != 5 || filtered.Total != 5 || filtered.HasMore {
		t.Fatalf("filters were applied after truncation: %#v, %v", filtered, err)
	}
	options.Offset = 500
	empty, err := s.ListUsersPage(ctx, "directory", options)
	if err != nil || empty.Users == nil || len(empty.Users) != 0 || empty.Total != 5 || empty.HasMore {
		t.Fatalf("empty page loses total or array shape: %#v, %v", empty, err)
	}
	for _, query := range []string{"%", "_", "100%_", "MATCHED"} {
		literal, err := s.ListUsersPage(ctx, "directory", UserDirectoryOptions{Query: query, Limit: 50})
		if err != nil || literal.Total != 1 || len(literal.Users) != 1 || literal.Users[0].ID != "literal" {
			t.Fatalf("literal query %q = %#v, %v", query, literal, err)
		}
	}
}

func TestUserDirectoryRejectsInvalidFiltersBeforeDatabaseAccess(t *testing.T) {
	s := &Store{}
	for _, options := range []UserDirectoryOptions{
		{Limit: 0}, {Limit: 201}, {Limit: 50, Offset: -1},
		{Limit: 50, Status: "all"}, {Limit: 50, DepartmentID: "../other"},
	} {
		if _, err := s.ListUsersPage(context.Background(), "realm", options); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("invalid options %#v: %v", options, err)
		}
	}
	if _, err := s.ListUsersPage(context.Background(), "", UserDirectoryOptions{Limit: 50}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("empty realm: %v", err)
	}
}
