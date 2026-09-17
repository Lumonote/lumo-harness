// Package domain 定义连接器网关的领域模型（§10.1）。
//
// 连接器即组件：manifest 声明 protocol/auth/toolSurface/limits/egress。
// 两条硬规矩贯穿全包：
//  1. **凭证只存引用，永不落 manifest/日志/审计**（§15：凭证在 Vault，绝不进 prompt）；
//  2. **调用方永远不能提供完整 URL** —— 上游地址由 manifest 的 BaseURL + Operation.Path
//     拼装，调用方只填已声明的路径参数与白名单 query。这是防 SSRF 的结构性保证，
//     而不是靠事后校验字符串。
package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
)

// RealmID 首要隔离边界（§10.2）；连接器按 realm 注册，跨 realm 不可见。
type RealmID string

func (r RealmID) String() string { return string(r) }

// Protocol 上游协议族（§10.1 覆盖 REST/GraphQL/MCP/SaaS/消息/数据/Legacy/设备）。
// 当前网关实现 HTTP 系（rest/graphql）；mcp 走 dsh python/ bridge，在此仅登记不代理。
type Protocol string

const (
	ProtocolREST    Protocol = "rest"
	ProtocolGraphQL Protocol = "graphql"
	ProtocolMCP     Protocol = "mcp"
)

// AuthKind 上游认证方式。
type AuthKind string

const (
	AuthNone   AuthKind = "none"
	AuthBearer AuthKind = "bearer"
	AuthHeader AuthKind = "header" // 自定义头，如 X-API-Key
	AuthBasic  AuthKind = "basic"  // 凭证格式 user:pass
)

// Auth 认证声明。CredentialRef 是 Vault 路径（Local-lite 下是环境变量名），
// **不是凭证本身** —— 网关运行时才向 CredentialStore 兑换。
type Auth struct {
	Kind          AuthKind `json:"kind"`
	CredentialRef string   `json:"credentialRef"`
	HeaderName    string   `json:"headerName,omitempty"`
	// OAuth is a provider registration contract, never a client secret or a
	// refresh token.  CredentialRef remains the short-lived access-token
	// reference that this gateway resolves only at dispatch time.
	OAuth *OAuth2 `json:"oauth,omitempty"`
}

// OAuth2 is deliberately provider-neutral: a SaaS/MCP integrator must give
// the exact provider endpoints and callback that were registered upstream.
// PKCE is mandatory for the authorization-code flow.  Client refs resolve via
// Vault/environment and are never serialized into an audit record or prompt.
type OAuth2 struct {
	Managed             bool              `json:"managed,omitempty"`
	Provider            string            `json:"provider"`
	AuthorizationURL    string            `json:"authorizationUrl"`
	TokenURL            string            `json:"tokenUrl"`
	CallbackURL         string            `json:"callbackUrl"`
	ClientIDRef         string            `json:"clientIdRef"`
	ClientSecretRef     string            `json:"clientSecretRef"`
	Scopes              []string          `json:"scopes"`
	PKCE                bool              `json:"pkce"`
	ClientAuthMethod    string            `json:"clientAuthMethod,omitempty"`
	AuthorizationParams map[string]string `json:"authorizationParams,omitempty"`
}

// ManagedOAuthRef is a marker. The realm and connector ID determine the Vault
// location; a manifest can never choose another connector's token path.
const ManagedOAuthRef = "oauth:managed"

// Operation 工具面（toolSurface）中的一个可调用操作。
// 未在此登记的操作一律拒绝 —— 工具面是白名单，不是文档。
type Operation struct {
	Name   string `json:"name"`
	Method string `json:"method"`
	// Path 相对 BaseURL 的模板，形如 /v1/issues/{id}；占位符按名由调用方填。
	Path string `json:"path"`
	// AllowedQuery 允许透传的 query 参数白名单（空 = 不允许任何 query）。
	AllowedQuery []string `json:"allowedQuery,omitempty"`
	// AllowedHeaders 允许调用方透传的请求头白名单（空 = 一个都不透传）。
	AllowedHeaders []string `json:"allowedHeaders,omitempty"`
	// Write 标记外部写操作；配合 Sensitivity 决定是否强制 HITL（§10.3）。
	Write bool `json:"write"`
	// Sensitivity: low | normal | high。high + Write ⇒ 默认需人工批准。
	Sensitivity string `json:"sensitivity,omitempty"`
}

// Limits 单连接器的资源闸门。
type Limits struct {
	RequestsPerMinute int   `json:"requestsPerMinute"`
	Burst             int   `json:"burst"`
	TimeoutMS         int   `json:"timeoutMs"`
	MaxRequestBytes   int64 `json:"maxRequestBytes"`
	MaxResponseBytes  int64 `json:"maxResponseBytes"`
}

