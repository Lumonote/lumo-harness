// Package oauth manages realm-shared connector grants. PostgreSQL contains
// lifecycle metadata only; access and refresh tokens are stored in Vault KV v2.
package oauth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"

	"github.com/lumo-harness/platform/connector-gateway/internal/credentials"
	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
	"github.com/lumo-harness/platform/connector-gateway/internal/policy"
	"github.com/lumo-harness/platform/connector-gateway/internal/registry"
)

var (
	ErrUnavailable   = errors.New("connector OAuth is not configured")
	ErrConflict      = errors.New("connector OAuth state changed; reload or authorize again")
	ErrAuthorization = errors.New("connector OAuth requires authorization")
	ErrProvider      = errors.New("connector OAuth provider request failed; authorize again")
	opaque           = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	pathPart         = regexp.MustCompile(`^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*$`)
)

const ddl = `
CREATE TABLE IF NOT EXISTS connector_oauth (
 realm TEXT NOT NULL, connector_id TEXT NOT NULL,
 generation BIGINT NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'disconnected', vault_key TEXT NOT NULL DEFAULT '',
 state_hash TEXT NOT NULL DEFAULT '', browser_hash TEXT NOT NULL DEFAULT '',
 session_hash TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL DEFAULT '',
 deadline TIMESTAMPTZ, expires_at TIMESTAMPTZ, refreshable BOOLEAN NOT NULL DEFAULT false,
 error_code TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (realm, connector_id),
 FOREIGN KEY (connector_id, realm) REFERENCES connectors(id, realm)
);
CREATE TABLE IF NOT EXISTS connector_oauth_cleanup (
 vault_key TEXT PRIMARY KEY, not_before TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_oauth_audit (
 id BIGSERIAL PRIMARY KEY, realm TEXT NOT NULL, connector_id TEXT NOT NULL,
 actor_id TEXT NOT NULL, action TEXT NOT NULL, generation BIGINT NOT NULL,
 version INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connector_oauth_audit_lookup ON connector_oauth_audit(realm, connector_id, id DESC);
`

type Options struct {
	Pool                       *pgxpool.Pool
	Vault                      *credentials.VaultStore
	Credentials                credentials.Store
	Policy                     policy.Policy
	Client                     func(bool) *http.Client
	CallbackURL, Mount, Prefix string
	StateKey                   []byte
}

type Manager struct{ options Options }

