package store

import (
	"context"
	"encoding/json"
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
	ErrMFAUnavailable  = errors.New("MFA encryption key unavailable")
	ErrInvalidMFA      = errors.New("invalid MFA code")
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
	MFAKey      []byte
}

type AuthPrincipal struct {
	Realm            string    `json:"realm"`
	UserID           string    `json:"user_id"`
	Username         string    `json:"username"`
	DisplayName      string    `json:"display_name"`
	PrimaryDeptID    string    `json:"primary_dept_id,omitempty"`
	Roles            []string  `json:"roles"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
	LocalAuthEnabled bool      `json:"local_auth_enabled"`
	AuthMethod       string    `json:"auth_method"`
}

// AuthSession is a safe device/session projection. It never returns the token
// or its hash; session ID is a separately generated revocation handle.
type AuthSession struct {
	ID         string    `json:"id"`
	ClientIP   string    `json:"client_ip"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
	ExpiresAt  time.Time `json:"expires_at"`
	Current    bool      `json:"current"`
}

// AuthSecurityEvent is the safe, user-visible trail of account-security
// actions. It intentionally stores neither token material nor password/MFA
// inputs. Failed attempts for an unknown account retain an empty user ID and
// therefore never become visible through a user's own history endpoint.
type AuthSecurityEvent struct {
	ID        int64          `json:"id"`
	Event     string         `json:"event"`
	ClientIP  string         `json:"client_ip,omitempty"`
	Detail    map[string]any `json:"detail"`
	CreatedAt time.Time      `json:"created_at"`
}

type AuthMFAStatus struct {
	Configured       bool       `json:"configured"`
	Enabled          bool       `json:"enabled"`
	PendingExpiresAt *time.Time `json:"pending_expires_at,omitempty"`
	EnrolledAt       *time.Time `json:"enrolled_at,omitempty"`
}

