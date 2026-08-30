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
}

type authPasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

func (s *Server) authPolicy() store.AuthPolicy {
	return store.AuthPolicy{
		MaxAttempts: s.cfg.AuthMaxAttempts,
		LockFor:     s.cfg.AuthLockFor,
		SessionTTL:  s.cfg.AuthSessionTTL,
		CaptchaTTL:  s.cfg.AuthCaptchaTTL,
	}
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
	result, err := s.store.Login(r.Context(), store.LoginRequest{
		Realm:       request.Realm,
		Username:    request.Username,
		Password:    request.Password,
		CaptchaID:   request.CaptchaID,
		CaptchaCode: request.CaptchaCode,
		ClientIP:    r.Header.Get("X-Lumo-Client-IP"),
	}, s.authPolicy())
	if errors.Is(err, store.ErrLoginLocked) {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, result.RetryAfterSeconds)))
		writeError(w, http.StatusTooManyRequests, "login_locked", "尝试次数过多，请稍后再试")
		return
	}
	if errors.Is(err, store.ErrInvalidLogin) {
		writeError(w, http.StatusUnauthorized, "invalid_login", "用户名、密码或验证码错误")
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
