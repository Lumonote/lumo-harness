package indexing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lumo-harness/platform/observability"
)

// seamIdentityAudience 必须与 shared/seam-contracts/identity.ts 的
// SEAM_IDENTITY_AUDIENCE 逐字相同：断言受众绑定了「只能给 seam host 用」，
// 改一个字符就会让 host 侧校验失败（403），而不是静默降级。
const seamIdentityAudience = "lumo-seam-host"

// seamIngestPath 是 seam host 的通用调用面：POST /seam/{seam}/{method}。
// 方法名进路径、参数进 body 的 args 数组，与 flows 的 knowledge 算子同一协议。
const seamIngestPath = "/seam/knowledge/ingest"

// defaultMaxBodyBytes 单次 ingest 请求体上限。
//
// 上限存在的意义不是省流量而是**让失败可见**：文档正文上限 8 MiB，分片后 JSON 还要
// 加上转义开销，所以 16 MiB 足够；超限说明配置或分片逻辑出了问题，应当显式失败。
const defaultMaxBodyBytes = 16 << 20

// seamResponse 是 host 的统一响应外壳（见 remote.ts 的 SeamResponse）。
type seamResponse struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// seamCall 通用调用信封。参数是**位置参数数组**（host 按 arity 严格校验个数），
// 不是具名对象——多传少传都说明两端契约版本不一致，host 会直接拒绝而不猜。
type seamCall struct {
	Seam   string `json:"seam"`
	Method string `json:"method"`
	Args   []any  `json:"args"`
}

// SeamConfig 远端知识库 seam 的连接与身份配置。
type SeamConfig struct {
	// BaseURL seam host 根地址（如 http://127.0.0.1:8790）。必填。
	BaseURL string
	// ControlToken 控制面令牌，同时用于 Authorization 与 X-Lumo-Seam-Token。
	ControlToken string
	// IdentitySecret 签发短时身份断言的 HMAC 密钥，至少 32 字节。
	//
	// 必填且必须够长：host 一旦配置了 identityAssertionSecret，就**只**信任签名断言，
	// 缺失或坏签名一律 403 且绝不回退到可伪造的普通头。所以这里不能有「留空就降级」
	// 的路径——宁可启动失败。
	IdentitySecret string
	// UserID 断言中的调用主体。必须是 host 能接受的 id 形状（字母数字 . _ : -）。
	UserID string
	// Roles 断言中的角色集合，至少一个。
	//
	// ingest 目前不做角色鉴权（只有 query 会查 allowedRoles），因此这里的值只影响
	// 断言本身是否合法。保留它是因为断言一旦成为鉴权输入，这就是唯一的旋钮。
	Roles []string
	// Component 溯源用的组件名，进 X-Lumo-Component。
	Component string
	// MaxBodyBytes 请求体上限，0 表示用 defaultMaxBodyBytes。
	MaxBodyBytes int
	// Timeout 单次调用超时，0 表示 60s（下游要同步跑 embedding，不能太短）。
	Timeout time.Duration
	// Client 可注入的 HTTP 客户端（测试与连接复用）。
	Client *http.Client
}

// SeamIndexer 通过 seam host 把投影写进知识库 Provider。
type SeamIndexer struct {
	baseURL        string
	controlToken   string
	identitySecret string
	userID         string
	roles          []string
	component      string
	maxBody        int
	client         *http.Client
}

