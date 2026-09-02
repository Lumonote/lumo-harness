package server

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	authcrypto "github.com/lumo-harness/platform/governance/internal/auth"
	"github.com/lumo-harness/platform/governance/internal/store"
)

type passkeyRegistrationRequest struct {
	Challenge         string `json:"challenge"`
	ID                string `json:"id"`
	RawID             string `json:"raw_id"`
	Type              string `json:"type"`
	ClientDataJSON    string `json:"client_data_json"`
	AttestationObject string `json:"attestation_object"`
	Label             string `json:"label"`
}

type passkeyLoginOptionsRequest struct {
	Realm       string `json:"realm"`
	Username    string `json:"username"`
	CaptchaID   string `json:"captcha_id"`
	CaptchaCode string `json:"captcha_code"`
}

type passkeyLoginRequest struct {
	Challenge         string `json:"challenge"`
	ID                string `json:"id"`
	RawID             string `json:"raw_id"`
	Type              string `json:"type"`
	ClientDataJSON    string `json:"client_data_json"`
	AuthenticatorData string `json:"authenticator_data"`
	Signature         string `json:"signature"`
}

func (s *Server) requirePasskeys(w http.ResponseWriter) bool {
	if s.cfg.WebAuthn.Enabled() {
		return true
	}
	writeError(w, http.StatusServiceUnavailable, "passkey_unavailable", "管理员尚未配置可信 WebAuthn RPID 与 origin")
	return false
}

func (s *Server) authPasskeys(w http.ResponseWriter, r *http.Request) {
	if !s.requirePasskeys(w) {
		return
	}
	values, err := s.store.ListPasskeys(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
		return
	}
	if err != nil {
		s.log.Error("list passkeys", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to list passkeys")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured":                true,
		"rp_id":                     s.cfg.WebAuthn.RPID,
		"require_user_verification": s.cfg.WebAuthn.RequireUserVerification,
		"passkeys":                  values,
	})
}

func (s *Server) authPasskeyRegistrationOptions(w http.ResponseWriter, r *http.Request) {
	if !s.requirePasskeys(w) {
		return
	}
	registration, err := s.store.BeginPasskeyRegistration(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
		return
	}
	if err != nil {
		s.log.Error("begin passkey registration", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to begin passkey registration")
		return
	}
	previous, err := s.store.ListPasskeys(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "unable to load existing passkeys")
		return
	}
	exclude := make([]map[string]string, 0, len(previous))
	for _, value := range previous {
		exclude = append(exclude, map[string]string{"type": "public-key", "id": value.ID})
	}
	verification := "preferred"
	if s.cfg.WebAuthn.RequireUserVerification {
		verification = "required"
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"public_key": map[string]any{
		"challenge": registration.Challenge,
		"rp":        map[string]string{"id": s.cfg.WebAuthn.RPID, "name": s.cfg.WebAuthn.RPName},
		"user": map[string]string{
			"id":   base64.RawURLEncoding.EncodeToString([]byte(registration.Principal.UserID)),
			"name": registration.Principal.Username, "display_name": registration.Principal.DisplayName,
		},
		"pub_key_cred_params":     []map[string]any{{"type": "public-key", "alg": -7}},
		"timeout":                 300000,
		"attestation":             "none",
		"authenticator_selection": map[string]string{"resident_key": "preferred", "user_verification": verification},
		"exclude_credentials":     exclude,
	}})
}

func (s *Server) authPasskeyRegistration(w http.ResponseWriter, r *http.Request) {
	if !s.requirePasskeys(w) {
		return
	}
	var request passkeyRegistrationRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if request.Type != "public-key" {
		writeError(w, http.StatusBadRequest, "invalid_passkey", "credential type must be public-key")
		return
	}
	credentialID, err := authcrypto.CredentialID(firstNonEmpty(request.RawID, request.ID))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_passkey", "invalid credential id")
		return
	}
	clientData, err := decodeWebAuthnBase64(request.ClientDataJSON)
	if err == nil {
		err = authcrypto.VerifyClientData(clientData, request.Challenge, "webauthn.create", s.cfg.WebAuthn)
	}
	attestation, attestationErr := decodeWebAuthnBase64(request.AttestationObject)
	if err == nil {
		err = attestationErr
	}
	var authenticator authcrypto.AuthenticatorData
	if err == nil {
		var rawAuthData []byte
		rawAuthData, err = authcrypto.ParseNoneAttestation(attestation)
		if err == nil {
			authenticator, err = authcrypto.ParseAuthenticatorData(rawAuthData, s.cfg.WebAuthn, true)
		}
	}
	if err == nil && !equalBytes(credentialID, authenticator.CredentialID) {
		err = errors.New("credential id does not match attestation")
	}
	if err != nil {
		writeError(w, http.StatusForbidden, "invalid_passkey", "passkey enrollment verification failed")
		return
	}
	err = s.store.CompletePasskeyRegistration(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)), request.Challenge, credentialID, authenticator.PublicKeyCOSE, authenticator.SignCount, request.Label)
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrPasskeyNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session_or_challenge", "登录或注册挑战已失效")
		return
	}
	if errors.Is(err, store.ErrBadRequest) {
		writeError(w, http.StatusBadRequest, "invalid_passkey", err.Error())
		return
	}
	if err != nil {
		s.log.Error("complete passkey registration", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to store passkey")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": base64.RawURLEncoding.EncodeToString(credentialID), "label": strings.TrimSpace(request.Label)})
}

