package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	authcrypto "github.com/lumo-harness/platform/governance/internal/auth"
)

var (
	ErrInvalidLogin    = errors.New("invalid login")
	ErrLoginLocked     = errors.New("login locked")
	ErrInvalidPassword = errors.New("invalid password")
)

type BootstrapAuthUser struct {
	Realm       string
	UserID      string
	Username    string
	Password    string
	DisplayName string
	Department  string
	Roles       []string
}

type AuthPolicy struct {
	MaxAttempts int
	LockFor     time.Duration
	SessionTTL  time.Duration
	CaptchaTTL  time.Duration
}

type AuthPrincipal struct {
	Realm            string    `json:"realm"`
	UserID           string    `json:"user_id"`
	Username         string    `json:"username"`
	DisplayName      string    `json:"display_name"`
	PrimaryDeptID    string    `json:"primary_dept_id,omitempty"`
	Roles            []string  `json:"roles"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
}

type CaptchaChallenge struct {
	ID        string
	Answer    string
	Tiles     [authcrypto.CaptchaGridSize]int
	Targets   [authcrypto.CaptchaClickCount]int
	ExpiresAt time.Time
}

type LoginRequest struct {
	Realm       string
	Username    string
	Password    string
	CaptchaID   string
	CaptchaCode string
	ClientIP    string
}

type LoginResult struct {
	Token             string
	Principal         AuthPrincipal
	RetryAfterSeconds int
}

func normalizeUsername(value string) string { return strings.ToLower(strings.TrimSpace(value)) }

// EnsureBootstrapAuthUser creates the first local account without resetting
// an existing password on every restart. Subsequent password changes therefore
// survive Compose recreates as long as PostgreSQL does.
func (s *Store) EnsureBootstrapAuthUser(ctx context.Context, input BootstrapAuthUser) error {
	input.Realm = strings.TrimSpace(input.Realm)
	input.UserID = strings.TrimSpace(input.UserID)
	input.Username = normalizeUsername(input.Username)
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.Realm == "" || input.UserID == "" || input.Username == "" || input.DisplayName == "" {
		return fmt.Errorf("%w: bootstrap realm, user id, username, and display name are required", ErrBadRequest)
	}
	hash, err := authcrypto.HashPassword(input.Password)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO governance_users (realm,id,display_name,primary_dept_id,status,source)
		VALUES ($1,$2,$3,$4,'active','local') ON CONFLICT (realm,id) DO NOTHING`,
		input.Realm, input.UserID, input.DisplayName, input.Department); err != nil {
		return fmt.Errorf("bootstrap user: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO governance_auth_credentials (realm,user_id,username,password_hash)
		VALUES ($1,$2,$3,$4) ON CONFLICT (realm,user_id) DO NOTHING`,
		input.Realm, input.UserID, input.Username, hash); err != nil {
		return fmt.Errorf("bootstrap credential: %w", err)
	}
	for _, role := range input.Roles {
		role = strings.TrimSpace(role)
		if role == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO governance_roles (realm,id,name,description,status)
			VALUES ($1,$2,$2,'bootstrap role','active') ON CONFLICT (realm,id) DO NOTHING`, input.Realm, role); err != nil {
			return fmt.Errorf("bootstrap role %s: %w", role, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO governance_user_roles (realm,user_id,role_id,granted_by)
			VALUES ($1,$2,$3,$2) ON CONFLICT (realm,user_id,role_id) DO NOTHING`, input.Realm, input.UserID, role); err != nil {
			return fmt.Errorf("bootstrap role assignment %s: %w", role, err)
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) CreateCaptcha(ctx context.Context, ttl time.Duration) (CaptchaChallenge, error) {
	if ttl <= 0 {
		ttl = 2 * time.Minute
	}
	challenge, err := authcrypto.NewCaptcha()
	if err != nil {
		return CaptchaChallenge{}, err
	}
	expiresAt := time.Now().UTC().Add(ttl)
	if _, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_captchas WHERE expires_at <= now()`); err != nil {
		return CaptchaChallenge{}, err
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO governance_auth_captchas (id,answer_hash,expires_at) VALUES ($1,$2,$3)`,
		challenge.ID, challenge.AnswerHash, expiresAt); err != nil {
		return CaptchaChallenge{}, fmt.Errorf("create captcha: %w", err)
	}
	return CaptchaChallenge{ID: challenge.ID, Answer: challenge.Answer, Tiles: challenge.Tiles, Targets: challenge.Targets, ExpiresAt: expiresAt}, nil
}

// consumeCaptcha deletes the challenge whether the answer is right or wrong:
// one image permits exactly one login attempt and cannot be brute-forced.
func (s *Store) consumeCaptcha(ctx context.Context, id, answer string) (bool, error) {
	if id == "" {
		return false, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var stored string
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `SELECT answer_hash,expires_at FROM governance_auth_captchas WHERE id=$1 FOR UPDATE`, id).Scan(&stored, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM governance_auth_captchas WHERE id=$1`, id); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	valid := expiresAt.After(time.Now()) && authcrypto.EqualCaptchaHash(stored, authcrypto.CaptchaHash(id, answer))
	return valid, nil
}

func (s *Store) Login(ctx context.Context, request LoginRequest, policy AuthPolicy) (LoginResult, error) {
	realm := strings.TrimSpace(request.Realm)
	username := normalizeUsername(request.Username)
	clientIP := strings.TrimSpace(request.ClientIP)
	if clientIP == "" {
		clientIP = "unknown"
	}
	if policy.MaxAttempts < 1 {
		policy.MaxAttempts = 5
	}
	if policy.LockFor <= 0 {
		policy.LockFor = 5 * time.Minute
	}
	if policy.SessionTTL <= 0 {
		policy.SessionTTL = 24 * time.Hour
	}
	if retry, locked, err := s.loginLock(ctx, realm, username, clientIP); err != nil {
		return LoginResult{}, err
	} else if locked {
		return LoginResult{RetryAfterSeconds: retry}, ErrLoginLocked
	}
	captchaOK, err := s.consumeCaptcha(ctx, request.CaptchaID, request.CaptchaCode)
	if err != nil {
		return LoginResult{}, err
	}
	if !captchaOK {
		return s.rejectLogin(ctx, realm, username, clientIP, policy)
	}

	var userID, passwordHash, status string
	err = s.pool.QueryRow(ctx, `
		SELECT c.user_id,c.password_hash,u.status
		FROM governance_auth_credentials c
		JOIN governance_users u ON u.realm=c.realm AND u.id=c.user_id
		WHERE c.realm=$1 AND c.username=$2 AND c.enabled`, realm, username).
		Scan(&userID, &passwordHash, &status)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return LoginResult{}, err
	}
	passwordOK := authcrypto.VerifyPassword(passwordHash, request.Password)
	if errors.Is(err, pgx.ErrNoRows) || status != "active" || !passwordOK {
		return s.rejectLogin(ctx, realm, username, clientIP, policy)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_failures WHERE realm=$1 AND username=$2 AND client_ip=$3`, realm, username, clientIP); err != nil {
		return LoginResult{}, err
	}
	token, err := authcrypto.RandomToken(32)
	if err != nil {
		return LoginResult{}, err
	}
	expiresAt := time.Now().UTC().Add(policy.SessionTTL)
	if _, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE expires_at <= now()`); err != nil {
		return LoginResult{}, err
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO governance_auth_sessions (token_hash,realm,user_id,client_ip,expires_at)
		VALUES ($1,$2,$3,$4,$5)`, authcrypto.TokenHash(token), realm, userID, clientIP, expiresAt); err != nil {
		return LoginResult{}, fmt.Errorf("create session: %w", err)
	}
	principal, err := s.authPrincipal(ctx, realm, userID)
	if err != nil {
		return LoginResult{}, err
	}
	principal.SessionExpiresAt = expiresAt
	return LoginResult{Token: token, Principal: principal}, nil
}

func (s *Store) rejectLogin(ctx context.Context, realm, username, clientIP string, policy AuthPolicy) (LoginResult, error) {
	retry, locked, err := s.recordLoginFailure(ctx, realm, username, clientIP, policy.MaxAttempts, policy.LockFor)
	if err != nil {
		return LoginResult{}, err
	}
	if locked {
		return LoginResult{RetryAfterSeconds: retry}, ErrLoginLocked
	}
	return LoginResult{}, ErrInvalidLogin
}

func (s *Store) loginLock(ctx context.Context, realm, username, clientIP string) (int, bool, error) {
	var until *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT locked_until FROM governance_auth_failures
		WHERE realm=$1 AND username=$2 AND client_ip=$3`, realm, username, clientIP).Scan(&until)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	if until == nil || !until.After(time.Now()) {
		return 0, false, nil
	}
	return max(1, int(time.Until(*until).Seconds()+1)), true, nil
}

