package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// OIDCConfig is operator-owned. No endpoint or redirect URL comes from a login request.
type OIDCConfig struct {
	Issuer            string
	ClientID          string
	ClientSecret      string
	RedirectURL       string
	Realm             string
	DepartmentClaim   string
	DefaultDepartment string
	AllowSignup       bool
	AllowLoopbackHTTP bool
}

func (c OIDCConfig) Enabled() bool { return c.Issuer != "" }

func (c OIDCConfig) Validate() error {
	if !c.Enabled() {
		if c.ClientID != "" || c.ClientSecret != "" || c.RedirectURL != "" || c.Realm != "" || c.DepartmentClaim != "" || c.DefaultDepartment != "" || c.AllowSignup || c.AllowLoopbackHTTP {
			return errors.New("OIDC issuer, client ID, secret, redirect URL and realm must be configured together")
		}
		return nil
	}
	if strings.TrimSpace(c.ClientID) == "" || c.ClientSecret == "" || strings.TrimSpace(c.Realm) == "" {
		return errors.New("OIDC client ID, secret and realm are required")
	}
	for _, raw := range []string{c.Issuer, c.RedirectURL} {
		if err := c.validateURL(raw); err != nil {
			return err
		}
		u, _ := url.Parse(raw)
		if u.RawQuery != "" || u.ForceQuery {
			return errors.New("OIDC issuer and redirect URL must not contain a query")
		}
	}
	u, _ := url.Parse(c.RedirectURL)
	if u.Path != "/auth/oidc/callback" || u.RawPath != "" {
		return errors.New("OIDC redirect URL must use /auth/oidc/callback")
	}
	return nil
}

// Bind pending logins to the complete operator configuration across replicas.
func (c OIDCConfig) Fingerprint() string {
	raw, _ := json.Marshal(c)
	return TokenHash(string(raw))
}

func (c OIDCConfig) validateURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" || len(raw) > 2048 {
		return errors.New("invalid OIDC URL")
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(c.AllowLoopbackHTTP && loopback && u.Scheme == "http") {
		return errors.New("OIDC endpoints require HTTPS")
	}
	return nil
}

type OIDCMetadata struct {
	Issuer                string   `json:"issuer"`
	AuthorizationEndpoint string   `json:"authorization_endpoint"`
	TokenEndpoint         string   `json:"token_endpoint"`
	JWKSURI               string   `json:"jwks_uri"`
	TokenAuthMethods      []string `json:"token_endpoint_auth_methods_supported"`
	PKCEMethods           []string `json:"code_challenge_methods_supported"`
}

