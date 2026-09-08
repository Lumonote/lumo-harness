package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	authcrypto "github.com/lumo-harness/platform/governance/internal/auth"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

var managedID = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$`)

var ErrLastAdmin = errors.New("cannot remove the last active administrator")

type LocalUser struct {
	User     domain.User
	Username string
	Password string
}

type UserRole struct {
	RoleID    string     `json:"role_id"`
	Name      string     `json:"name"`
	Status    string     `json:"status"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	GrantedBy string     `json:"granted_by"`
}

type UserAccess struct {
	Username          string     `json:"username"`
	LoginEnabled      bool       `json:"login_enabled"`
	Roles             []UserRole `json:"roles"`
	OIDC              *OIDCLink  `json:"oidc,omitempty"`
	OIDCAvailable     bool       `json:"oidc_available"`
	OIDCIssuer        string     `json:"oidc_issuer,omitempty"`
	LocalLoginEnabled bool       `json:"local_login_enabled"`
}

func validateManagedUser(user *domain.User) error {
	user.ID = strings.TrimSpace(user.ID)
	user.DisplayName = strings.TrimSpace(user.DisplayName)
	user.PrimaryDeptID = strings.TrimSpace(user.PrimaryDeptID)
	if user.Status == "" {
		user.Status = "active"
	}
	if !managedID.MatchString(user.ID) || user.Realm == "" || user.DisplayName == "" || len([]rune(user.DisplayName)) > 160 || !validUserStatus(user.Status) {
		return fmt.Errorf("%w: invalid user id, display name, realm, or status", ErrBadRequest)
	}
	if user.PrimaryDeptID != "" && !managedID.MatchString(user.PrimaryDeptID) {
		return fmt.Errorf("%w: invalid department id", ErrBadRequest)
	}
	return nil
}

func credentialHash(username, password string) (string, string, error) {
	username = normalizeUsername(username)
	if username == "" || len(username) > 128 || strings.ContainsAny(username, " \t\r\n\x00") {
		return "", "", fmt.Errorf("%w: invalid login username", ErrBadRequest)
	}
	hash, err := authcrypto.HashPassword(password)
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	return username, hash, nil
}

// Serialize organization mutations across replicas, including last-admin checks.
func (s *Store) beginOrganizationChange(ctx context.Context, realm string) (pgx.Tx, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('lumo:organization:' || $1, 0))`, realm); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

func checkUserDepartment(ctx context.Context, tx pgx.Tx, user domain.User) error {
	if user.PrimaryDeptID == "" {
		return nil
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_departments WHERE realm=$1 AND id=$2 AND status='active')`, user.Realm, user.PrimaryDeptID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%w: department must be active and belong to this realm", ErrBadRequest)
	}
	return nil
}

type administratorCounts struct {
	active       int
	durable      int
	local        int
	durableLocal int
}

func (s *Store) activeAdminCount(ctx context.Context, tx pgx.Tx, realm string) (administratorCounts, error) {
	var count administratorCounts
	err := tx.QueryRow(ctx, `SELECT count(DISTINCT u.id), count(DISTINCT u.id) FILTER (WHERE ur.expires_at IS NULL),
		count(DISTINCT u.id) FILTER (WHERE c.enabled), count(DISTINCT u.id) FILTER (WHERE c.enabled AND ur.expires_at IS NULL)
		FROM governance_users u
		LEFT JOIN governance_auth_credentials c ON c.realm=u.realm AND c.user_id=u.id AND c.enabled
		LEFT JOIN governance_auth_oidc_identities i ON i.realm=u.realm AND i.user_id=u.id AND i.enabled AND i.issuer=$2 AND i.realm=$3
		JOIN governance_user_roles ur ON ur.realm=u.realm AND ur.user_id=u.id
		JOIN governance_roles r ON r.realm=ur.realm AND r.id=ur.role_id AND r.status='active'
		WHERE u.realm=$1 AND u.status='active' AND r.id IN ('realm_admin','platform_admin','admin')
		AND (c.enabled OR i.user_id IS NOT NULL) AND (ur.expires_at IS NULL OR ur.expires_at>now())`, realm, s.oidcIssuer, s.oidcRealm).Scan(&count.active, &count.durable, &count.local, &count.durableLocal)
	return count, err
}

func (s *Store) preserveActiveAdmin(ctx context.Context, tx pgx.Tx, realm string, before administratorCounts) error {
	count, err := s.activeAdminCount(ctx, tx, realm)
	if err == nil && ((before.active > 0 && count.active == 0) || (before.durable > 0 && count.durable == 0) || (before.local > 0 && count.local == 0) || (before.durableLocal > 0 && count.durableLocal == 0)) {
		return ErrLastAdmin
	}
	return err
}