// Egress 出站边界（OPA 评估 egress 的静态部分）。
type Egress struct {
	// AllowedHosts 允许连出的主机名；空 = 只允许 BaseURL 自身的 host。
	AllowedHosts []string `json:"allowedHosts,omitempty"`
	// AllowPrivateNetwork 允许连内网/环回地址。默认 false —— 拦 SSRF 与 DNS rebinding。
	AllowPrivateNetwork bool `json:"allowPrivateNetwork"`
}

// Redaction PII 脱敏开关。审计记录**永远**脱敏，与此无关；
// 此处控制的是「回给 agent 的响应」与「转给上游的请求」是否脱敏。
type Redaction struct {
	Request  bool `json:"request"`
	Response bool `json:"response"`
}

// Connector 连接器 manifest（注册进 Nacos；Local-lite 落 PG，契约同形）。
type Connector struct {
	ID         string               `json:"id"`
	Realm      RealmID              `json:"realm"`
	Name       string               `json:"name"`
	Protocol   Protocol             `json:"protocol"`
	BaseURL    string               `json:"baseUrl"`
	Auth       Auth                 `json:"auth"`
	Operations map[string]Operation `json:"operations"`
	Limits     Limits               `json:"limits"`
	Egress     Egress               `json:"egress"`
	Redaction  Redaction            `json:"redaction"`
	// Roles 允许调用本连接器的角色（OPA 下沉的粗粒度层）。
	Roles   []string `json:"roles"`
	Enabled bool     `json:"enabled"`
	Version int      `json:"version"`
}

// Caller 已认证的调用者。由边缘/终端网关注入，连接器网关**不自行签发身份**。
//
// 计量归因字段（DeptID/Role/AgentID/ComponentID/Feature/TraceID）由网关注入的
// X-Lumo-* 元数据头解析；缺省语义在网关 buildMeter 处补（'unknown'/'system' +
// 告警），而不是在这里 —— 缺省必须显式化（告警），身份解析层没有日志上下文。
type Caller struct {
	UserID    string
	Realm     RealmID
	Roles     []string
	SessionID string
	ProjectID string
	// Approved 该次调用已获人工批准（HITL）；只能由连接器网关消费与本次
	// 请求精确绑定的一次性审批记录后设置，绝不能由调用方头部或请求体自报。
	Approved bool

	// ── 计量归因（可空；缺省在网关 buildMeter）──
	DeptID      string // X-Lumo-Dept
	Role        string // X-Lumo-Role（单值；鉴权仍用 Roles CSV）
	AgentID     string // X-Lumo-Agent
	ComponentID string // X-Lumo-Component
	Feature     string // X-Lumo-Feature
	TraceID     string // X-Lumo-Trace
}