type TOTPEnrollment struct {
	Secret    string    `json:"secret"`
	ExpiresAt time.Time `json:"expires_at"`
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
	MFACode     string
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
	credential, err := tx.Exec(ctx, `
		INSERT INTO governance_auth_credentials (realm,user_id,username,password_hash)
		VALUES ($1,$2,$3,$4) ON CONFLICT (realm,user_id) DO NOTHING`,
		input.Realm, input.UserID, input.Username, hash)
	if err != nil {
		return fmt.Errorf("bootstrap credential: %w", err)
	}
	if credential.RowsAffected() == 0 {
		return tx.Commit(ctx)
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
		if err := s.recordAuthSecurityEvent(ctx, realm, "", "login_locked", clientIP, map[string]any{"username": username, "retry_after_seconds": retry}); err != nil {
			return LoginResult{}, err
		}
		return LoginResult{RetryAfterSeconds: retry}, ErrLoginLocked
	}
	captchaOK, err := s.consumeCaptcha(ctx, request.CaptchaID, request.CaptchaCode)
	if err != nil {
		return LoginResult{}, err
	}
	if !captchaOK {
		return s.rejectLogin(ctx, realm, username, "", clientIP, policy)
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
		return s.rejectLogin(ctx, realm, username, userID, clientIP, policy)
	}
	mfaRequired, mfaOK, err := s.verifyLoginMFA(ctx, realm, userID, request.MFACode, policy.MFAKey)
	if err != nil {
		return LoginResult{}, err
	}
	if mfaRequired && !mfaOK {
		return s.rejectLogin(ctx, realm, username, userID, clientIP, policy)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_failures WHERE realm=$1 AND username=$2 AND client_ip=$3`, realm, username, clientIP); err != nil {
		return LoginResult{}, err
	}
	result, err := s.createAuthSession(ctx, realm, userID, clientIP, policy.SessionTTL, passwordHash)
	if err != nil {
		return LoginResult{}, err
	}
	if err := s.recordAuthSecurityEvent(ctx, realm, userID, "login_succeeded", clientIP, map[string]any{"session_expires_at": result.Principal.SessionExpiresAt.Format(time.RFC3339)}); err != nil {
		return LoginResult{}, err
	}
	return result, nil
}

func (s *Store) createAuthSession(ctx context.Context, realm, userID, clientIP string, ttl time.Duration, expectedPasswordHash string) (LoginResult, error) {
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	token, err := authcrypto.RandomToken(32)
	if err != nil {
		return LoginResult{}, err
	}
	expiresAt := time.Now().UTC().Add(ttl)
	if _, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE expires_at <= now()`); err != nil {
		return LoginResult{}, err
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return LoginResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Recheck the credential under a lock so a concurrent reset or suspension
	// cannot leave a newly issued session authenticated by an obsolete password.
	var currentHash string
	err = tx.QueryRow(ctx, `SELECT c.password_hash FROM governance_auth_credentials c
		JOIN governance_users u ON u.realm=c.realm AND u.id=c.user_id
		WHERE c.realm=$1 AND c.user_id=$2 AND c.enabled AND u.status='active' FOR SHARE OF c,u`, realm, userID).Scan(&currentHash)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && expectedPasswordHash != "" && currentHash != expectedPasswordHash) {
		return LoginResult{}, ErrInvalidLogin
	}
	if err != nil {
		return LoginResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO governance_auth_sessions (token_hash,realm,user_id,client_ip,expires_at)
		VALUES ($1,$2,$3,$4,$5)`, authcrypto.TokenHash(token), realm, userID, strings.TrimSpace(clientIP), expiresAt); err != nil {
		return LoginResult{}, fmt.Errorf("create session: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return LoginResult{}, err
	}
	principal, err := s.authPrincipal(ctx, realm, userID)
	if err != nil {
		return LoginResult{}, err
	}
	principal.SessionExpiresAt = expiresAt
	return LoginResult{Token: token, Principal: principal}, nil
}

func (s *Store) rejectLogin(ctx context.Context, realm, username, userID, clientIP string, policy AuthPolicy) (LoginResult, error) {
	if err := s.recordAuthSecurityEvent(ctx, realm, userID, "login_failed", clientIP, map[string]any{"username": username}); err != nil {
		return LoginResult{}, err
	}
	retry, locked, err := s.recordLoginFailure(ctx, realm, username, clientIP, policy.MaxAttempts, policy.LockFor)
	if err != nil {
		return LoginResult{}, err
	}
	if locked {
		if err := s.recordAuthSecurityEvent(ctx, realm, userID, "login_locked", clientIP, map[string]any{"username": username, "retry_after_seconds": retry}); err != nil {
			return LoginResult{}, err
		}
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
	var realm, userID, issuer string
	var expiresAt time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT s.realm,s.user_id,s.expires_at,s.oidc_issuer
		FROM governance_auth_sessions s
		JOIN governance_users u ON u.realm=s.realm AND u.id=s.user_id
		WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='active' AND (
		  (s.oidc_issuer='' AND EXISTS(SELECT 1 FROM governance_auth_credentials c WHERE c.realm=u.realm AND c.user_id=u.id AND c.enabled))
		  OR (s.oidc_issuer<>'' AND s.oidc_issuer=$2 AND s.realm=$3 AND EXISTS(
		    SELECT 1 FROM governance_auth_oidc_identities i WHERE i.realm=u.realm AND i.user_id=u.id AND i.issuer=s.oidc_issuer AND i.enabled))
		)`, authcrypto.TokenHash(token), s.oidcIssuer, s.oidcRealm).
		Scan(&realm, &userID, &expiresAt, &issuer)
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
	if issuer != "" {
		principal.AuthMethod = "oidc"
	}
	_, _ = s.pool.Exec(ctx, `UPDATE governance_auth_sessions SET last_seen_at=now() WHERE token_hash=$1`, authcrypto.TokenHash(token))
	return principal, nil
}