func oidcHTTPClient() *http.Client {
	return &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func oidcJSON(ctx context.Context, method, endpoint string, body io.Reader, headers http.Header, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	req.Header = headers
	resp, err := oidcHTTPClient().Do(req)
	if err != nil {
		return errors.New("identity provider unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("identity provider returned HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return errors.New("identity provider response too large")
	}
	return json.Unmarshal(raw, out)
}

func (c OIDCConfig) Discover(ctx context.Context) (OIDCMetadata, error) {
	var m OIDCMetadata
	if !c.Enabled() {
		return m, errors.New("OIDC is not configured")
	}
	if err := c.Validate(); err != nil {
		return m, err
	}
	if err := oidcJSON(ctx, "GET", strings.TrimSuffix(c.Issuer, "/")+"/.well-known/openid-configuration", nil, nil, &m); err != nil {
		return m, err
	}
	if m.Issuer != c.Issuer {
		return m, errors.New("OIDC discovery issuer mismatch")
	}
	for _, endpoint := range []string{m.AuthorizationEndpoint, m.TokenEndpoint, m.JWKSURI} {
		if err := c.validateURL(endpoint); err != nil {
			return m, err
		}
	}
	if len(m.PKCEMethods) > 0 && !slices.Contains(m.PKCEMethods, "S256") {
		return m, errors.New("identity provider does not support S256 PKCE")
	}
	if len(m.TokenAuthMethods) > 0 && !slices.Contains(m.TokenAuthMethods, "client_secret_basic") && !slices.Contains(m.TokenAuthMethods, "client_secret_post") {
		return m, errors.New("unsupported OIDC token authentication method")
	}
	return m, nil
}

func (c OIDCConfig) AuthorizationURL(m OIDCMetadata, state, nonce, verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	u, _ := url.Parse(m.AuthorizationEndpoint)
	q := u.Query()
	for key, value := range map[string]string{
		"client_id": c.ClientID, "redirect_uri": c.RedirectURL,
		"response_type": "code", "response_mode": "query", "scope": "openid profile email",
		"state": state, "nonce": nonce, "code_challenge_method": "S256",
		"code_challenge": base64.RawURLEncoding.EncodeToString(digest[:]),
	} {
		q.Set(key, value)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

type OIDCIdentity struct {
	Subject     string
	Username    string
	DisplayName string
	Department  string
	ExpiresAt   time.Time
}

type oidcClaims struct {
	jwt.RegisteredClaims
	Nonce           string `json:"nonce"`
	AuthorizedParty string `json:"azp"`
}

func (c OIDCConfig) Exchange(ctx context.Context, code, verifier, nonce string) (OIDCIdentity, error) {
	var identity OIDCIdentity
	if code == "" || len(code) > 8192 || verifier == "" || nonce == "" {
		return identity, errors.New("invalid OIDC exchange")
	}
	m, err := c.Discover(ctx)
	if err != nil {
		return identity, err
	}
	q := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {c.RedirectURL}, "client_id": {c.ClientID}, "code_verifier": {verifier}}
	headers := http.Header{"Content-Type": {"application/x-www-form-urlencoded"}}
	if len(m.TokenAuthMethods) == 0 || slices.Contains(m.TokenAuthMethods, "client_secret_basic") {
		headers.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(url.QueryEscape(c.ClientID)+":"+url.QueryEscape(c.ClientSecret))))
	} else {
		q.Set("client_secret", c.ClientSecret)
	}
	var response struct {
		IDToken string `json:"id_token"`
	}
	if err := oidcJSON(ctx, "POST", m.TokenEndpoint, strings.NewReader(q.Encode()), headers, &response); err != nil {
		return identity, err
	}
	var keys struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			Alg string `json:"alg"`
			Use string `json:"use"`
			N   string `json:"n"`
			E   string `json:"e"`
			Crv string `json:"crv"`
			X   string `json:"x"`
			Y   string `json:"y"`
		} `json:"keys"`
	}
	if err := oidcJSON(ctx, "GET", m.JWKSURI, nil, nil, &keys); err != nil {
		return identity, err
	}
	claims := &oidcClaims{}
	token, err := jwt.ParseWithClaims(response.IDToken, claims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		if kid == "" {
			return nil, errors.New("missing signing key ID")
		}
		for _, k := range keys.Keys {
			if k.Kid != kid || (k.Use != "" && k.Use != "sig") || (k.Alg != "" && k.Alg != t.Method.Alg()) {
				continue
			}
			if k.Kty == "RSA" && t.Method.Alg() == "RS256" {
				n, e1 := base64.RawURLEncoding.DecodeString(k.N)
				e, e2 := base64.RawURLEncoding.DecodeString(k.E)
				exponent := new(big.Int).SetBytes(e)
				modulus := new(big.Int).SetBytes(n)
				if e1 != nil || e2 != nil || modulus.BitLen() < 2048 || modulus.BitLen() > 8192 || !exponent.IsInt64() || exponent.Int64() < 3 || exponent.Int64() > 2147483647 || exponent.Bit(0) == 0 {
					continue
				}
				return &rsa.PublicKey{N: modulus, E: int(exponent.Int64())}, nil
			}
			if k.Kty == "EC" && k.Crv == "P-256" && t.Method.Alg() == "ES256" {
				x, e1 := base64.RawURLEncoding.DecodeString(k.X)
				y, e2 := base64.RawURLEncoding.DecodeString(k.Y)
				px, py := new(big.Int).SetBytes(x), new(big.Int).SetBytes(y)
				if e1 == nil && e2 == nil && len(x) == 32 && len(y) == 32 && elliptic.P256().IsOnCurve(px, py) {
					return &ecdsa.PublicKey{Curve: elliptic.P256(), X: px, Y: py}, nil
				}
			}
		}
		return nil, errors.New("OIDC signing key unavailable")
	}, jwt.WithValidMethods([]string{"RS256", "ES256"}), jwt.WithIssuer(c.Issuer), jwt.WithAudience(c.ClientID), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithLeeway(30*time.Second))
	if err != nil || token == nil || !token.Valid {
		return identity, errors.New("invalid OIDC ID token")
	}
	if claims.Subject == "" || len(claims.Subject) > 255 || claims.Nonce != nonce || claims.IssuedAt == nil || (len(claims.Audience) > 1 && claims.AuthorizedParty == "") || (claims.AuthorizedParty != "" && claims.AuthorizedParty != c.ClientID) {
		return identity, errors.New("invalid OIDC identity claims")
	}
	// Read custom profile claims only after signature and standard claims pass.
	var profile map[string]json.RawMessage
	parts := strings.Split(response.IDToken, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	if err := json.Unmarshal(raw, &profile); err != nil {
		return identity, err
	}
	get := func(key string) string {
		var value string
		_ = json.Unmarshal(profile[key], &value)
		return strings.TrimSpace(value)
	}
	identity = OIDCIdentity{Subject: claims.Subject, Username: get("preferred_username"), DisplayName: get("name"), Department: get(c.DepartmentClaim), ExpiresAt: claims.ExpiresAt.Time}
	if c.DepartmentClaim != "" && len(profile[c.DepartmentClaim]) > 0 {
		var department string
		if string(profile[c.DepartmentClaim]) == "null" || json.Unmarshal(profile[c.DepartmentClaim], &department) != nil {
			return OIDCIdentity{}, errors.New("invalid OIDC department claim")
		}
	}
	if identity.Username == "" {
		identity.Username = identity.Subject
	}
	if identity.DisplayName == "" {
		identity.DisplayName = identity.Username
	}
	if identity.Department == "" {
		identity.Department = c.DefaultDepartment
	}
	return identity, nil
}
