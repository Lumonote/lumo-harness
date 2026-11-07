package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

// UserDirectoryOptions filters before pagination so a status or department
// cannot disappear merely because its users sort beyond the first 200 rows.
type UserDirectoryOptions struct {
	Query        string
	Status       string
	DepartmentID string
	Limit        int
	Offset       int
}

type UserDirectoryPage struct {
	Users   []domain.User `json:"users"`
	Total   int64         `json:"total"`
	Limit   int           `json:"limit"`
	Offset  int           `json:"offset"`
	HasMore bool          `json:"has_more"`
}

func (options *UserDirectoryOptions) Normalize() error {
	options.Query = strings.TrimSpace(options.Query)
	options.DepartmentID = strings.TrimSpace(options.DepartmentID)
	if len([]rune(options.Query)) > 200 || (options.Status != "" && !validUserStatus(options.Status)) ||
		(options.DepartmentID != "" && !managedID.MatchString(options.DepartmentID)) ||
		options.Limit < 1 || options.Limit > 200 || options.Offset < 0 {
		return fmt.Errorf("%w: invalid user directory filter or page", ErrBadRequest)
	}
	return nil
}

// ListUsersPage is a live directory. Each page and its total share a read-only
// snapshot; a later page reapplies the current realm and filters. In particular,
// callers never supply a realm through the filter or a pagination token.
func (s *Store) ListUsersPage(ctx context.Context, realm string, options UserDirectoryOptions) (UserDirectoryPage, error) {
	page := UserDirectoryPage{Users: []domain.User{}, Limit: options.Limit, Offset: options.Offset}
	if realm == "" {
		return page, fmt.Errorf("%w: realm is required", ErrBadRequest)
	}
	if err := options.Normalize(); err != nil {
		return page, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return page, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const filter = ` FROM governance_users WHERE realm=$1
		AND ($2='' OR strpos(lower(id),lower($2))>0 OR strpos(lower(display_name),lower($2))>0)
		AND ($3='' OR status=$3) AND ($4='' OR primary_dept_id=$4)`
	args := []any{realm, options.Query, options.Status, options.DepartmentID}
	if err := tx.QueryRow(ctx, `SELECT count(*)`+filter, args...).Scan(&page.Total); err != nil {
		return page, err
	}
	rows, err := tx.Query(ctx, `SELECT id,realm,display_name,primary_dept_id,status,source,created_at,updated_at`+
		filter+` ORDER BY display_name,id LIMIT $5 OFFSET $6`, append(args, options.Limit, options.Offset)...)
	if err != nil {
		return page, err
	}
	for rows.Next() {
		var user domain.User
		if err := rows.Scan(&user.ID, &user.Realm, &user.DisplayName, &user.PrimaryDeptID, &user.Status, &user.Source, &user.CreatedAt, &user.UpdatedAt); err != nil {
			rows.Close()
			return page, err
		}
		page.Users = append(page.Users, user)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return page, err
	}
	page.HasMore = int64(options.Offset) < page.Total && int64(len(page.Users)) < page.Total-int64(options.Offset)
	return page, tx.Commit(ctx)
}
