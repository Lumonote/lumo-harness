package server

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	authcrypto "github.com/lumo-harness/platform/governance/internal/auth"
	"github.com/lumo-harness/platform/governance/internal/store"
)

const sessionHeader = "X-Lumo-Session"

type authLoginRequest struct {
	Realm       string `json:"realm"`
	Username    string `json:"username"`
	Password    string `json:"password"`
	CaptchaID   string `json:"captcha_id"`
	CaptchaCode string `json:"captcha_code"`
	MFACode     string `json:"mfa_code"`
}

type authPasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

type authMFAConfirmRequest struct {
	Code string `json:"code"`
}

func (s *Server) authMFAKey() ([]byte, error) {
	if strings.TrimSpace(s.cfg.AuthMFAKey) == "" {
		return nil, nil
	}
	return authcrypto.DecodeMFAKey(s.cfg.AuthMFAKey)
}

func (s *Server) authPolicy() (store.AuthPolicy, error) {
	key, err := s.authMFAKey()
	if err != nil {
		return store.AuthPolicy{}, err
	}
	return store.AuthPolicy{
		MaxAttempts: s.cfg.AuthMaxAttempts,
		LockFor:     s.cfg.AuthLockFor,
		SessionTTL:  s.cfg.AuthSessionTTL,
		CaptchaTTL:  s.cfg.AuthCaptchaTTL,
		MFAKey:      key,
	}, nil
}

func (s *Server) authCaptcha(w http.ResponseWriter, r *http.Request) {
	challenge, err := s.store.CreateCaptcha(r.Context(), s.cfg.AuthCaptchaTTL)
	if err != nil {
		s.log.Error("create login captcha", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to create verification image")
		return
	}
	image, err := authcrypto.RenderCaptchaGridPNG(challenge.Tiles)
	if err != nil {
		s.log.Error("render login captcha", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to render verification image")
		return
	}
	expiresIn := max(1, int(time.Until(challenge.ExpiresAt).Seconds()+1))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Lumo-Captcha-ID", challenge.ID)
	w.Header().Set("X-Lumo-Captcha-Expires-In", strconv.Itoa(expiresIn))
	writeJSON(w, http.StatusOK, map[string]any{
		"id":         challenge.ID,
		"prompt":     authcrypto.Prompt(challenge.Targets),
		"expires_in": expiresIn,
		"image":      base64.StdEncoding.EncodeToString(image),
	})
}

func (s *Server) authLogin(w http.ResponseWriter, r *http.Request) {
	var request authLoginRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	policy, err := s.authPolicy()
	if err != nil {
		s.log.Error("MFA key configuration invalid", "err", err)
		writeError(w, http.StatusServiceUnavailable, "mfa_unavailable", "MFA 配置不可用")
		return
	}
	result, err := s.store.Login(r.Context(), store.LoginRequest{
		Realm:       request.Realm,
		Username:    request.Username,
		Password:    request.Password,
		CaptchaID:   request.CaptchaID,
		CaptchaCode: request.CaptchaCode,
		ClientIP:    r.Header.Get("X-Lumo-Client-IP"),
		MFACode:     request.MFACode,
	}, policy)
	if errors.Is(err, store.ErrLoginLocked) {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, result.RetryAfterSeconds)))
		writeError(w, http.StatusTooManyRequests, "login_locked", "尝试次数过多，请稍后再试")
		return
	}
	if errors.Is(err, store.ErrInvalidLogin) {
		writeError(w, http.StatusUnauthorized, "invalid_login", "用户名、密码或验证码错误")
		return
	}
	if errors.Is(err, store.ErrMFAUnavailable) {
		writeError(w, http.StatusServiceUnavailable, "mfa_unavailable", "MFA 配置不可用")
		return
	}
	if err != nil {
		s.log.Error("authenticate user", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "authentication service unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":      result.Token,
		"expires_at": result.Principal.SessionExpiresAt,
		"principal":  result.Principal,
	})
}

