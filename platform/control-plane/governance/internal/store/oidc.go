package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	authcrypto "github.com/lumo-harness/platform/governance/internal/auth"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

const OIDCFlowTTL = 5 * time.Minute

type OIDCFlow struct {
	State    string
	Nonce    string
	Verifier string
}

type OIDCLink struct {
	Issuer  string `json:"issuer"`
	Subject string `json:"subject"`
	Enabled bool   `json:"enabled"`
}

// SetOIDCProvider is called once during server construction, before serving requests.
func (s *Store) SetOIDCProvider(issuer, realm string) {
	s.oidcIssuer, s.oidcRealm = issuer, realm
}

func (s *Store) BeginOIDCLogin(ctx context.Context, browser, configHash string) (OIDCFlow, error) {
	var flow OIDCFlow
	var err error
	if len(browser) != 43 {
		return flow, ErrInvalidLogin
	}
	for _, value := range []*string{&flow.State, &flow.Nonce, &flow.Verifier} {
		*value, err = authcrypto.RandomToken(32)
		if err != nil {
			return OIDCFlow{}, err
		}
	}
	if _, err = s.pool.Exec(ctx, `DELETE FROM governance_auth_oidc_flows WHERE expires_at<=now()`); err != nil {
		return OIDCFlow{}, err
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO governance_auth_oidc_flows (state_hash,browser_hash,config_hash,nonce,verifier,expires_at)
		VALUES ($1,$2,$3,$4,$5,$6)`, authcrypto.TokenHash(flow.State), authcrypto.TokenHash(browser), configHash, flow.Nonce, flow.Verifier, time.Now().UTC().Add(OIDCFlowTTL))
	return flow, err
}

func (s *Store) ConsumeOIDCLogin(ctx context.Context, state, browser, configHash string) (OIDCFlow, error) {
	var flow OIDCFlow
	if len(state) != 43 || len(browser) != 43 {
		return flow, ErrInvalidLogin
	}
	var expires time.Time
	err := s.pool.QueryRow(ctx, `DELETE FROM governance_auth_oidc_flows
		WHERE state_hash=$1 AND browser_hash=$2 AND config_hash=$3 RETURNING nonce,verifier,expires_at`,
		authcrypto.TokenHash(state), authcrypto.TokenHash(browser), configHash).Scan(&flow.Nonce, &flow.Verifier, &expires)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !expires.After(time.Now())) {
		return OIDCFlow{}, ErrInvalidLogin
	}
	return flow, err
}

func (s *Store) CompleteOIDCLogin(ctx context.Context, cfg authcrypto.OIDCConfig, identity authcrypto.OIDCIdentity, clientIP string, ttl time.Duration) (LoginResult, error) {
	if cfg.Issuer == "" || cfg.Issuer != s.oidcIssuer || cfg.Realm != s.oidcRealm || identity.Subject == "" || len(identity.Subject) > 255 || strings.ContainsRune(identity.Subject, '\x00') {
		return LoginResult{}, ErrInvalidLogin
	}
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	expires := time.Now().UTC().Add(ttl)
	if identity.ExpiresAt.Before(expires) {
		expires = identity.ExpiresAt
	}
	if !expires.After(time.Now()) {
		return LoginResult{}, ErrInvalidLogin
	}
	token, err := authcrypto.RandomToken(32)
	if err != nil {
		return LoginResult{}, err
	}
	tx, err := s.beginOrganizationChange(ctx, cfg.Realm)
	if err != nil {
		return LoginResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var userID, status string
	var enabled bool
	err = tx.QueryRow(ctx, `SELECT i.user_id,u.status,i.enabled FROM governance_auth_oidc_identities i
		JOIN governance_users u ON u.realm=i.realm AND u.id=i.user_id
		WHERE i.realm=$1 AND i.issuer=$2 AND i.subject=$3 FOR UPDATE OF i,u`, cfg.Realm, cfg.Issuer, identity.Subject).Scan(&userID, &status, &enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		if !cfg.AllowSignup {
			return LoginResult{}, ErrInvalidLogin
		}
		id, err := authcrypto.RandomToken(24)
		if err != nil {
			return LoginResult{}, err
		}
		user := domain.User{ID: "oidc_" + id, Realm: cfg.Realm, DisplayName: identity.DisplayName, PrimaryDeptID: identity.Department, Status: "active", Source: "oidc"}
		if err = validateManagedUser(&user); err != nil {
			return LoginResult{}, ErrInvalidLogin
		}
		if err = checkUserDepartment(ctx, tx, user); err != nil {
			return LoginResult{}, err
		}
		userID = user.ID
		if _, err = tx.Exec(ctx, `INSERT INTO governance_users (realm,id,display_name,primary_dept_id,status,source) VALUES ($1,$2,$3,$4,'active','oidc')`, cfg.Realm, userID, user.DisplayName, user.PrimaryDeptID); err != nil {
			return LoginResult{}, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO governance_auth_oidc_identities (realm,issuer,subject,user_id,username) VALUES ($1,$2,$3,$4,$5)`, cfg.Realm, cfg.Issuer, identity.Subject, userID, identity.Username); err != nil {
			return LoginResult{}, err
		}
		if err = recordUserAdminEvent(ctx, tx, cfg.Realm, userID, "user_created", userID, map[string]any{"source": "oidc"}); err != nil {
			return LoginResult{}, err
		}
	} else if err != nil {
		return LoginResult{}, err
	} else if status != "active" || !enabled {
		return LoginResult{}, ErrInvalidLogin
	}
	// Existing profile, department, status and roles remain under governance control.
	if len(identity.Username) > 255 || strings.ContainsRune(identity.Username, '\x00') {
		return LoginResult{}, ErrInvalidLogin
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_auth_oidc_identities SET username=$4,last_login_at=now() WHERE realm=$1 AND issuer=$2 AND subject=$3`, cfg.Realm, cfg.Issuer, identity.Subject, identity.Username); err != nil {
		return LoginResult{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE expires_at<=now()`); err != nil {
		return LoginResult{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO governance_auth_sessions (token_hash,realm,user_id,client_ip,expires_at,oidc_issuer) VALUES ($1,$2,$3,$4,$5,$6)`, authcrypto.TokenHash(token), cfg.Realm, userID, strings.TrimSpace(clientIP), expires, cfg.Issuer); err != nil {
		return LoginResult{}, err
	}
	detail, _ := json.Marshal(map[string]any{"issuer": cfg.Issuer, "session_expires_at": expires})
	if _, err = tx.Exec(ctx, `INSERT INTO governance_auth_security_events (realm,user_id,event,client_ip,detail) VALUES ($1,$2,'oidc_login',$3,$4)`, cfg.Realm, userID, strings.TrimSpace(clientIP), detail); err != nil {
		return LoginResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return LoginResult{}, err
	}
	principal, err := s.Session(ctx, token)
	if err != nil {
		return LoginResult{}, err
	}
	return LoginResult{Token: token, Principal: principal}, nil
}

func (s *Store) LinkOIDCUser(ctx context.Context, realm, userID, issuer, subject, actor string) error {
	if issuer == "" || realm != s.oidcRealm || issuer != s.oidcIssuer || subject == "" || len(subject) > 255 || strings.ContainsRune(subject, '\x00') {
		return ErrBadRequest
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var username string
	err = tx.QueryRow(ctx, `SELECT COALESCE(c.username,u.id) FROM governance_users u
		LEFT JOIN governance_auth_credentials c ON c.realm=u.realm AND c.user_id=u.id
		WHERE u.realm=$1 AND u.id=$2 AND u.status='active'`, realm, userID).Scan(&username)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	// Keep revoked subjects reserved so JIT cannot recreate an unlinked identity.
	tag, err := tx.Exec(ctx, `INSERT INTO governance_auth_oidc_identities (realm,issuer,subject,user_id,username) VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (realm,issuer,subject) DO UPDATE SET enabled=true
		WHERE governance_auth_oidc_identities.user_id=EXCLUDED.user_id AND NOT governance_auth_oidc_identities.enabled`, realm, issuer, subject, userID, username)
	if isUniqueViolation(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	if err = recordUserAdminEvent(ctx, tx, realm, userID, "oidc_linked", actor, map[string]any{"issuer": issuer}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) UnlinkOIDCUser(ctx context.Context, realm, userID, actor string) error {
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	before, err := s.activeAdminCount(ctx, tx, realm)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE governance_auth_oidc_identities SET enabled=false WHERE realm=$1 AND user_id=$2 AND enabled`, realm, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err = s.preserveActiveAdmin(ctx, tx, realm, before); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM governance_auth_sessions WHERE realm=$1 AND user_id=$2 AND oidc_issuer<>''`, realm, userID); err != nil {
		return err
	}
	if err = recordUserAdminEvent(ctx, tx, realm, userID, "oidc_unlinked", actor, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