func New(options Options) (*Manager, error) {
	u, err := url.Parse(options.CallbackURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Path != "/auth/connector-oauth/callback" || u.RawPath != "" {
		return nil, errors.New("connector OAuth callback must be an exact HTTPS /auth/connector-oauth/callback URL")
	}
	if len(options.StateKey) != 32 || !pathPart.MatchString(options.Mount) || !pathPart.MatchString(options.Prefix) || options.Pool == nil || options.Vault == nil || options.Credentials == nil || options.Policy == nil || options.Client == nil {
		return nil, errors.New("connector OAuth requires a 32-byte state key, Vault KV v2 mount/prefix, database, credentials, and egress policy")
	}
	options.StateKey = append([]byte(nil), options.StateKey...)
	return &Manager{options: options}, nil
}

func (m *Manager) Init(ctx context.Context) error {
	_, err := m.options.Pool.Exec(ctx, ddl)
	return err
}

type Status struct {
	Managed     bool       `json:"managed"`
	Available   bool       `json:"available"`
	Enabled     bool       `json:"enabled"`
	State       string     `json:"state"`
	Provider    string     `json:"provider,omitempty"`
	Version     int        `json:"version"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	UpdatedAt   *time.Time `json:"updatedAt,omitempty"`
	Refreshable bool       `json:"refreshable"`
	ErrorCode   string     `json:"errorCode,omitempty"`
	Scopes      []string   `json:"scopes,omitempty"`
	Audit       []Event    `json:"audit,omitempty"`
}

type Event struct {
	Action    string    `json:"action"`
	ActorID   string    `json:"actorId"`
	CreatedAt time.Time `json:"createdAt"`
}

type slot struct {
	Generation                                               int64
	Version                                                  int
	State, Key, StateHash, BrowserHash, SessionHash, ActorID string
	Deadline, ExpiresAt                                      *time.Time
	Refreshable                                              bool
	ErrorCode                                                string
	UpdatedAt                                                time.Time
}

func digest(value string) string { h := sha256.Sum256([]byte(value)); return hex.EncodeToString(h[:]) }

func (m *Manager) verifier(state string) string {
	h := hmac.New(sha256.New, m.options.StateKey)
	_, _ = h.Write([]byte("lumo-connector-oauth-pkce-v1\x00" + state))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

// Lock the authoritative connector before its grant. No registry cache or
// browser-supplied manifest participates in a lifecycle transition.
func (m *Manager) lock(ctx context.Context, realm domain.RealmID, id string) (pgx.Tx, domain.Connector, slot, error) {
	tx, err := m.options.Pool.Begin(ctx)
	if err != nil {
		return nil, domain.Connector{}, slot{}, err
	}
	fail := func(err error) (pgx.Tx, domain.Connector, slot, error) {
		_ = tx.Rollback(ctx)
		return nil, domain.Connector{}, slot{}, err
	}
	var c domain.Connector
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT manifest, version, enabled FROM connectors WHERE realm=$1 AND id=$2 FOR UPDATE`, realm.String(), id).Scan(&raw, &c.Version, &c.Enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return fail(domain.ErrNotFound)
	}
	if err != nil {
		return fail(err)
	}
	version, enabled := c.Version, c.Enabled
	if json.Unmarshal(raw, &c) != nil {
		return fail(ErrUnavailable)
	}
	c.Realm, c.ID, c.Version, c.Enabled = realm, id, version, enabled
	_, err = tx.Exec(ctx, `INSERT INTO connector_oauth(realm,connector_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, realm.String(), id)
	if err != nil {
		return fail(err)
	}
	var s slot
	err = tx.QueryRow(ctx, `SELECT generation,version,state,vault_key,state_hash,browser_hash,session_hash,actor_id,deadline,expires_at,refreshable,error_code,updated_at
 FROM connector_oauth WHERE realm=$1 AND connector_id=$2 FOR UPDATE`, realm.String(), id).Scan(
		&s.Generation, &s.Version, &s.State, &s.Key, &s.StateHash, &s.BrowserHash, &s.SessionHash, &s.ActorID, &s.Deadline, &s.ExpiresAt, &s.Refreshable, &s.ErrorCode, &s.UpdatedAt)
	if err != nil {
		return fail(err)
	}
	return tx, c, s, nil
}

func (m *Manager) usable(c domain.Connector) bool {
	return c.Enabled && c.Auth.OAuth != nil && c.Auth.OAuth.Managed && c.Auth.OAuth.CallbackURL == m.options.CallbackURL && registry.Validate(c) == nil
}

func (m *Manager) Status(ctx context.Context, caller domain.Caller, id string) (Status, error) {
	tx, c, s, err := m.lock(ctx, caller.Realm, id)
	if err != nil {
		return Status{}, err
	}
	defer tx.Rollback(ctx)
	out := Status{Enabled: c.Enabled, State: s.State, Version: c.Version, ExpiresAt: s.ExpiresAt, UpdatedAt: &s.UpdatedAt, Refreshable: s.Refreshable, ErrorCode: s.ErrorCode}
	if o := c.Auth.OAuth; o != nil {
		out.Managed, out.Provider, out.Scopes = o.Managed, o.Provider, o.Scopes
		out.Available = m.usable(c)
	}
	if s.State != "disconnected" && (s.Version != c.Version || !out.Available) {
		out.State, out.ErrorCode, out.Refreshable = "reauthorization_required", "configuration_changed", false
	} else if s.Deadline != nil && !s.Deadline.After(time.Now()) {
		out.State, out.ErrorCode, out.Refreshable = "reauthorization_required", "operation_expired", false
	} else if s.State == "connected" && s.ExpiresAt != nil && !s.ExpiresAt.After(time.Now()) && !s.Refreshable {
		out.State, out.ErrorCode = "reauthorization_required", "token_expired"
	}
	rows, err := tx.Query(ctx, `SELECT action,actor_id,created_at FROM connector_oauth_audit WHERE realm=$1 AND connector_id=$2 ORDER BY id DESC LIMIT 20`, caller.Realm.String(), id)
	if err != nil {
		return Status{}, err
	}
	for rows.Next() {
		var event Event
		if err := rows.Scan(&event.Action, &event.ActorID, &event.CreatedAt); err != nil {
			rows.Close()
			return Status{}, err
		}
		out.Audit = append(out.Audit, event)
	}
	rows.Close()
	if rows.Err() != nil {
		return Status{}, rows.Err()
	}
	return out, tx.Commit(ctx)
}

func audit(ctx context.Context, tx pgx.Tx, c domain.Connector, s slot, actor, action string) error {
	_, err := tx.Exec(ctx, `INSERT INTO connector_oauth_audit(realm,connector_id,actor_id,action,generation,version) VALUES($1,$2,$3,$4,$5,$6)`, c.Realm.String(), c.ID, actor, action, s.Generation, c.Version)
	return err
}

func (m *Manager) policy(ctx context.Context, caller domain.Caller, c domain.Connector, endpoint, action string) error {
	u, err := url.Parse(endpoint)
	if err != nil {
		return domain.ErrForbidden
	}
	decision, err := m.options.Policy.Evaluate(ctx, policy.Request{Caller: caller, Connector: c, Host: u.Host, Operation: domain.Operation{Name: "oauth." + action, Method: "POST", Path: u.Path, Sensitivity: "normal"}})
	if err != nil || !decision.Allow || decision.RequireApproval {
		return domain.ErrForbidden
	}
	return nil
}

func (m *Manager) config(ctx context.Context, c domain.Connector) (*oauth2.Config, context.Context, error) {
	if !m.usable(c) {
		return nil, ctx, ErrUnavailable
	}
	o := c.Auth.OAuth
	id, err := m.options.Credentials.Resolve(ctx, o.ClientIDRef)
	if err != nil || id.Empty() {
		return nil, ctx, ErrUnavailable
	}
	secret, err := m.options.Credentials.Resolve(ctx, o.ClientSecretRef)
	if err != nil || secret.Empty() {
		return nil, ctx, ErrUnavailable
	}
	style := oauth2.AuthStyleInHeader
	if o.ClientAuthMethod == "client_secret_post" {
		style = oauth2.AuthStyleInParams
	}
	cfg := &oauth2.Config{ClientID: id.Reveal(), ClientSecret: secret.Reveal(), RedirectURL: o.CallbackURL, Scopes: o.Scopes,
		Endpoint: oauth2.Endpoint{AuthURL: o.AuthorizationURL, TokenURL: o.TokenURL, AuthStyle: style}}
	return cfg, context.WithValue(ctx, oauth2.HTTPClient, m.options.Client(c.Egress.AllowPrivateNetwork)), nil
}

type Start struct {
	AuthorizationURL string `json:"authorizationUrl"`
	CallbackURL      string `json:"callbackUrl"`
	ExpiresIn        int    `json:"expiresIn"`
}

func (m *Manager) Begin(ctx context.Context, caller domain.Caller, id, browser string) (Start, error) {
	if !opaque.MatchString(browser) || caller.SessionID == "" {
		return Start{}, ErrAuthorization
	}
	tx, c, s, err := m.lock(ctx, caller.Realm, id)
	if err != nil {
		return Start{}, err
	}
	defer tx.Rollback(ctx)
	if !m.usable(c) {
		return Start{}, ErrUnavailable
	}
	for _, endpoint := range []string{c.Auth.OAuth.AuthorizationURL, c.Auth.OAuth.TokenURL} {
		if err = m.policy(ctx, caller, c, endpoint, "authorize"); err != nil {
			return Start{}, err
		}
	}
	cfg, _, err := m.config(ctx, c)
	if err != nil {
		return Start{}, err
	}
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return Start{}, err
	}
	state := base64.RawURLEncoding.EncodeToString(b)
	s.Generation++
	_, err = tx.Exec(ctx, `UPDATE connector_oauth SET generation=$3,version=$4,state='authorizing',vault_key='',state_hash=$5,browser_hash=$6,
 session_hash=$7,actor_id=$8,deadline=now()+interval '5 minutes',expires_at=NULL,refreshable=false,error_code='',updated_at=now()
 WHERE realm=$1 AND connector_id=$2`, c.Realm.String(), c.ID, s.Generation, c.Version, digest(state), digest(browser), digest(caller.SessionID), caller.UserID)
	if err != nil {
		return Start{}, err
	}
	if err = audit(ctx, tx, c, s, caller.UserID, "authorization_started"); err != nil {
		return Start{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Start{}, err
	}
	params := []oauth2.AuthCodeOption{oauth2.S256ChallengeOption(m.verifier(state))}
	for k, v := range c.Auth.OAuth.AuthorizationParams {
		params = append(params, oauth2.SetAuthURLParam(k, v))
	}
	return Start{AuthorizationURL: cfg.AuthCodeURL(state, params...), CallbackURL: c.Auth.OAuth.CallbackURL, ExpiresIn: 300}, nil
}

type Callback struct {
	State   string `json:"state"`
	Browser string `json:"browser"`
	Code    string `json:"code"`
	Error   string `json:"error"`
}

// reserve commits a unique Vault destination before any single-use exchange.
// Cleanup is pre-scheduled, so crashes cannot leave untracked token material.
func (m *Manager) reserve(ctx context.Context, tx pgx.Tx, c domain.Connector, s *slot, actor, phase string) error {
	s.Generation++
	s.Key = m.options.Prefix + "/" + digest(c.Realm.String()+"\x00"+c.ID) + "/" + fmt.Sprint(s.Generation)
	s.State = phase
	_, err := tx.Exec(ctx, `INSERT INTO connector_oauth_cleanup(vault_key,not_before) VALUES($1,now()+interval '10 minutes')`, s.Key)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE connector_oauth SET generation=$3,version=$4,state=$5,vault_key=$6,state_hash='',browser_hash='',session_hash='',
 actor_id=$7,deadline=now()+interval '90 seconds',error_code='',updated_at=now() WHERE realm=$1 AND connector_id=$2`, c.Realm.String(), c.ID, s.Generation, c.Version, phase, s.Key, actor)
	if err != nil {
		return err
	}
	return audit(ctx, tx, c, *s, actor, phase)
}