func (s *Store) authPrincipal(ctx context.Context, realm, userID string) (AuthPrincipal, error) {
	var principal AuthPrincipal
	err := s.pool.QueryRow(ctx, `
		SELECT u.realm,u.id,COALESCE(c.username,i.username,u.id),u.display_name,u.primary_dept_id,COALESCE(c.enabled,false)
		FROM governance_users u
		LEFT JOIN governance_auth_credentials c ON c.realm=u.realm AND c.user_id=u.id
		LEFT JOIN governance_auth_oidc_identities i ON i.realm=u.realm AND i.user_id=u.id
		WHERE u.realm=$1 AND u.id=$2`, realm, userID).
		Scan(&principal.Realm, &principal.UserID, &principal.Username, &principal.DisplayName, &principal.PrimaryDeptID, &principal.LocalAuthEnabled)
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
	principal.AuthMethod = "local"
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

func (s *Store) verifyLoginMFA(ctx context.Context, realm, userID, code string, key []byte) (required, valid bool, err error) {
	var nonce, ciphertext []byte
	err = s.pool.QueryRow(ctx, `SELECT secret_nonce,secret_ciphertext FROM governance_auth_totp WHERE realm=$1 AND user_id=$2 AND enabled`, realm, userID).Scan(&nonce, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, true, nil
	}
	if err != nil {
		return false, false, err
	}
	if len(key) != 32 {
		return true, false, ErrMFAUnavailable
	}
	secret, err := authcrypto.OpenTOTPSecret(key, nonce, ciphertext)
	if err != nil {
		return true, false, err
	}
	return true, authcrypto.VerifyTOTP(secret, code, time.Now()), nil
}

func (s *Store) MFAStatus(ctx context.Context, token string, configured bool) (AuthMFAStatus, error) {
	principal, err := s.Session(ctx, token)
	if err != nil {
		return AuthMFAStatus{}, err
	}
	status := AuthMFAStatus{Configured: configured}
	err = s.pool.QueryRow(ctx, `SELECT enabled,pending_expires_at,enrolled_at FROM governance_auth_totp WHERE realm=$1 AND user_id=$2`, principal.Realm, principal.UserID).Scan(&status.Enabled, &status.PendingExpiresAt, &status.EnrolledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return status, nil
	}
	return status, err
}

func (s *Store) BeginTOTPEnrollment(ctx context.Context, token string, key []byte) (TOTPEnrollment, error) {
	if len(key) != 32 {
		return TOTPEnrollment{}, ErrMFAUnavailable
	}
	principal, err := s.Session(ctx, token)
	if err != nil {
		return TOTPEnrollment{}, err
	}
	var enabled bool
	err = s.pool.QueryRow(ctx, `SELECT enabled FROM governance_auth_totp WHERE realm=$1 AND user_id=$2`, principal.Realm, principal.UserID).Scan(&enabled)
	if err == nil && enabled {
		return TOTPEnrollment{}, ErrConflict
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return TOTPEnrollment{}, err
	}
	secret, err := authcrypto.NewTOTPSecret()
	if err != nil {
		return TOTPEnrollment{}, err
	}
	nonce, ciphertext, err := authcrypto.SealTOTPSecret(key, secret)
	if err != nil {
		return TOTPEnrollment{}, err
	}
	expiresAt := time.Now().UTC().Add(10 * time.Minute)
	_, err = s.pool.Exec(ctx, `
		INSERT INTO governance_auth_totp (realm,user_id,secret_nonce,secret_ciphertext,enabled,pending_expires_at,enrolled_at)
		VALUES ($1,$2,$3,$4,false,$5,NULL)
		ON CONFLICT (realm,user_id) DO UPDATE SET secret_nonce=EXCLUDED.secret_nonce,secret_ciphertext=EXCLUDED.secret_ciphertext,
			enabled=false,pending_expires_at=EXCLUDED.pending_expires_at,enrolled_at=NULL,updated_at=now()`,
		principal.Realm, principal.UserID, nonce, ciphertext, expiresAt)
	if err != nil {
		return TOTPEnrollment{}, err
	}
	return TOTPEnrollment{Secret: secret, ExpiresAt: expiresAt}, nil
}

func (s *Store) ConfirmTOTPEnrollment(ctx context.Context, token, code string, key []byte) (AuthMFAStatus, error) {
	if len(key) != 32 {
		return AuthMFAStatus{}, ErrMFAUnavailable
	}
	principal, err := s.Session(ctx, token)
	if err != nil {
		return AuthMFAStatus{}, err
	}
	var nonce, ciphertext []byte
	var expiresAt *time.Time
	err = s.pool.QueryRow(ctx, `SELECT secret_nonce,secret_ciphertext,pending_expires_at FROM governance_auth_totp WHERE realm=$1 AND user_id=$2 AND NOT enabled`, principal.Realm, principal.UserID).Scan(&nonce, &ciphertext, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthMFAStatus{}, ErrNotFound
	}
	if err != nil {
		return AuthMFAStatus{}, err
	}
	if expiresAt == nil || !expiresAt.After(time.Now()) {
		return AuthMFAStatus{}, fmt.Errorf("%w: enrollment expired", ErrBadRequest)
	}
	secret, err := authcrypto.OpenTOTPSecret(key, nonce, ciphertext)
	if err != nil {
		return AuthMFAStatus{}, err
	}
	if !authcrypto.VerifyTOTP(secret, code, time.Now()) {
		return AuthMFAStatus{}, ErrInvalidMFA
	}
	now := time.Now().UTC()
	if _, err := s.pool.Exec(ctx, `UPDATE governance_auth_totp SET enabled=true,pending_expires_at=NULL,enrolled_at=$3,updated_at=$3 WHERE realm=$1 AND user_id=$2`, principal.Realm, principal.UserID, now); err != nil {
		return AuthMFAStatus{}, err
	}
	if err := s.recordAuthSecurityEvent(ctx, principal.Realm, principal.UserID, "mfa_enabled", "", map[string]any{"method": "totp"}); err != nil {
		return AuthMFAStatus{}, err
	}
	return AuthMFAStatus{Configured: true, Enabled: true, EnrolledAt: &now}, nil
}

func (s *Store) DisableTOTP(ctx context.Context, token, code string, key []byte) error {
	principal, err := s.Session(ctx, token)
	if err != nil {
		return err
	}
	required, valid, err := s.verifyLoginMFA(ctx, principal.Realm, principal.UserID, code, key)
	if err != nil {
		return err
	}
	if !required || !valid {
		return ErrInvalidMFA
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_totp WHERE realm=$1 AND user_id=$2`, principal.Realm, principal.UserID); err != nil {
		return err
	}
	return s.recordAuthSecurityEvent(ctx, principal.Realm, principal.UserID, "mfa_disabled", "", map[string]any{"method": "totp"})
}

func (s *Store) recordAuthSecurityEvent(ctx context.Context, realm, userID, event, clientIP string, detail map[string]any) error {
	encoded, err := json.Marshal(detail)
	if err != nil {
		return fmt.Errorf("encode auth security event: %w", err)
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO governance_auth_security_events (realm,user_id,event,client_ip,detail)
		VALUES ($1,$2,$3,$4,$5)`, realm, userID, event, strings.TrimSpace(clientIP), encoded)
	return err
}

func (s *Store) ListAuthSecurityEvents(ctx context.Context, token string) ([]AuthSecurityEvent, error) {
	principal, err := s.Session(ctx, token)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id,event,client_ip,detail,created_at
		FROM governance_auth_security_events
		WHERE realm=$1 AND user_id=$2
		ORDER BY created_at DESC, id DESC LIMIT 100`, principal.Realm, principal.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []AuthSecurityEvent{}
	for rows.Next() {
		var event AuthSecurityEvent
		var detail []byte
		if err := rows.Scan(&event.ID, &event.Event, &event.ClientIP, &detail, &event.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(detail, &event.Detail); err != nil {
			return nil, fmt.Errorf("decode auth security event: %w", err)
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	principal, err := s.Session(ctx, token)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE token_hash=$1`, authcrypto.TokenHash(token)); err != nil {
		return err
	}
	return s.recordAuthSecurityEvent(ctx, principal.Realm, principal.UserID, "logout", "", map[string]any{})
}

