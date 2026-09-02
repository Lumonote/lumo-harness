package store

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	authcrypto "github.com/lumo-harness/platform/governance/internal/auth"
)

const passkeyChallengeTTL = 5 * time.Minute

var (
	ErrPasskeyNotFound = errors.New("passkey not found")
	ErrPasskeyClone    = errors.New("passkey signature counter did not advance")
)

type PasskeyCredential struct {
	ID         string     `json:"id"`
	Label      string     `json:"label,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
}

type PasskeyRegistration struct {
	Challenge string
	Principal AuthPrincipal
}

type PasskeyAssertion struct {
	Challenge     string
	CredentialIDs []string
}

type passkeyChallengeOwner struct {
	Realm  string
	UserID string
}

type PasskeyAssertionCredential struct {
	PublicKeyCOSE []byte
	SignCount     uint32
}

func (s *Store) BeginPasskeyRegistration(ctx context.Context, token string) (PasskeyRegistration, error) {
	principal, err := s.Session(ctx, token)
	if err != nil {
		return PasskeyRegistration{}, err
	}
	challenge, err := s.createPasskeyChallenge(ctx, "register", principal.Realm, principal.UserID)
	if err != nil {
		return PasskeyRegistration{}, err
	}
	return PasskeyRegistration{Challenge: challenge, Principal: principal}, nil
}

// BeginPasskeyAssertion shares the normal password-login rate-limit and
// one-time captcha.  A passkey must not become a username oracle or a bypass
// around the account lockout policy just because it has no password.
func (s *Store) BeginPasskeyAssertion(ctx context.Context, request LoginRequest, policy AuthPolicy) (PasskeyAssertion, error) {
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
	if retry, locked, err := s.loginLock(ctx, realm, username, clientIP); err != nil {
		return PasskeyAssertion{}, err
	} else if locked {
		return PasskeyAssertion{}, fmt.Errorf("%w: retry after %d seconds", ErrLoginLocked, retry)
	}
	captchaOK, err := s.consumeCaptcha(ctx, request.CaptchaID, request.CaptchaCode)
	if err != nil {
		return PasskeyAssertion{}, err
	}
	if !captchaOK {
		_, err := s.rejectLogin(ctx, realm, username, "", clientIP, policy)
		return PasskeyAssertion{}, err
	}
	var userID, status string
	err = s.pool.QueryRow(ctx, `
		SELECT c.user_id,u.status FROM governance_auth_credentials c
		JOIN governance_users u ON u.realm=c.realm AND u.id=c.user_id
		WHERE c.realm=$1 AND c.username=$2 AND c.enabled`, realm, username).Scan(&userID, &status)
	if errors.Is(err, pgx.ErrNoRows) || status != "active" {
		_, rejectErr := s.rejectLogin(ctx, realm, username, userID, clientIP, policy)
		return PasskeyAssertion{}, rejectErr
	}
	if err != nil {
		return PasskeyAssertion{}, err
	}
	rows, err := s.pool.Query(ctx, `SELECT credential_id FROM governance_auth_webauthn_credentials WHERE realm=$1 AND user_id=$2 ORDER BY created_at`, realm, userID)
	if err != nil {
		return PasskeyAssertion{}, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id []byte
		if err := rows.Scan(&id); err != nil {
			return PasskeyAssertion{}, err
		}
		ids = append(ids, base64.RawURLEncoding.EncodeToString(id))
	}
	if err := rows.Err(); err != nil {
		return PasskeyAssertion{}, err
	}
	if len(ids) == 0 {
		_, rejectErr := s.rejectLogin(ctx, realm, username, userID, clientIP, policy)
		return PasskeyAssertion{}, rejectErr
	}
	challenge, err := s.createPasskeyChallenge(ctx, "authenticate", realm, userID)
	if err != nil {
		return PasskeyAssertion{}, err
	}
	return PasskeyAssertion{Challenge: challenge, CredentialIDs: ids}, nil
}

func (s *Store) createPasskeyChallenge(ctx context.Context, purpose, realm, userID string) (string, error) {
	challenge, err := authcrypto.Challenge()
	if err != nil {
		return "", err
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_webauthn_challenges WHERE expires_at <= now()`); err != nil {
		return "", err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO governance_auth_webauthn_challenges (challenge_hash,purpose,realm,user_id,expires_at)
		VALUES ($1,$2,$3,$4,$5)`, authcrypto.TokenHash(challenge), purpose, realm, userID, time.Now().UTC().Add(passkeyChallengeTTL))
	if err != nil {
		return "", fmt.Errorf("create WebAuthn challenge: %w", err)
	}
	return challenge, nil
}

// consumePasskeyChallenge deletes the challenge in the same transaction in
// which it is locked.  Invalid finish responses therefore cannot be retried
// indefinitely, and two concurrent browser tabs cannot both use it.
func (s *Store) consumePasskeyChallenge(ctx context.Context, purpose, challenge string) (passkeyChallengeOwner, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return passkeyChallengeOwner{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var owner passkeyChallengeOwner
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `SELECT realm,user_id,expires_at FROM governance_auth_webauthn_challenges WHERE challenge_hash=$1 AND purpose=$2 FOR UPDATE`, authcrypto.TokenHash(challenge), purpose).Scan(&owner.Realm, &owner.UserID, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return passkeyChallengeOwner{}, ErrPasskeyNotFound
	}
	if err != nil {
		return passkeyChallengeOwner{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM governance_auth_webauthn_challenges WHERE challenge_hash=$1`, authcrypto.TokenHash(challenge)); err != nil {
		return passkeyChallengeOwner{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return passkeyChallengeOwner{}, err
	}
	if !expiresAt.After(time.Now()) {
		return passkeyChallengeOwner{}, ErrPasskeyNotFound
	}
	return owner, nil
}