func (s *Server) authPasskeyDelete(w http.ResponseWriter, r *http.Request) {
	if !s.requirePasskeys(w) {
		return
	}
	err := s.store.DeletePasskey(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)), r.PathValue("credentialID"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
		return
	}
	if errors.Is(err, store.ErrPasskeyNotFound) {
		writeError(w, http.StatusNotFound, "passkey_not_found", "Passkey 不存在")
		return
	}
	if err != nil {
		s.log.Error("delete passkey", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to remove passkey")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) authPasskeyLoginOptions(w http.ResponseWriter, r *http.Request) {
	if !s.requirePasskeys(w) {
		return
	}
	var request passkeyLoginOptionsRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	policy, err := s.authPolicy()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "mfa_unavailable", "认证配置不可用")
		return
	}
	assertion, err := s.store.BeginPasskeyAssertion(r.Context(), store.LoginRequest{Realm: request.Realm, Username: request.Username, CaptchaID: request.CaptchaID, CaptchaCode: request.CaptchaCode, ClientIP: r.Header.Get("X-Lumo-Client-IP")}, policy)
	if errors.Is(err, store.ErrLoginLocked) {
		writeError(w, http.StatusTooManyRequests, "login_locked", "尝试次数过多，请稍后再试")
		return
	}
	if errors.Is(err, store.ErrInvalidLogin) {
		writeError(w, http.StatusUnauthorized, "invalid_login", "用户名、Passkey 或验证码错误")
		return
	}
	if err != nil {
		s.log.Error("begin passkey assertion", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to begin passkey login")
		return
	}
	verification := "preferred"
	if s.cfg.WebAuthn.RequireUserVerification {
		verification = "required"
	}
	allow := make([]map[string]string, 0, len(assertion.CredentialIDs))
	for _, id := range assertion.CredentialIDs {
		allow = append(allow, map[string]string{"type": "public-key", "id": id})
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"public_key": map[string]any{"challenge": assertion.Challenge, "rp_id": s.cfg.WebAuthn.RPID, "timeout": 300000, "user_verification": verification, "allow_credentials": allow}})
}

func (s *Server) authPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	if !s.requirePasskeys(w) {
		return
	}
	var request passkeyLoginRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if request.Type != "public-key" {
		writeError(w, http.StatusBadRequest, "invalid_passkey", "credential type must be public-key")
		return
	}
	credentialID, err := authcrypto.CredentialID(firstNonEmpty(request.RawID, request.ID))
	clientData, clientErr := decodeWebAuthnBase64(request.ClientDataJSON)
	authenticatorData, authDataErr := decodeWebAuthnBase64(request.AuthenticatorData)
	signature, signatureErr := decodeWebAuthnBase64(request.Signature)
	if err == nil {
		err = clientErr
	}
	if err == nil {
		err = authDataErr
	}
	if err == nil {
		err = signatureErr
	}
	if err == nil {
		err = authcrypto.VerifyClientData(clientData, request.Challenge, "webauthn.get", s.cfg.WebAuthn)
	}
	var authenticator authcrypto.AuthenticatorData
	if err == nil {
		authenticator, err = authcrypto.ParseAuthenticatorData(authenticatorData, s.cfg.WebAuthn, false)
	}
	var publicKey []byte
	if err == nil {
		stored, lookupErr := s.store.PasskeyForAssertion(r.Context(), credentialID)
		err = lookupErr
		publicKey = stored.PublicKeyCOSE
	}
	if err == nil {
		err = authcrypto.VerifyAssertion(publicKey, authenticator.Raw, clientData, signature)
	}
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_passkey", "Passkey 登录验证失败")
		return
	}
	result, err := s.store.CompletePasskeyAssertion(r.Context(), request.Challenge, credentialID, authenticator.SignCount, r.Header.Get("X-Lumo-Client-IP"), s.cfg.AuthSessionTTL)
	if errors.Is(err, store.ErrPasskeyClone) {
		writeError(w, http.StatusForbidden, "passkey_clone_detected", "检测到 Passkey 计数异常，登录已拒绝")
		return
	}
	if errors.Is(err, store.ErrPasskeyNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_passkey", "Passkey 或登录挑战已失效")
		return
	}
	if err != nil {
		s.log.Error("complete passkey assertion", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to complete passkey login")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": result.Token, "expires_at": result.Principal.SessionExpiresAt, "principal": result.Principal})
}

func decodeWebAuthnBase64(raw string) ([]byte, error) {
	if len(raw) == 0 || len(raw) > 128<<10 {
		return nil, errors.New("invalid base64url")
	}
	value, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, errors.New("invalid base64url")
	}
	return value, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var diff byte
	for i := range left {
		diff |= left[i] ^ right[i]
	}
	return diff == 0
}