func (m *Manager) Complete(ctx context.Context, caller domain.Caller, id string, input Callback) error {
	if !opaque.MatchString(input.State) || !opaque.MatchString(input.Browser) || caller.SessionID == "" || len(input.Code) > 8192 || len(input.Error) > 256 {
		return ErrAuthorization
	}
	tx, c, s, err := m.lock(ctx, caller.Realm, id)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if !m.usable(c) || s.Version != c.Version || s.State != "authorizing" || s.Deadline == nil || !s.Deadline.After(time.Now()) || s.StateHash != digest(input.State) || s.BrowserHash != digest(input.Browser) || s.SessionHash != digest(caller.SessionID) || s.ActorID != caller.UserID {
		return ErrAuthorization
	}
	if input.Error != "" || input.Code == "" {
		if err = m.clear(ctx, tx, c, s, caller.UserID, "reauthorization_required", "authorization_denied"); err != nil {
			return err
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		return ErrAuthorization
	}
	if err = m.policy(ctx, caller, c, c.Auth.OAuth.TokenURL, "exchange"); err != nil {
		return err
	}
	if err = m.reserve(ctx, tx, c, &s, caller.UserID, "exchanging"); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cfg, exchangeCtx, err := m.config(ctx, c)
	if err != nil {
		m.fail(c, s, "credentials_unavailable")
		return err
	}
	token, err := cfg.Exchange(exchangeCtx, input.Code, oauth2.VerifierOption(m.verifier(input.State)))
	if err != nil {
		m.fail(c, s, "exchange_failed")
		return ErrProvider
	}
	return m.finish(ctx, c, s, caller.UserID, token)
}

func (m *Manager) clear(ctx context.Context, tx pgx.Tx, c domain.Connector, s slot, actor, state, reason string) error {
	s.Generation++
	_, err := tx.Exec(ctx, `UPDATE connector_oauth SET generation=$3,version=$4,state=$5,vault_key='',state_hash='',browser_hash='',session_hash='',
 deadline=NULL,expires_at=NULL,refreshable=false,error_code=$6,updated_at=now() WHERE realm=$1 AND connector_id=$2`, c.Realm.String(), c.ID, s.Generation, c.Version, state, reason)
	if err != nil {
		return err
	}
	return audit(ctx, tx, c, s, actor, reason)
}

func (m *Manager) Disconnect(ctx context.Context, caller domain.Caller, id string) error {
	tx, c, s, err := m.lock(ctx, caller.Realm, id)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = m.clear(ctx, tx, c, s, caller.UserID, "disconnected", "disconnected"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (m *Manager) readToken(ctx context.Context, key string) (*oauth2.Token, error) {
	raw, err := m.options.Vault.KV2(ctx, http.MethodGet, m.options.Mount, key, nil)
	if err != nil {
		return nil, ErrUnavailable
	}
	var token oauth2.Token
	if json.Unmarshal(raw, &token) != nil || token.AccessToken == "" || !strings.EqualFold(token.TokenType, "Bearer") {
		return nil, ErrAuthorization
	}
	return &token, nil
}

func (m *Manager) AccessToken(ctx context.Context, caller domain.Caller, expected domain.Connector) (credentials.Secret, error) {
	return m.token(ctx, caller, expected.ID, expected.Version, false)
}

func (m *Manager) Refresh(ctx context.Context, caller domain.Caller, id string) error {
	_, err := m.token(ctx, caller, id, 0, true)
	return err
}

func (m *Manager) token(ctx context.Context, caller domain.Caller, id string, expectedVersion int, force bool) (credentials.Secret, error) {
	tx, c, s, err := m.lock(ctx, caller.Realm, id)
	if err != nil {
		return credentials.Secret{}, err
	}
	defer tx.Rollback(ctx)
	if !m.usable(c) || (expectedVersion != 0 && expectedVersion != c.Version) || s.Version != c.Version || s.State != "connected" || s.Key == "" {
		return credentials.Secret{}, ErrAuthorization
	}
	if err = m.policy(ctx, caller, c, c.Auth.OAuth.TokenURL, "refresh"); err != nil {
		return credentials.Secret{}, err
	}
	token, err := m.readToken(ctx, s.Key)
	if err != nil {
		return credentials.Secret{}, err
	}
	if !force && (token.Expiry.IsZero() || token.Expiry.After(time.Now().Add(time.Minute))) {
		if err = tx.Commit(ctx); err != nil {
			return credentials.Secret{}, err
		}
		return credentials.NewSecret(token.AccessToken), nil
	}
	if token.RefreshToken == "" {
		return credentials.Secret{}, ErrAuthorization
	}
	if err = m.reserve(ctx, tx, c, &s, caller.UserID, "refreshing"); err != nil {
		return credentials.Secret{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return credentials.Secret{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cfg, exchangeCtx, err := m.config(ctx, c)
	if err != nil {
		m.fail(c, s, "credentials_unavailable")
		return credentials.Secret{}, err
	}
	// A fresh source executes exactly one refresh. No process-local source can
	// independently retry a rotating refresh token after a crash or timeout.
	refreshed, err := cfg.TokenSource(exchangeCtx, &oauth2.Token{RefreshToken: token.RefreshToken}).Token()
	if err != nil {
		m.fail(c, s, "refresh_failed")
		return credentials.Secret{}, ErrProvider
	}
	if refreshed.RefreshToken == "" {
		refreshed.RefreshToken = token.RefreshToken
	}
	if err = m.finish(ctx, c, s, caller.UserID, refreshed); err != nil {
		return credentials.Secret{}, err
	}
	return credentials.NewSecret(refreshed.AccessToken), nil
}

func (m *Manager) finish(ctx context.Context, c domain.Connector, claimed slot, actor string, token *oauth2.Token) error {
	if token == nil || token.AccessToken == "" || len(token.AccessToken) > 65536 || len(token.RefreshToken) > 65536 || strings.ContainsAny(token.AccessToken, "\r\n") || !strings.EqualFold(token.TokenType, "Bearer") || (!token.Expiry.IsZero() && !token.Expiry.After(time.Now())) {
		m.fail(c, claimed, "invalid_token")
		return ErrProvider
	}
	if _, err := m.options.Vault.KV2(ctx, http.MethodPost, m.options.Mount, claimed.Key, token); err != nil {
		m.fail(c, claimed, "vault_write_failed")
		return ErrUnavailable
	}
	tx, current, s, err := m.lock(ctx, c.Realm, c.ID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if !m.usable(current) || current.Version != c.Version || s.Generation != claimed.Generation || s.State != claimed.State || s.Deadline == nil || !s.Deadline.After(time.Now()) {
		return ErrConflict
	}
	var expiry *time.Time
	if !token.Expiry.IsZero() {
		expiry = &token.Expiry
	}
	_, err = tx.Exec(ctx, `UPDATE connector_oauth SET state='connected',expires_at=$3,refreshable=$4,deadline=NULL,error_code='',updated_at=now()
 WHERE realm=$1 AND connector_id=$2`, c.Realm.String(), c.ID, expiry, token.RefreshToken != "")
	if err != nil {
		return err
	}
	if err = audit(ctx, tx, c, s, actor, "connected"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (m *Manager) fail(c domain.Connector, claimed slot, reason string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, current, s, err := m.lock(ctx, c.Realm, c.ID)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	if s.Generation != claimed.Generation || s.State != claimed.State {
		return
	}
	if m.clear(ctx, tx, current, s, s.ActorID, "reauthorization_required", reason) == nil {
		_ = tx.Commit(ctx)
	}
}

// Maintenance retires interrupted grants and destroys all Vault versions of
// orphaned generations. The delay exceeds every exchange/write deadline.
func (m *Manager) Maintenance(ctx context.Context) error {
	rows, err := m.options.Pool.Query(ctx, `SELECT s.realm,s.connector_id FROM connector_oauth s JOIN connectors c ON c.realm=s.realm AND c.id=s.connector_id
 WHERE s.deadline<now() OR (s.state NOT IN ('disconnected','reauthorization_required') AND s.version<>c.version) LIMIT 100`)
	if err != nil {
		return err
	}
	type identity struct{ realm, id string }
	var expired []identity
	for rows.Next() {
		var item identity
		if err = rows.Scan(&item.realm, &item.id); err != nil {
			break
		}
		expired = append(expired, item)
	}
	rows.Close()
	if err != nil {
		return err
	}
	if rows.Err() != nil {
		return rows.Err()
	}
	for _, item := range expired {
		tx, c, s, err := m.lock(ctx, domain.RealmID(item.realm), item.id)
		if err != nil {
			return err
		}
		if s.Version != c.Version && s.State != "disconnected" && s.State != "reauthorization_required" {
			err = m.clear(ctx, tx, c, s, s.ActorID, "reauthorization_required", "configuration_changed")
		} else if s.Deadline != nil && !s.Deadline.After(time.Now()) {
			err = m.clear(ctx, tx, c, s, s.ActorID, "reauthorization_required", "operation_expired")
		}
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			_ = tx.Rollback(ctx)
		}
		if err != nil {
			return err
		}
	}
	rows, err = m.options.Pool.Query(ctx, `SELECT vault_key FROM connector_oauth_cleanup gc WHERE not_before<now()
 AND NOT EXISTS(SELECT 1 FROM connector_oauth active WHERE active.vault_key=gc.vault_key) ORDER BY not_before LIMIT 100`)
	if err != nil {
		return err
	}
	var keys []string
	for rows.Next() {
		var key string
		if err = rows.Scan(&key); err != nil {
			break
		}
		keys = append(keys, key)
	}
	rows.Close()
	if err != nil {
		return err
	}
	if rows.Err() != nil {
		return rows.Err()
	}
	for _, key := range keys {
		if _, err = m.options.Vault.KV2(ctx, http.MethodDelete, m.options.Mount, key, nil); err != nil {
			return err
		}
		if _, err = m.options.Pool.Exec(ctx, `DELETE FROM connector_oauth_cleanup WHERE vault_key=$1`, key); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) RunMaintenance(ctx context.Context, onError func(error)) {
	timer := time.NewTicker(time.Minute)
	defer timer.Stop()
	for {
		work, cancel := context.WithTimeout(ctx, 40*time.Second)
		err := m.Maintenance(work)
		cancel()
		if err != nil && ctx.Err() == nil {
			onError(err)
		}
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}