func (s *Server) authMFAStatus(w http.ResponseWriter, r *http.Request) {
	configured := strings.TrimSpace(s.cfg.AuthMFAKey) != ""
	if configured {
		if _, err := s.authMFAKey(); err != nil {
			writeError(w, http.StatusServiceUnavailable, "mfa_unavailable", "MFA 配置不可用")
			return
		}
	}
	status, err := s.store.MFAStatus(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)), configured)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
		return
	}
	if err != nil {
		s.log.Error("get MFA status", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to read MFA status")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) authMFAEnroll(w http.ResponseWriter, r *http.Request) {
	key, err := s.authMFAKey()
	if err != nil || len(key) != 32 {
		writeError(w, http.StatusServiceUnavailable, "mfa_unavailable", "管理员尚未配置 MFA 加密密钥")
		return
	}
	enrollment, err := s.store.BeginTOTPEnrollment(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)), key)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "mfa_already_enabled", "请先使用当前 MFA 因子完成停用后再重新绑定")
		return
	}
	if err != nil {
		s.log.Error("begin MFA enrollment", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to begin MFA enrollment")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, enrollment)
}

func (s *Server) authMFAConfirm(w http.ResponseWriter, r *http.Request) {
	var request authMFAConfirmRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	key, err := s.authMFAKey()
	if err != nil || len(key) != 32 {
		writeError(w, http.StatusServiceUnavailable, "mfa_unavailable", "管理员尚未配置 MFA 加密密钥")
		return
	}
	status, err := s.store.ConfirmTOTPEnrollment(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)), request.Code, key)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "mfa_enrollment_not_found", "没有待确认的 MFA 绑定")
		return
	}
	if errors.Is(err, store.ErrInvalidMFA) {
		writeError(w, http.StatusForbidden, "invalid_mfa_code", "动态验证码无效")
		return
	}
	if errors.Is(err, store.ErrBadRequest) {
		writeError(w, http.StatusBadRequest, "mfa_enrollment_expired", err.Error())
		return
	}
	if err != nil {
		s.log.Error("confirm MFA enrollment", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to confirm MFA enrollment")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) authMFADisable(w http.ResponseWriter, r *http.Request) {
	var request authMFAConfirmRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	key, err := s.authMFAKey()
	if err != nil || len(key) != 32 {
		writeError(w, http.StatusServiceUnavailable, "mfa_unavailable", "管理员尚未配置 MFA 加密密钥")
		return
	}
	err = s.store.DisableTOTP(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)), request.Code, key)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
		return
	}
	if errors.Is(err, store.ErrInvalidMFA) {
		writeError(w, http.StatusForbidden, "invalid_mfa_code", "动态验证码无效")
		return
	}
	if err != nil {
		s.log.Error("disable MFA", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to disable MFA")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) authSession(w http.ResponseWriter, r *http.Request) {
	principal, err := s.store.Session(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
		return
	}
	if err != nil {
		s.log.Error("validate user session", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "authentication service unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"principal": principal})
}

func (s *Server) authSessions(w http.ResponseWriter, r *http.Request) {
	sessions, err := s.store.ListAuthSessions(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
		return
	}
	if err != nil {
		s.log.Error("list user sessions", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to list sessions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

func (s *Server) authSecurityEvents(w http.ResponseWriter, r *http.Request) {
	events, err := s.store.ListAuthSecurityEvents(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
		return
	}
	if err != nil {
		s.log.Error("list user security events", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to list security events")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func (s *Server) authRevokeSession(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.Header.Get(sessionHeader))
	if _, err := s.store.Session(r.Context(), token); errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
		return
	} else if err != nil {
		s.log.Error("validate user session for revocation", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "authentication service unavailable")
		return
	}
	err := s.store.RevokeAuthSession(r.Context(), token, r.PathValue("sessionID"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "session_not_found", "会话不存在或已失效")
		return
	}
	if err != nil {
		s.log.Error("revoke user session", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to revoke session")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) authRevokeOtherSessions(w http.ResponseWriter, r *http.Request) {
	count, err := s.store.RevokeOtherAuthSessions(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
		return
	}
	if err != nil {
		s.log.Error("revoke other user sessions", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to revoke sessions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": count})
}

func (s *Server) authLogout(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Logout(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader))); err != nil {
		s.log.Error("revoke user session", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to revoke session")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) authPassword(w http.ResponseWriter, r *http.Request) {
	var request authPasswordRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	err := s.store.ChangePassword(r.Context(), strings.TrimSpace(r.Header.Get(sessionHeader)), request.CurrentPassword, request.NewPassword)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusUnauthorized, "invalid_session", "登录已失效")
	case errors.Is(err, store.ErrInvalidPassword):
		writeError(w, http.StatusForbidden, "invalid_password", "当前密码错误")
	case errors.Is(err, store.ErrBadRequest):
		writeError(w, http.StatusUnprocessableEntity, "invalid_password", err.Error())
	case err != nil:
		s.log.Error("change user password", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "unable to change password")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
