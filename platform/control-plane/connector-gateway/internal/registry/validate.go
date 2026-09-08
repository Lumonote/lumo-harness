package registry

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
)

// Validate 注册时校验 manifest。**在入口拒绝坏 manifest**，而不是等调用时才炸——
// 一个允许 http:// 或带通配 path 的连接器一旦入库，就是一条常驻的 SSRF 通道。
func Validate(c domain.Connector) error {
	if strings.TrimSpace(c.ID) == "" {
		return fmt.Errorf("connector manifest: id 不能为空")
	}
	if strings.TrimSpace(string(c.Realm)) == "" {
		return fmt.Errorf("connector %s: realm 不能为空", c.ID)
	}
	switch c.Protocol {
	case domain.ProtocolREST, domain.ProtocolGraphQL, domain.ProtocolMCP:
	default:
		return fmt.Errorf("connector %s: 未知 protocol %q", c.ID, c.Protocol)
	}

	u, err := url.Parse(c.BaseURL)
	if err != nil {
		return fmt.Errorf("connector %s: baseUrl 非法: %w", c.ID, err)
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && c.Egress.AllowPrivateNetwork) {
		// 明文 http 只在显式允许内网的连接器上放行（本地调试上游）；对公网一律 https
		return fmt.Errorf("connector %s: baseUrl 必须是 https（内网上游需显式 allowPrivateNetwork）", c.ID)
	}
	if u.Host == "" {
		return fmt.Errorf("connector %s: baseUrl 缺少 host", c.ID)
	}

	if c.Auth.Kind != domain.AuthNone && strings.TrimSpace(c.Auth.CredentialRef) == "" {
		return fmt.Errorf("connector %s: auth.kind=%s 必须给出 credentialRef", c.ID, c.Auth.Kind)
	}
	if c.Auth.Kind == domain.AuthHeader && strings.TrimSpace(c.Auth.HeaderName) == "" {
		return fmt.Errorf("connector %s: auth.kind=header 必须给出 headerName", c.ID)
	}
	// 防呆：manifest 里出现疑似明文凭证即拒绝（凭证只存引用 —— §15）
	if looksLikeSecret(c.Auth.CredentialRef) {
		return fmt.Errorf("connector %s: credentialRef 疑似明文凭证；此处只允许 Vault 路径/环境变量名", c.ID)
	}
	if c.Auth.OAuth != nil {
		if err := validateOAuth(c.ID, c.Auth); err != nil {
			return err
		}
	}
	if strings.HasPrefix(c.Auth.CredentialRef, "oauth:") && (c.Auth.OAuth == nil || !c.Auth.OAuth.Managed || c.Auth.CredentialRef != domain.ManagedOAuthRef) {
		return fmt.Errorf("connector %s: OAuth references require managed OAuth", c.ID)
	}

	if len(c.Operations) == 0 {
		return fmt.Errorf("connector %s: 工具面为空（无可调用操作）", c.ID)
	}
	for name, op := range c.Operations {
		if err := validateOperation(c.ID, name, op); err != nil {
			return err
		}
	}
	if len(c.Roles) == 0 {
		return fmt.Errorf("connector %s: roles 为空 —— 无人可调用的连接器不应注册", c.ID)
	}
	return nil
}

