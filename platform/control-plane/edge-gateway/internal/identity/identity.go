// Package identity 让边缘网关对「用户直连」的路由（例如桌面端跨设备记忆同步
// /v1/memory-sync/*）做会话鉴权，并由网关**自己**注入 X-Lumo-* 身份头。
//
// 安全约定：
//   - 身份只来自 governance 校验过的用户会话令牌（GET /v1/auth/session，与
//     user-auth 插件同一个端点），绝不来自客户端自带的头；
//   - 转发前剥掉客户端带来的全部 X-Lumo-* 头（X-Lumo-Correlation-Id 除外，它只是
//     追踪 id，由 observability 传播），再写入校验得到的身份；
//   - 用户令牌不向上游转发：Authorization 被换成控制面服务令牌，满足上游的
//     RequireControlPlaneToken；
//   - 任何不确定都 fail-closed：缺令牌/令牌无效 401，governance 不可用 503。
package identity

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ModeSession 是路由表 `identity` 字段唯一合法的非空取值。
const ModeSession = "session"

// SessionHeader 与 governance / user-auth 的会话头一致。
const SessionHeader = "X-Lumo-Session"

// ErrUnauthenticated 表示令牌缺失、无效或已过期（→ 401）。
var ErrUnauthenticated = errors.New("identity: unauthenticated")

var (
	idPattern   = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	rolePattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)
)

// Principal 是 governance /v1/auth/session 返回的主体（只取网关需要的字段）。
type Principal struct {
	Realm         string   `json:"realm"`
	UserID        string   `json:"user_id"`
	Roles         []string `json:"roles"`
	PrimaryDeptID string   `json:"primary_dept_id,omitempty"`
}

func (p Principal) valid() bool {
	if !idPattern.MatchString(p.Realm) || !idPattern.MatchString(p.UserID) || len(p.Roles) > 32 {
		return false
	}
	for _, r := range p.Roles {
		if !rolePattern.MatchString(r) {
			return false
		}
	}
	return p.PrimaryDeptID == "" || idPattern.MatchString(p.PrimaryDeptID)
}

// Resolver 把用户会话令牌解析成主体。
type Resolver interface {
	Resolve(ctx context.Context, token string) (Principal, error)
}

// GovernanceResolver 通过 governance 校验会话，带一个很短的正向缓存（只缓存
// 成功结果，键是令牌的 sha256，不在内存里保存明文令牌）。
type GovernanceResolver struct {
	BaseURL      string
	ServiceToken string
	Client       *http.Client
	TTL          time.Duration // <=0 表示不缓存
	Now          func() time.Time

	mu    sync.Mutex
	cache map[[32]byte]cached
}

type cached struct {
	p   Principal
	exp time.Time
}

const maxCache = 4096

func (g *GovernanceResolver) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

func (g *GovernanceResolver) Resolve(ctx context.Context, token string) (Principal, error) {
	if token == "" || len(token) > 4096 {
		return Principal{}, ErrUnauthenticated
	}
	key := sha256.Sum256([]byte(token))
	if g.TTL > 0 {
		g.mu.Lock()
		c, ok := g.cache[key]
		g.mu.Unlock()
		if ok && g.now().Before(c.exp) {
			return c.p, nil
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(g.BaseURL, "/")+"/v1/auth/session", nil)
	if err != nil {
		return Principal{}, err
	}
	req.Header.Set(SessionHeader, token)
	req.Header.Set("Authorization", "Bearer "+g.ServiceToken)
	client := g.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return Principal{}, err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound:
		return Principal{}, ErrUnauthenticated
	case resp.StatusCode != http.StatusOK:
		return Principal{}, errors.New("identity: governance returned " + resp.Status)
	}
	var body struct {
		Principal Principal `json:"principal"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&body); err != nil {
		return Principal{}, err
	}
	if !body.Principal.valid() {
		// governance 回了 200 却给不出合规主体：当作不可信，拒绝而不是放行。
		return Principal{}, ErrUnauthenticated
	}
	if g.TTL > 0 {
		g.mu.Lock()
		if g.cache == nil || len(g.cache) >= maxCache {
			g.cache = make(map[[32]byte]cached)
		}
		g.cache[key] = cached{p: body.Principal, exp: g.now().Add(g.TTL)}
		g.mu.Unlock()
	}
	return body.Principal, nil
}

// TokenFrom 取用户会话令牌：优先 X-Lumo-Session，其次 Authorization: Bearer。
func TokenFrom(r *http.Request) string {
	if t := strings.TrimSpace(r.Header.Get(SessionHeader)); t != "" {
		return t
	}
	if t, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		return strings.TrimSpace(t)
	}
	return ""
}

// Strip 删除所有 X-Lumo-* 头（X-Lumo-Correlation-Id 除外）。
func Strip(h http.Header) {
	for k := range h {
		ck := http.CanonicalHeaderKey(k)
		if strings.HasPrefix(ck, "X-Lumo-") && ck != "X-Lumo-Correlation-Id" {
			delete(h, k)
		}
	}
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "edge_identity", "message": msg})
}

// Middleware 校验会话 → 剥头 → 注入身份 → 替换 Authorization 为服务令牌。
func Middleware(res Resolver, serviceToken string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if res == nil || serviceToken == "" {
				writeErr(w, http.StatusServiceUnavailable, "edge identity is not configured")
				return
			}
			token := TokenFrom(r)
			if token == "" {
				writeErr(w, http.StatusUnauthorized, "session token required")
				return
			}
			p, err := res.Resolve(r.Context(), token)
			if errors.Is(err, ErrUnauthenticated) {
				writeErr(w, http.StatusUnauthorized, "invalid session")
				return
			}
			if err != nil {
				writeErr(w, http.StatusServiceUnavailable, "identity service unavailable")
				return
			}
			Strip(r.Header)
			r.Header.Del("Authorization")
			r.Header.Set("X-Lumo-User", p.UserID)
			r.Header.Set("X-Lumo-Realm", p.Realm)
			r.Header.Set("X-Lumo-Roles", strings.Join(p.Roles, ","))
			if p.PrimaryDeptID != "" {
				r.Header.Set("X-Lumo-Dept", p.PrimaryDeptID)
			}
			r.Header.Set("Authorization", "Bearer "+serviceToken)
			next.ServeHTTP(w, r)
		})
	}
}