// NewSeamIndexer 构造适配器。配置不合法时**立即报错**，不留到第一次派发才暴露。
func NewSeamIndexer(cfg SeamConfig) (*SeamIndexer, error) {
	if strings.TrimSpace(cfg.BaseURL) == "" {
		return nil, fmt.Errorf("indexing: 未配置知识库 seam 地址")
	}
	parsed, err := url.Parse(cfg.BaseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("indexing: 知识库 seam 地址不合法: %q", cfg.BaseURL)
	}
	if cfg.UserID == "" {
		return nil, fmt.Errorf("indexing: 未配置知识库索引身份（userId）")
	}
	if len(cfg.Roles) == 0 {
		return nil, fmt.Errorf("indexing: 未配置知识库索引角色（roles）")
	}
	// 用占位 realm 试签一次：一次调用即可校验密钥长度、userId/roles 形状，
	// 避免把配置错误推迟成每一行的 403。
	if _, err := observability.SignIdentityHeaders(
		observability.Identity{Realm: "probe", UserID: cfg.UserID, Roles: cfg.Roles},
		seamIdentityAudience, cfg.IdentitySecret); err != nil {
		return nil, fmt.Errorf("indexing: 身份断言配置不可用: %w", err)
	}

	maxBody := cfg.MaxBodyBytes
	if maxBody <= 0 {
		maxBody = defaultMaxBodyBytes
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	client := cfg.Client
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	component := cfg.Component
	if component == "" {
		component = "collaborator"
	}
	return &SeamIndexer{
		baseURL:        strings.TrimRight(cfg.BaseURL, "/"),
		controlToken:   cfg.ControlToken,
		identitySecret: cfg.IdentitySecret,
		userID:         cfg.UserID,
		roles:          cfg.Roles,
		component:      component,
		maxBody:        maxBody,
		client:         client,
	}, nil
}

// Ingest 把一条投影写进远端知识库。
//
// realm 由**被投影文档**决定而不是由某个全局身份决定：host 会拿断言里的 realm 与
// 载荷里的 realm 逐字比对，不一致就是 403。所以每篇文档各自签一次断言，绝不能复用
// 一个「服务身份」去写所有租户——那在 host 侧就是越权，这里也是数据串租户的路径。
func (s *SeamIndexer) Ingest(ctx context.Context, entry Ingest) error {
	payload, err := json.Marshal(seamCall{Seam: "knowledge", Method: "ingest", Args: []any{entry}})
	if err != nil {
		return fmt.Errorf("%w: 序列化投影载荷失败: %v", ErrRejected, err)
	}
	if len(payload) > s.maxBody {
		return fmt.Errorf("%w: 投影请求体 %d 字节超过上限 %d（文档 %s v%d）",
			ErrRejected, len(payload), s.maxBody, entry.Doc.DocID, entry.Doc.SourceVersion)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+seamIngestPath, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("indexing: 构造投影请求失败: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if s.controlToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.controlToken)
	}
	req.Header.Set("X-Lumo-Realm", entry.Doc.Realm)
	req.Header.Set("X-Lumo-User", s.userID)
	req.Header.Set("X-Lumo-Roles", strings.Join(s.roles, ","))
	req.Header.Set("X-Lumo-Role", s.roles[0])
	req.Header.Set("X-Lumo-Component", s.component)
	if s.controlToken != "" {
		req.Header.Set("X-Lumo-Seam-Token", s.controlToken)
	}
	headers, err := observability.SignIdentityHeaders(observability.Identity{
		Realm: entry.Doc.Realm, UserID: s.userID, Roles: s.roles,
	}, seamIdentityAudience, s.identitySecret)
	if err != nil {
		// 断言签不出来通常意味着 realm 里有 host 不接受的字符：这是该行载荷的属性，
		// 不是节点故障，重试同一行没有意义。
		return fmt.Errorf("%w: 签发身份断言失败（realm=%q）: %v", ErrRejected, entry.Doc.Realm, err)
	}
	for key, values := range headers {
		req.Header[key] = values
	}

	res, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("indexing: 调用知识库 seam 失败（文档 %s v%d）: %w",
			entry.Doc.DocID, entry.Doc.SourceVersion, err)
	}
	defer res.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if readErr != nil {
		return fmt.Errorf("indexing: 读取知识库 seam 响应失败: %w", readErr)
	}
	if res.StatusCode == http.StatusOK {
		return nil
	}
	return classifySeamFailure(res.StatusCode, raw)
}

// classifySeamFailure 把 host 的错误响应映射成「终态」或「可重试」。
//
// 只把 invalid（400）判为终态。其余一律可重试，理由：
//
//   - 403 既可能是 realm 串了（永久），也可能是令牌/密钥配置错（可修复）。判成永久
//     会在一次配置故障期间把整条积压推成停滞；判成可重试最多是多试几轮。
//   - 500 包含了 Provider 的源版本冲突（KnowledgeSourceConflictError 没有自己的错误码，
//     会被归类成 internal）。那意味着更新的版本已经写进去了，重试旧版本会被再次拒绝，
//     但有 attempts 上限兜底，不会无限循环。
//   - 501/503/504 是明确的「现在不行，等会儿再来」。
func classifySeamFailure(status int, raw []byte) error {
	var body seamResponse
	_ = json.Unmarshal(raw, &body)
	detail := strings.TrimSpace(body.Message)
	if detail == "" {
		detail = strings.TrimSpace(string(raw))
	}
	if len(detail) > 300 {
		detail = detail[:300]
	}
	summary := fmt.Sprintf("seam 返回 %d code=%s: %s", status, body.Code, detail)
	if status == http.StatusBadRequest || body.Code == "invalid" {
		return fmt.Errorf("%w: %s", ErrRejected, summary)
	}
	return fmt.Errorf("indexing: %s", summary)
}
