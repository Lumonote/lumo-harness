package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// RuntimeThreadPrincipal reads the exact active execution owner and its current
// role grants. Runtime service credentials prove the calling service, not the
// user's permissions; neither identity nor roles are taken from user headers.
func (s *Store) RuntimeThreadPrincipal(ctx context.Context, realm, userID string) (AuthPrincipal, error) {
	var principal AuthPrincipal
	err := s.pool.QueryRow(ctx, `SELECT u.realm,u.id,u.display_name,u.primary_dept_id,
		ARRAY(SELECT ur.role_id FROM governance_user_roles ur
		  JOIN governance_roles r ON r.realm=ur.realm AND r.id=ur.role_id AND r.status='active'
		  WHERE ur.realm=u.realm AND ur.user_id=u.id
		    AND (ur.expires_at IS NULL OR ur.expires_at>now()) ORDER BY ur.role_id)
		FROM governance_users u WHERE u.realm=$1 AND u.id=$2 AND u.status='active'`, realm, userID).
		Scan(&principal.Realm, &principal.UserID, &principal.DisplayName, &principal.PrimaryDeptID, &principal.Roles)
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthPrincipal{}, ErrNotFound
	}
	return principal, err
}