func (s *Store) CompletePasskeyRegistration(ctx context.Context, token, challenge string, credentialID, publicKeyCOSE []byte, signCount uint32, label string) error {
	principal, err := s.Session(ctx, token)
	if err != nil {
		return err
	}
	owner, err := s.consumePasskeyChallenge(ctx, "register", challenge)
	if err != nil {
		return err
	}
	if owner.Realm != principal.Realm || owner.UserID != principal.UserID {
		return ErrPasskeyNotFound
	}
	if len(credentialID) < 16 || len(credentialID) > 1023 || len(publicKeyCOSE) == 0 || len(publicKeyCOSE) > 8<<10 {
		return fmt.Errorf("%w: invalid credential", ErrBadRequest)
	}
	label = strings.TrimSpace(label)
	if len([]rune(label)) > 80 {
		return fmt.Errorf("%w: passkey label is too long", ErrBadRequest)
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO governance_auth_webauthn_credentials (credential_id,realm,user_id,public_key_cose,sign_count,label)
		VALUES ($1,$2,$3,$4,$5,$6)`, credentialID, owner.Realm, owner.UserID, publicKeyCOSE, int64(signCount), label)
	if err != nil {
		return fmt.Errorf("store passkey: %w", err)
	}
	return s.recordAuthSecurityEvent(ctx, owner.Realm, owner.UserID, "passkey_registered", "", map[string]any{"credential_id": base64.RawURLEncoding.EncodeToString(credentialID), "label": label})
}

func (s *Store) PasskeyForAssertion(ctx context.Context, credentialID []byte) (PasskeyAssertionCredential, error) {
	var value PasskeyAssertionCredential
	var realm, userID string
	var count int64
	err := s.pool.QueryRow(ctx, `SELECT realm,user_id,public_key_cose,sign_count FROM governance_auth_webauthn_credentials WHERE credential_id=$1`, credentialID).Scan(&realm, &userID, &value.PublicKeyCOSE, &count)
	if errors.Is(err, pgx.ErrNoRows) {
		return PasskeyAssertionCredential{}, ErrPasskeyNotFound
	}
	if err != nil {
		return PasskeyAssertionCredential{}, err
	}
	if count < 0 || count > int64(^uint32(0)) {
		return PasskeyAssertionCredential{}, errors.New("invalid stored WebAuthn signature count")
	}
	value.SignCount = uint32(count)
	return value, nil
}

// CompletePasskeyAssertion atomically records the counter only after the
// verifier proved the signature.  Authenticators that intentionally always
// report zero are supported; a positive counter that moves backwards is a
// clone signal and fails the login closed.
func (s *Store) CompletePasskeyAssertion(ctx context.Context, challenge string, credentialID []byte, observedCount uint32, clientIP string, sessionTTL time.Duration) (LoginResult, error) {
	owner, err := s.consumePasskeyChallenge(ctx, "authenticate", challenge)
	if err != nil {
		return LoginResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return LoginResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var current int64
	err = tx.QueryRow(ctx, `SELECT sign_count FROM governance_auth_webauthn_credentials WHERE credential_id=$1 AND realm=$2 AND user_id=$3 FOR UPDATE`, credentialID, owner.Realm, owner.UserID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return LoginResult{}, ErrPasskeyNotFound
	}
	if err != nil {
		return LoginResult{}, err
	}
	if current > 0 && observedCount > 0 && uint64(observedCount) <= uint64(current) {
		if _, err := tx.Exec(ctx, `UPDATE governance_auth_webauthn_credentials SET last_used_at=now() WHERE credential_id=$1`, credentialID); err != nil {
			return LoginResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return LoginResult{}, err
		}
		_ = s.recordAuthSecurityEvent(ctx, owner.Realm, owner.UserID, "passkey_clone_detected", clientIP, map[string]any{"credential_id": base64.RawURLEncoding.EncodeToString(credentialID)})
		return LoginResult{}, ErrPasskeyClone
	}
	if _, err := tx.Exec(ctx, `UPDATE governance_auth_webauthn_credentials SET sign_count=$2,last_used_at=now() WHERE credential_id=$1`, credentialID, int64(observedCount)); err != nil {
		return LoginResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return LoginResult{}, err
	}
	result, err := s.createAuthSession(ctx, owner.Realm, owner.UserID, clientIP, sessionTTL)
	if err != nil {
		return LoginResult{}, err
	}
	if err := s.recordAuthSecurityEvent(ctx, owner.Realm, owner.UserID, "passkey_login", clientIP, map[string]any{"credential_id": base64.RawURLEncoding.EncodeToString(credentialID)}); err != nil {
		return LoginResult{}, err
	}
	return result, nil
}

func (s *Store) ListPasskeys(ctx context.Context, token string) ([]PasskeyCredential, error) {
	principal, err := s.Session(ctx, token)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT credential_id,label,created_at,last_used_at FROM governance_auth_webauthn_credentials WHERE realm=$1 AND user_id=$2 ORDER BY created_at DESC`, principal.Realm, principal.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []PasskeyCredential{}
	for rows.Next() {
		var value PasskeyCredential
		var id []byte
		if err := rows.Scan(&id, &value.Label, &value.CreatedAt, &value.LastUsedAt); err != nil {
			return nil, err
		}
		value.ID = base64.RawURLEncoding.EncodeToString(id)
		values = append(values, value)
	}
	return values, rows.Err()
}

func (s *Store) DeletePasskey(ctx context.Context, token, encodedID string) error {
	principal, err := s.Session(ctx, token)
	if err != nil {
		return err
	}
	id, err := authcrypto.CredentialID(encodedID)
	if err != nil {
		return fmt.Errorf("%w: invalid passkey id", ErrBadRequest)
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM governance_auth_webauthn_credentials WHERE credential_id=$1 AND realm=$2 AND user_id=$3`, id, principal.Realm, principal.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrPasskeyNotFound
	}
	return s.recordAuthSecurityEvent(ctx, principal.Realm, principal.UserID, "passkey_removed", "", map[string]any{"credential_id": encodedID})
}
