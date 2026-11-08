package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

type UserSecurityOverview struct {
	UserID            string                        `json:"user_id"`
	Status            string                        `json:"status"`
	OrganizationAdmin bool                          `json:"organization_admin"`
	Resolution        domain.RoleResolution         `json:"resolution"`
	Actions           []domain.PermissionActionInfo `json:"actions"`
}

type UserSecurityPageOptions struct {
	Limit  int
	Offset int
}

func (o *UserSecurityPageOptions) Normalize() error {
	if o.Limit == 0 {
		o.Limit = 25
	}
	if o.Limit < 1 || o.Limit > 100 || o.Offset < 0 || o.Offset > 1_000_000 {
		return fmt.Errorf("%w: invalid security page", ErrBadRequest)
	}
	return nil
}

type ManagedUserSession struct {
	ID         string    `json:"id"`
	ClientIP   string    `json:"client_ip"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type UserSessionPage struct {
	Sessions []ManagedUserSession `json:"sessions"`
	Total    int                  `json:"total"`
	Limit    int                  `json:"limit"`
	Offset   int                  `json:"offset"`
	HasMore  bool                 `json:"has_more"`
}

type UserSecurityEventPage struct {
	Events  []AuthSecurityEvent `json:"events"`
	Total   int                 `json:"total"`
	Limit   int                 `json:"limit"`
	Offset  int                 `json:"offset"`
	HasMore bool                `json:"has_more"`
}

// Authority is checked after acquiring the organization lock, including for
// sensitive reads. Gateway headers may predate an administrator's revocation.
func (s *Store) beginUserSecurityAccess(ctx context.Context, realm, userID, actor string) (pgx.Tx, string, error) {
	if !managedID.MatchString(userID) {
		return nil, "", ErrBadRequest
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return nil, "", err
	}
	if err = requireCurrentRolePolicyAdmin(ctx, tx, realm, actor); err != nil {
		_ = tx.Rollback(ctx)
		return nil, "", err
	}
	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM governance_users WHERE realm=$1 AND id=$2`, realm, userID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, "", err
	}
	return tx, status, nil
}

func (s *Store) UserSecurity(ctx context.Context, realm, userID, actor string) (UserSecurityOverview, error) {
	tx, status, err := s.beginUserSecurityAccess(ctx, realm, userID, actor)
	if err != nil {
		return UserSecurityOverview{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result := UserSecurityOverview{UserID: userID, Status: status, Actions: domain.PermissionActionCatalog()}
	direct := []string{}
	if status == "active" {
		rows, err := tx.Query(ctx, `SELECT r.id FROM governance_user_roles ur
 JOIN governance_roles r ON r.realm=ur.realm AND r.id=ur.role_id
 WHERE ur.realm=$1 AND ur.user_id=$2 AND r.status='active'
 AND (ur.expires_at IS NULL OR ur.expires_at>clock_timestamp()) ORDER BY r.id`, realm, userID)
		if err != nil {
			return result, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return result, err
			}
			direct = append(direct, id)
			result.OrganizationAdmin = result.OrganizationAdmin || id == "platform_admin" || id == "realm_admin" || id == "admin"
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return result, err
		}
	}
	catalog, err := readRolePolicyCatalog(ctx, tx, realm)
	if err != nil {
		return result, err
	}
	result.Resolution, err = domain.ResolveRolePolicy(direct, catalog)
	if err != nil {
		return result, ErrRolePolicyUnavailable
	}
	return result, nil
}

func (s *Store) UserSessions(ctx context.Context, realm, userID, actor string, options UserSecurityPageOptions) (UserSessionPage, error) {
	result := UserSessionPage{Sessions: []ManagedUserSession{}}
	if err := options.Normalize(); err != nil {
		return result, err
	}
	tx, _, err := s.beginUserSecurityAccess(ctx, realm, userID, actor)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw []byte
	// Count and page share one statement snapshot. Project only revocation IDs,
	// never token_hash or authentication material.
	err = tx.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM governance_auth_sessions WHERE realm=$1 AND user_id=$2 AND expires_at>statement_timestamp()),
 COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY last_seen_at DESC,created_at DESC,id DESC) FROM (
 SELECT session_id AS id,client_ip,created_at,last_seen_at,expires_at FROM governance_auth_sessions
 WHERE realm=$1 AND user_id=$2 AND expires_at>statement_timestamp()
 ORDER BY last_seen_at DESC,created_at DESC,session_id DESC LIMIT $3 OFFSET $4
 ) page),'[]'::jsonb)`, realm, userID, options.Limit, options.Offset).Scan(&result.Total, &raw)
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(raw, &result.Sessions); err != nil {
		return result, err
	}
	result.Limit, result.Offset = options.Limit, options.Offset
	result.HasMore = result.Offset+len(result.Sessions) < result.Total
	return result, nil
}

func (s *Store) UserSecurityEvents(ctx context.Context, realm, userID, actor string, options UserSecurityPageOptions) (UserSecurityEventPage, error) {
	result := UserSecurityEventPage{Events: []AuthSecurityEvent{}}
	if err := options.Normalize(); err != nil {
		return result, err
	}
	tx, _, err := s.beginUserSecurityAccess(ctx, realm, userID, actor)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM governance_auth_security_events WHERE realm=$1 AND user_id=$2),
 COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,id DESC) FROM (
 SELECT id,event,client_ip,detail,created_at FROM governance_auth_security_events WHERE realm=$1 AND user_id=$2
 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4
 ) page),'[]'::jsonb)`, realm, userID, options.Limit, options.Offset).Scan(&result.Total, &raw)
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(raw, &result.Events); err != nil {
		return result, err
	}
	result.Limit, result.Offset = options.Limit, options.Offset
	result.HasMore = result.Offset+len(result.Events) < result.Total
	return result, nil
}

// An empty session ID explicitly means all sessions. Logout and its audit are
// atomic; concurrent password logins serialize on the same organization lock.
func (s *Store) RevokeUserSessions(ctx context.Context, realm, userID, sessionID, actor, reason string) (int64, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" || len([]rune(reason)) > 500 || (sessionID != "" && !managedID.MatchString(sessionID)) {
		return 0, fmt.Errorf("%w: session ID or revocation reason is invalid", ErrBadRequest)
	}
	tx, _, err := s.beginUserSecurityAccess(ctx, realm, userID, actor)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE realm=$1 AND user_id=$2 AND ($3='' OR session_id=$3)`, realm, userID, sessionID)
	if err != nil {
		return 0, err
	}
	count := tag.RowsAffected()
	if sessionID != "" && count == 0 {
		return 0, ErrNotFound
	}
	event := "admin_sessions_revoked"
	if sessionID != "" {
		event = "admin_session_revoked"
	}
	if err = recordUserAdminEvent(ctx, tx, realm, userID, event, actor, map[string]any{"session_id": sessionID, "count": count, "reason": reason}); err != nil {
		return 0, err
	}
	return count, tx.Commit(ctx)
}