func (s *Store) ListAuthSessions(ctx context.Context, token string) ([]AuthSession, error) {
	principal, err := s.Session(ctx, token)
	if err != nil {
		return nil, err
	}
	currentHash := authcrypto.TokenHash(token)
	rows, err := s.pool.Query(ctx, `
		SELECT session_id,client_ip,created_at,last_seen_at,expires_at,token_hash=$3
		FROM governance_auth_sessions
		WHERE realm=$1 AND user_id=$2 AND expires_at>now()
		ORDER BY last_seen_at DESC, created_at DESC`, principal.Realm, principal.UserID, currentHash)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sessions := []AuthSession{}
	for rows.Next() {
		var session AuthSession
		if err := rows.Scan(&session.ID, &session.ClientIP, &session.CreatedAt, &session.LastSeenAt, &session.ExpiresAt, &session.Current); err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

func (s *Store) RevokeAuthSession(ctx context.Context, token, sessionID string) error {
	principal, err := s.Session(ctx, token)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE session_id=$1 AND realm=$2 AND user_id=$3`, strings.TrimSpace(sessionID), principal.Realm, principal.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return s.recordAuthSecurityEvent(ctx, principal.Realm, principal.UserID, "session_revoked", "", map[string]any{"session_id": strings.TrimSpace(sessionID)})
}

func (s *Store) RevokeOtherAuthSessions(ctx context.Context, token string) (int64, error) {
	principal, err := s.Session(ctx, token)
	if err != nil {
		return 0, err
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE realm=$1 AND user_id=$2 AND token_hash<>$3`, principal.Realm, principal.UserID, authcrypto.TokenHash(token))
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, nil
	}
	if err := s.recordAuthSecurityEvent(ctx, principal.Realm, principal.UserID, "sessions_revoked", "", map[string]any{"count": tag.RowsAffected()}); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
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
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return s.recordAuthSecurityEvent(ctx, principal.Realm, principal.UserID, "password_changed", "", map[string]any{"sessions_revoked": true})
}