// Invocation 一次外部调用请求。注意没有 URL 字段 —— 见包注释第 2 条。
type Invocation struct {
	ConnectorID string            `json:"-"`
	Operation   string            `json:"operation"`
	PathParams  map[string]string `json:"pathParams,omitempty"`
	Query       map[string]string `json:"query,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	// Body 原样透传的 JSON 载荷。用 RawMessage 而非 []byte：
	// []byte 在 encoding/json 里是 base64，会逼调用方（包括模型）自己编码。
	Body json.RawMessage `json:"body,omitempty"`
	// CorrelationID 幂等键：同一 ID 的重复调用在审计中可识别为重放。
	CorrelationID string `json:"correlationId,omitempty"`
}

// BodyEncoding 说明 Result.Body 里装的是什么，避免调用方猜。
type BodyEncoding string

const (
	// EncodingJSON Body 是上游原样的 JSON。
	EncodingJSON BodyEncoding = "json"
	// EncodingText 上游返回的不是 JSON（XML/纯文本），已包成 JSON 字符串。
	EncodingText BodyEncoding = "text"
	// EncodingBase64 上游返回二进制，已 base64 包成 JSON 字符串。
	EncodingBase64 BodyEncoding = "base64"
)

// Result 上游响应（可能已脱敏）。
type Result struct {
	Status      int               `json:"status"`
	Headers     map[string]string `json:"headers,omitempty"`
	Body        json.RawMessage   `json:"body,omitempty"`
	Encoding    BodyEncoding      `json:"encoding,omitempty"`
	ContentType string            `json:"contentType,omitempty"`
	DurationMS  int64             `json:"durationMs"`
	Redacted    bool              `json:"redacted"`
}

// 闸门拒绝原因。每一个都对应一个 HTTP 状态与一条审计记录 —— 拒绝必须显式，不静默降级。
var (
	ErrNotFound      = errors.New("connector: 未注册或不在本 realm")
	ErrOperation     = errors.New("connector: 操作不在已声明的工具面内")
	ErrForbidden     = errors.New("connector: 出站策略拒绝")
	ErrRateLimited   = errors.New("connector: 超出速率限制")
	ErrCircuitOpen   = errors.New("connector: 熔断器打开，快速失败")
	ErrTooLarge      = errors.New("connector: 载荷超过上限")
	ErrApproval      = errors.New("connector: 高敏感写操作需人工批准")
	ErrCredential    = errors.New("connector: 凭证解析失败")
	ErrUpstream      = errors.New("connector: 上游调用失败")
	ErrEgressBlocked = errors.New("connector: 目标地址不在出站白名单内")
)

// WebFetchSpec 通用 URL 出站请求（POST /web/fetch，seam 远程形态 §1）。
//
// 与 Invocation 的关键差异：这里**由调用方提供完整 URL** —— web 是通用能力
// （ctx.web 的 fetch），目标由模型/工具在运行时选定，不存在 manifest 可拼装。
// 安全边界因此改由三道闸共同保证（全局黑名单 + 仅公网 + guardDial 建连复核），
// 而不是拼装白名单 —— 见 gateway.WebFetch 与 policy.EvaluateWeb 的注释。
type WebFetchSpec struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	// MaxBytes 本次调用期望的响应上限；≤0 用服务端缺省（8MiB）。
	// 只能向下收紧，不能放大服务端 WebEgress.MaxResponseBytes。
	MaxBytes int64 `json:"maxBytes,omitempty"`
}

// ValidateWebFetch 校验通用出站请求（server 解析后、进网关前调用）。
// 防线收紧为：URL 长度上限 2048、scheme 白名单（http/https）、host 必填。
// 内网禁令不在字符串层面判 —— 解析后建连时由 guardDial 按真实 IP 复核。
func ValidateWebFetch(s WebFetchSpec) error {
	if len(s.URL) > 2048 {
		return fmt.Errorf("%w: URL 长度 %d 超过 2048 上限", ErrOperation, len(s.URL))
	}
	u, err := url.Parse(s.URL)
	if err != nil {
		return fmt.Errorf("%w: URL 非法: %s", ErrOperation, err)
	}
	// 空 scheme 是**调用方输入问题**，不是出站策略拒绝。
	//
	// 必须单列这一支：`url.Parse` 对 "not a url" 这类字符串**不报错**（只拒控制字符，
	// 空格合法），它被解析成一个「带路径的相对引用」，Scheme 为空。若不单列就会落到
	// 下面那条「仅允许 http/https，收到 \"\"」，于是调用方拿到 403 egress_denied，
	// 以为是自己没权限，而真正的问题是 URL 不是绝对地址。
	// 非空但不是 http/https（如 ftp://）仍走下面那支 —— 那才是策略拒绝。
	if u.Scheme == "" {
		return fmt.Errorf("%w: URL 缺少 scheme，必须给出绝对地址（如 https://example.com/path）", ErrOperation)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("%w: 仅允许 http/https，收到 %q", ErrEgressBlocked, u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("%w: URL 缺少 host", ErrOperation)
	}
	return nil
}

// WebEgress 通用 web 出站（POST /web/fetch）的配置（seam 远程形态 §1）。
type WebEgress struct {
	// RequestsPerMinute / Burst 每用户每分钟配额（限流键 realm/web/user）；
	// RequestsPerMinute<=0 视为不限流（与连接器 Limits 同语义）。
	RequestsPerMinute int
	Burst             int
	// MaxResponseBytes 响应上限；≤0 用 8MiB 兜底（同连接器 MaxResponseBytes）。
	MaxResponseBytes int64
	// AllowPrivateNetwork 允许内网/环回目标。默认 false —— 与连接器 Egress 同规：
	// web 是「通用公网出站」，内网放行只给本地调试/受控内网上游。
	AllowPrivateNetwork bool
	// RedactResponse 响应 PII 脱敏。**默认开**（DefaultWebEgress）：
	// web 抓回来的内容直接进模型上下文，默认防护优先于默认便利。
	RedactResponse bool
}

// DefaultWebEgress 平台缺省：60 次/分钟、突发 10、8MiB 上限、仅公网、响应脱敏开。
func DefaultWebEgress() WebEgress {
	return WebEgress{
		RequestsPerMinute: 60,
		Burst:             10,
		MaxResponseBytes:  8 << 20,
		RedactResponse:    true,
	}
}