func validateOAuth(connectorID string, auth domain.Auth) error {
	oauth := auth.OAuth
	if oauth.Managed && auth.CredentialRef != domain.ManagedOAuthRef {
		return fmt.Errorf("connector %s: managed OAuth requires credentialRef=oauth:managed", connectorID)
	}
	if oauth.ClientAuthMethod != "" && oauth.ClientAuthMethod != "client_secret_basic" && oauth.ClientAuthMethod != "client_secret_post" {
		return fmt.Errorf("connector %s: unsupported OAuth client authentication method", connectorID)
	}
	for key, value := range oauth.AuthorizationParams {
		if (key != "access_type" && key != "prompt" && key != "audience" && key != "resource") || value == "" || len(value) > 1024 || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("connector %s: invalid OAuth authorization parameter", connectorID)
		}
	}
	if auth.Kind != domain.AuthBearer {
		return fmt.Errorf("connector %s: OAuth access token must use auth.kind=bearer", connectorID)
	}
	if strings.TrimSpace(oauth.Provider) == "" || len([]rune(strings.TrimSpace(oauth.Provider))) > 80 {
		return fmt.Errorf("connector %s: OAuth provider must be 1-80 characters", connectorID)
	}
	if !oauth.PKCE {
		return fmt.Errorf("connector %s: OAuth authorization-code registrations must require PKCE", connectorID)
	}
	for label, raw := range map[string]string{
		"authorizationUrl": oauth.AuthorizationURL,
		"tokenUrl":         oauth.TokenURL,
		"callbackUrl":      oauth.CallbackURL,
	} {
		endpoint, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || raw != strings.TrimSpace(raw) || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.ForceQuery || endpoint.Fragment != "" {
			return fmt.Errorf("connector %s: OAuth %s must be an exact HTTPS URL without credentials, query, or fragment", connectorID, label)
		}
	}
	if strings.TrimSpace(oauth.ClientIDRef) == "" || strings.TrimSpace(oauth.ClientSecretRef) == "" {
		return fmt.Errorf("connector %s: OAuth clientIdRef and clientSecretRef are required", connectorID)
	}
	if looksLikeSecret(oauth.ClientIDRef) || looksLikeSecret(oauth.ClientSecretRef) {
		return fmt.Errorf("connector %s: OAuth registration requires credential references, not literal client credentials", connectorID)
	}
	if len(oauth.Scopes) == 0 || len(oauth.Scopes) > 32 {
		return fmt.Errorf("connector %s: OAuth scopes must contain 1-32 registered scopes", connectorID)
	}
	seen := map[string]bool{}
	for _, raw := range oauth.Scopes {
		scope := strings.TrimSpace(raw)
		if scope == "" || scope != raw || len(scope) > 128 || strings.ContainsAny(scope, " \t\r\n") || seen[scope] {
			return fmt.Errorf("connector %s: OAuth scopes must be distinct non-empty registered scope names", connectorID)
		}
		seen[scope] = true
	}
	return nil
}

var allowedMethods = map[string]bool{
	"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true, "HEAD": true,
}

func validateOperation(connID, name string, op domain.Operation) error {
	if !allowedMethods[strings.ToUpper(op.Method)] {
		return fmt.Errorf("connector %s 操作 %s: 不支持的 method %q", connID, name, op.Method)
	}
	if !strings.HasPrefix(op.Path, "/") {
		return fmt.Errorf("connector %s 操作 %s: path 必须以 / 开头", connID, name)
	}
	// 路径遍历与协议逃逸：`..` 能把 /v1/x/.. 折回上级；`//host` 会被解析成新的 authority
	if strings.Contains(op.Path, "..") || strings.HasPrefix(op.Path, "//") {
		return fmt.Errorf("connector %s 操作 %s: path 不得包含 .. 或以 // 开头", connID, name)
	}
	if strings.ContainsAny(op.Path, "?#") {
		return fmt.Errorf("connector %s 操作 %s: path 不得内嵌 query/fragment（用 allowedQuery 声明）", connID, name)
	}
	switch op.Sensitivity {
	case "", "low", "normal", "high":
	default:
		return fmt.Errorf("connector %s 操作 %s: sensitivity 只能是 low|normal|high", connID, name)
	}
	return nil
}

// looksLikeSecret 粗判引用值是否被误填成了凭证本身。
// 宁可误伤一个奇怪的 Vault 路径，也不要让明文 token 进库。
func looksLikeSecret(ref string) bool {
	r := strings.TrimSpace(ref)
	if len(r) > 64 {
		return true
	}
	lower := strings.ToLower(r)
	for _, p := range []string{"bearer ", "sk-", "ghp_", "xoxb-", "aki", "-----begin"} {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	return false
}
