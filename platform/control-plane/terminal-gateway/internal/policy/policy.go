// Package policy 实现 §8.2 的「敏感动作签名 + OPA 校验」：presence 相关的敏感动作
// （例如广播自己的控制权声明）必须经过两层校验——签名验真 + OPA 鉴权。两层任一失败都
// **fail-closed 拒绝**，绝不静默放行。
//
// 设计要点：
//   - 身份走 CredentialKey → realm+role（见 §8.2）。
//   - 签名用 HMAC-SHA256 覆盖规范载荷，密钥为 LUMO_TERMINAL_SIGNING_SECRET：防伪造、防篡改。
//   - OPA 未配置 / OPA 评估出错 → 一律拒绝（fail-closed）。「策略引擎不可达就放行」等同于
//     把鉴权降级成「看运气」，比显式拒绝对业务更危险。
//   - OPAClient 通过 Evaluator 接口注入，便于测试用替身验证 fail-closed，而不依赖真实 OPA。
package policy

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/observability"
)

// CredentialKey 身份，对应 §8.2「身份走 CredentialKey → realm+role」。
type CredentialKey struct {
	Realm string
	Role  string
	User  string
}

// ControlClaim 一条敏感动作：广播自己的控制权声明（presence 相关的高敏感动作）。
// 必须带签名；服务端据此既验真伪、又走 OPA 鉴权。
type ControlClaim struct {
	SessionRef string
	Claimant   string
	CredentialKey
	Signature string // HMAC-SHA256 over canonical payload，密钥为签名密钥
}

// canonical 规范载荷：参与签名的字段按固定顺序拼接，避免 JSON 字段顺序歧义导致验签不稳。
func (c ControlClaim) canonical() string {
	return strings.Join([]string{c.SessionRef, c.Claimant, c.Realm, c.Role, c.User}, "|")
}

// Sign 用给定密钥计算签名（供客户端/测试；服务端只验不签）。
func Sign(secret string, c ControlClaim) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(c.canonical()))
	return hex.EncodeToString(mac.Sum(nil))
}

// Decision 鉴权结论。Allow=false 时 Reason 必须可读（进审计 / 错误响应，告知「为什么被拒」）。
type Decision struct {
	Allow  bool
	Reason string
}

// Evaluator 策略评估点（OPA 或测试替身）。输入是给 OPA 的 input。
type Evaluator interface {
	Evaluate(ctx context.Context, input map[string]any) (Decision, error)
}

// Authorizer 把「签名验真」与「OPA 鉴权」串起来。两者任一失败都 fail-closed 拒绝。
type Authorizer struct {
	secret string
	eval   Evaluator // nil = OPA 未配置
}

// NewAuthorizer 构造鉴权器。opaBaseURL 为空表示 OPA 未配置（eval=nil → 敏感动作 fail-closed）。
func NewAuthorizer(secret, opaBaseURL string) *Authorizer {
	var eval Evaluator
	if opaBaseURL != "" {
		eval = NewOPAClient(opaBaseURL, "lumo/terminal_control")
	}
	return &Authorizer{secret: secret, eval: eval}
}

// AuthorizeControlClaim 校验一条控制权声明。
//
// 失败模式（全部 fail-closed，拒绝并给出可读原因）：
//   - 签名密钥未配置 → 拒绝（无法验真，宁可错杀）；
//   - 签名缺失/不匹配 → 拒绝；
//   - OPA 未配置 → 拒绝（敏感动作默认不放行）；
//   - OPA 评估出错（网络/形状）→ 拒绝（不能因为策略引擎抖动就放行）。
func (a *Authorizer) AuthorizeControlClaim(ctx context.Context, c ControlClaim) (Decision, error) {
	if a.secret == "" {
		return Decision{Reason: "签名密钥未配置：控制权声明无法验真（fail-closed 拒绝）"}, nil
	}
	if c.Signature == "" {
		return Decision{Reason: "控制权声明缺少签名"}, nil
	}
	mac := hmac.New(sha256.New, []byte(a.secret))
	mac.Write([]byte(c.canonical()))
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(c.Signature)) {
		return Decision{Reason: "控制权声明签名校验失败"}, nil
	}
	if a.eval == nil {
		return Decision{Reason: "OPA 未配置：敏感动作默认拒绝（fail-closed）"}, nil
	}
	dec, err := a.eval.Evaluate(ctx, map[string]any{
		"credential_key": map[string]string{"realm": c.Realm, "role": c.Role},
		"action":         "claim_control",
		"session_ref":    c.SessionRef,
		"claimant":       c.Claimant,
	})
	if err != nil {
		// OPA 抖动：绝不能因为策略引擎不可达就放行。
		return Decision{Reason: fmt.Sprintf("OPA 评估失败：默认拒绝（%v）", err)}, nil
	}
	if !dec.Allow {
		reason := dec.Reason
		if reason == "" {
			reason = "OPA 拒绝该控制权声明"
		}
		return Decision{Allow: false, Reason: reason}, nil
	}
	return Decision{Allow: true, Reason: dec.Reason}, nil
}

// OPAClient 是 Evaluator 的真实实现，向 OPA 的 /v1/data/<path> 发起 POST。
// baseURL 为空时 Evaluate 返回错误——这保证「未配置」永远走 fail-closed，而不是发出空请求。
type OPAClient struct {
	baseURL string
	path    string
	client  *http.Client
}

// NewOPAClient 构造 OPA 客户端。policyPath 为空回落 "lumo/terminal_control"。
func NewOPAClient(baseURL, policyPath string) *OPAClient {
	if policyPath == "" {
		policyPath = "lumo/terminal_control"
	}
	return &OPAClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		path:    strings.Trim(policyPath, "/"),
		client:  observability.ConfiguredHTTPClient(5 * time.Second),
	}
}

// Evaluate 把 input 发给 OPA 并解析 result.allow / result.reason。
func (o *OPAClient) Evaluate(ctx context.Context, input map[string]any) (Decision, error) {
	if o.baseURL == "" {
		return Decision{}, errors.New("policy: OPA 地址未配置")
	}
	body, err := json.Marshal(map[string]any{"input": input})
	if err != nil {
		return Decision{}, fmt.Errorf("policy: OPA 输入序列化失败: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		o.baseURL+"/v1/data/"+o.path, strings.NewReader(string(body)))
	if err != nil {
		return Decision{}, fmt.Errorf("policy: 创建 OPA 请求失败: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := o.client.Do(req)
	if err != nil {
		return Decision{}, fmt.Errorf("policy: OPA 请求失败: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return Decision{}, fmt.Errorf("policy: OPA 返回 HTTP %d", res.StatusCode)
	}
	var envelope struct {
		Result struct {
			Allow  bool   `json:"allow"`
			Reason string `json:"reason"`
		} `json:"result"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&envelope); err != nil {
		return Decision{}, fmt.Errorf("policy: OPA 响应解析失败: %w", err)
	}
	return Decision{Allow: envelope.Result.Allow, Reason: envelope.Result.Reason}, nil
}
