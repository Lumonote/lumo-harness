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
}

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
type Caller struct {
	UserID    string
	Realm     RealmID
	Roles     []string
	SessionID string
	ProjectID string
	// Approved 该次调用已获人工批准（HITL）；由终端网关在审批回流后带入。
	Approved bool
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