func (s *Store) recordLoginFailure(ctx context.Context, realm, username, clientIP string, maxAttempts int, lockFor time.Duration) (int, bool, error) {
	var until *time.Time
	err := s.pool.QueryRow(ctx, `
		INSERT INTO governance_auth_failures (realm,username,client_ip,attempts,locked_until)
		VALUES ($1,$2,$3,1,CASE WHEN $4 <= 1 THEN now()+($5 * interval '1 second') ELSE NULL END)
		ON CONFLICT (realm,username,client_ip) DO UPDATE SET
		  attempts = CASE
		    WHEN governance_auth_failures.locked_until IS NOT NULL AND governance_auth_failures.locked_until <= now() THEN 1
		    ELSE governance_auth_failures.attempts + 1 END,
		  locked_until = CASE
		    WHEN governance_auth_failures.locked_until > now() THEN governance_auth_failures.locked_until
		    WHEN governance_auth_failures.locked_until IS NOT NULL THEN NULL
		    WHEN governance_auth_failures.attempts + 1 >= $4 THEN now()+($5 * interval '1 second')
		    ELSE NULL END,
		  touched_at = now()
		RETURNING locked_until`, realm, username, clientIP, maxAttempts, int(lockFor.Seconds())).Scan(&until)
	if err != nil {
		return 0, false, err
	}
	if until == nil || !until.After(time.Now()) {
		return 0, false, nil
	}
	return max(1, int(time.Until(*until).Seconds()+1)), true, nil
}