func recordUserAdminEvent(ctx context.Context, tx pgx.Tx, realm, userID, event, actor string, detail map[string]any) error {
	if detail == nil {
		detail = map[string]any{}
	}
	detail["actor"] = actor
	body, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO governance_auth_security_events (realm,user_id,event,detail) VALUES ($1,$2,$3,$4)`, realm, userID, event, body)
	return err
}

func (s *Store) CreateLocalUser(ctx context.Context, input LocalUser, actor string) (domain.User, error) {
	user := input.User
	if err := validateManagedUser(&user); err != nil {
		return domain.User{}, err
	}
	username, hash, err := credentialHash(input.Username, input.Password)
	if err != nil {
		return domain.User{}, err
	}
	tx, err := s.beginOrganizationChange(ctx, user.Realm)
	if err != nil {
		return domain.User{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := checkUserDepartment(ctx, tx, user); err != nil {
		return domain.User{}, err
	}
	user.Source = "local"
	err = tx.QueryRow(ctx, `INSERT INTO governance_users (realm,id,display_name,primary_dept_id,status,source)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at,updated_at`, user.Realm, user.ID, user.DisplayName, user.PrimaryDeptID, user.Status, user.Source).Scan(&user.CreatedAt, &user.UpdatedAt)
	if isUniqueViolation(err) {
		return domain.User{}, ErrConflict
	}
	if err != nil {
		return domain.User{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO governance_auth_credentials (realm,user_id,username,password_hash) VALUES ($1,$2,$3,$4)`, user.Realm, user.ID, username, hash)
	if isUniqueViolation(err) {
		return domain.User{}, ErrConflict
	}
	if err != nil {
		return domain.User{}, err
	}
	if err = recordUserAdminEvent(ctx, tx, user.Realm, user.ID, "user_created", actor, nil); err != nil {
		return domain.User{}, err
	}
	return user, tx.Commit(ctx)
}

func (s *Store) GetUserAccess(ctx context.Context, realm, userID string) (UserAccess, error) {
	access := UserAccess{Roles: []UserRole{}}
	var issuer, subject string
	var oidcEnabled bool
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(c.username,''),
		(COALESCE(c.enabled,false) OR COALESCE(i.enabled AND i.issuer=$3 AND i.realm=$4 AND i.issuer<>'',false)) AND u.status='active',
		COALESCE(i.issuer,''),COALESCE(i.subject,''),COALESCE(i.enabled,false),COALESCE(c.enabled,false) AND u.status='active'
		FROM governance_users u LEFT JOIN governance_auth_credentials c ON c.realm=u.realm AND c.user_id=u.id
		LEFT JOIN governance_auth_oidc_identities i ON i.realm=u.realm AND i.user_id=u.id
		WHERE u.realm=$1 AND u.id=$2`, realm, userID, s.oidcIssuer, s.oidcRealm).Scan(&access.Username, &access.LoginEnabled, &issuer, &subject, &oidcEnabled, &access.LocalLoginEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return access, ErrNotFound
	}
	if err != nil {
		return access, err
	}
	if issuer != "" {
		access.OIDC = &OIDCLink{Issuer: issuer, Subject: subject, Enabled: oidcEnabled}
	}
	if s.oidcIssuer != "" && s.oidcRealm == realm {
		access.OIDCAvailable = true
		access.OIDCIssuer = s.oidcIssuer
	}
	rows, err := s.pool.Query(ctx, `SELECT ur.role_id,r.name,r.status,ur.expires_at,ur.granted_by
		FROM governance_user_roles ur JOIN governance_roles r ON r.realm=ur.realm AND r.id=ur.role_id
		WHERE ur.realm=$1 AND ur.user_id=$2 ORDER BY r.name,ur.role_id`, realm, userID)
	if err != nil {
		return access, err
	}
	defer rows.Close()
	for rows.Next() {
		var role UserRole
		if err := rows.Scan(&role.RoleID, &role.Name, &role.Status, &role.ExpiresAt, &role.GrantedBy); err != nil {
			return access, err
		}
		access.Roles = append(access.Roles, role)
	}
	return access, rows.Err()
}

func (s *Store) SetUserCredentials(ctx context.Context, realm, userID, username, password, actor string) error {
	username, hash, err := credentialHash(username, password)
	if err != nil {
		return err
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_users WHERE realm=$1 AND id=$2)`, realm, userID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	var previous string
	err = tx.QueryRow(ctx, `SELECT username FROM governance_auth_credentials WHERE realm=$1 AND user_id=$2`, realm, userID).Scan(&previous)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO governance_auth_credentials (realm,user_id,username,password_hash) VALUES ($1,$2,$3,$4)
		ON CONFLICT (realm,user_id) DO UPDATE SET username=EXCLUDED.username,password_hash=EXCLUDED.password_hash,enabled=true,password_changed_at=now()`, realm, userID, username, hash)
	if isUniqueViolation(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE realm=$1 AND user_id=$2`, realm, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM governance_auth_failures WHERE realm=$1 AND username IN ($2,$3)`, realm, username, previous); err != nil {
		return err
	}
	if err = recordUserAdminEvent(ctx, tx, realm, userID, "credentials_reset", actor, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RevokeRole(ctx context.Context, realm, userID, roleID, actor string) error {
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	before, err := s.activeAdminCount(ctx, tx, realm)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM governance_user_roles WHERE realm=$1 AND user_id=$2 AND role_id=$3`, realm, userID, roleID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err = s.preserveActiveAdmin(ctx, tx, realm, before); err != nil {
		return err
	}
	if err = recordUserAdminEvent(ctx, tx, realm, userID, "role_revoked", actor, map[string]any{"role_id": roleID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