func (s *Store) Session(ctx context.Context, token string) (AuthPrincipal, error) {
	if token == "" {
		return AuthPrincipal{}, ErrNotFound
	}
	var realm, userID string
	var expiresAt time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT s.realm,s.user_id,s.expires_at
		FROM governance_auth_sessions s
		JOIN governance_users u ON u.realm=s.realm AND u.id=s.user_id
		WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='active'`, authcrypto.TokenHash(token)).
		Scan(&realm, &userID, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthPrincipal{}, ErrNotFound
	}
	if err != nil {
		return AuthPrincipal{}, err
	}
	principal, err := s.authPrincipal(ctx, realm, userID)
	if err != nil {
		return AuthPrincipal{}, err
	}
	principal.SessionExpiresAt = expiresAt
	_, _ = s.pool.Exec(ctx, `UPDATE governance_auth_sessions SET last_seen_at=now() WHERE token_hash=$1`, authcrypto.TokenHash(token))
	return principal, nil
}

func (s *Store) authPrincipal(ctx context.Context, realm, userID string) (AuthPrincipal, error) {
	var principal AuthPrincipal
	err := s.pool.QueryRow(ctx, `
		SELECT u.realm,u.id,c.username,u.display_name,u.primary_dept_id
		FROM governance_users u
		JOIN governance_auth_credentials c ON c.realm=u.realm AND c.user_id=u.id
		WHERE u.realm=$1 AND u.id=$2`, realm, userID).
		Scan(&principal.Realm, &principal.UserID, &principal.Username, &principal.DisplayName, &principal.PrimaryDeptID)
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthPrincipal{}, ErrNotFound
	}
	if err != nil {
		return AuthPrincipal{}, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.role_id FROM governance_user_roles r
		JOIN governance_roles role ON role.realm=r.realm AND role.id=r.role_id
		WHERE r.realm=$1 AND r.user_id=$2 AND role.status='active'
		  AND (r.expires_at IS NULL OR r.expires_at>now()) ORDER BY r.role_id`, realm, userID)
	if err != nil {
		return AuthPrincipal{}, err
	}
	defer rows.Close()
	principal.Roles = []string{}
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			return AuthPrincipal{}, err
		}
		principal.Roles = append(principal.Roles, role)
	}
	return principal, rows.Err()
}

func (s *Store) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE token_hash=$1`, authcrypto.TokenHash(token))
	return err
}

func (s *Store) ChangePassword(ctx context.Context, token, currentPassword, newPassword string) error {
	principal, err := s.Session(ctx, token)
	if err != nil {
		return err
	}
	var currentHash string
	if err := s.pool.QueryRow(ctx, `SELECT password_hash FROM governance_auth_credentials WHERE realm=$1 AND user_id=$2`, principal.Realm, principal.UserID).Scan(&currentHash); err != nil {
		return err
	}
	if !authcrypto.VerifyPassword(currentHash, currentPassword) {
		return ErrInvalidPassword
	}
	newHash, err := authcrypto.HashPassword(newPassword)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		UPDATE governance_auth_credentials SET password_hash=$3,password_changed_at=now()
		WHERE realm=$1 AND user_id=$2`, principal.Realm, principal.UserID, newHash); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE realm=$1 AND user_id=$2`, principal.Realm, principal.UserID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
