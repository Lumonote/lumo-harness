// Package policy 是共享执行控制的授权层（§8.4.2）：**每条控制指令在生效前都必须经 OPA 评估**。
//
// # 两件必须分开的事
//
//	policy_denied      策略引擎正常工作，判定为不允许（权限不足）
//	policy_unavailable 策略引擎没配置、连不上、或返回了读不懂的东西
//
// 为什么非要拆：这两件事的处置完全相反。前者要人去找管理员要权限；后者要人去看
// OPA 起没起来。合成一个「403 权限不足」之后，一次 OPA 容器崩溃会表现成「全公司突然
// 都没有控制权限了」——运维会去查权限配置，而真正的问题在别处。这个仓库在别的服务上
// 已经为同一类问题付过代价（把「配置没配好」当成「拒绝」会让配置问题变成全平台停摆），
// 所以这里把它前置成类型层面的事实：ErrUnavailable 是唯一的「引擎不可用」信号，
// 调用方用 errors.Is 判断，**不允许**靠错误文案。
//
// 未配置 OPA 时**不放行**（fail-closed）：控制指令能 pause/abort 别人的会话，是一个
// 明确的特权动作；「策略引擎没起来」在这个量级上必须是拒绝而不是放行。这与 §8.2 里
// presence 敏感动作的处理口径一致。
//
// # input 的形状由**被部署的策略**决定，不由本包决定
//
// `platform/deploy/policies/session-control.rego` 是部署侧真正加载的东西
// （compose.cluster.yml 把它挂进 OPA 并 `--server /policies`），它读的是**扁平**的
// 键：`input.command` / `input.sessionRef` / `input.realm` / `input.role` / `input.actor`。
// 本包曾按更漂亮的嵌套形状（`actor: {realm,role,subject}`）发送，那样部署后规则里
// 的 `input.realm` 恒为 undefined → **每一条控制指令都会被拒**，而 Go 侧测试全绿
// （它们只断言我们发出去的形状，从不看策略读什么）。因此 input 由 Principal 展平
// 生成，并有 Input_keysMatchDeployedPolicy 从 rego 原文里反抽键来核对——两边一旦
// 漂移，测试先红，而不是等到生产上「所有人都没有控制权限」。
package policy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/observability"
)

// ErrUnavailable 表示「无法得到策略判定」——未配置、连不上、超时、响应非法。
// 它**不等于**「策略判定为不允许」：后者是 (Decision{Allowed:false}, nil)。
//
// 调用方必须用 errors.Is(err, ErrUnavailable) 判断，据此返回 503 + policy_unavailable
// （可重试，属临时性），而把 Allowed=false 映射成 403 + policy_denied（永久性）。
var ErrUnavailable = errors.New("策略引擎不可用")

// Principal 是发起控制指令的主体（§8.4.2：控制权 = realm + role + session 内指定）。
//
// 字段名与 rego 读取的 input 键**不同名**（Subject → input.actor），因为策略是按
// §8.4.2 的事件载荷命名的，那里主体就叫 `actor`。这个换算只有 Input() 一处，
// 由键对齐用例守着。
type Principal struct {
	Realm string
	Role  string
	// Subject 是主体标识。字段名取 Subject 而不是 Actor：本包里 `actor` 特指
	// OPA 那一侧的键名，两处混用会让「把 role 塞进 actor」这种错法看起来正常。
	Subject string
	// SessionOwners 是会话内被显式指定的控制者。它属于**会话**而不属于主体，
	// 但策略评估需要两者同时在场才能判定，所以一路带进 input。
	SessionOwners []string
}

// Request 是一次授权请求的输入。
type Request struct {
	Command       string
	SessionRef    string
	Principal     Principal
	Reason        string
	CorrelationID string
}

// Input 把请求展平成本包与策略之间约定的 input 形状。
//
// 展平是刻意的：见包注释——策略读平铺的 `input.realm`，而嵌套会让它恒为 undefined。
// 未设置的可选键**不出现**（而不是出现为空字符串）：rego 里 `input.reason != ""`
// 与「键不存在」是两种写法，凭空补空串会让策略作者的 `!= ""` 判断与 `not input.reason`
// 判断得出不同结果。
func (r Request) Input() map[string]any {
	in := map[string]any{
		"command":    r.Command,
		"sessionRef": r.SessionRef,
		"realm":      r.Principal.Realm,
		"role":       r.Principal.Role,
		"actor":      r.Principal.Subject,
	}
	if r.Reason != "" {
		in["reason"] = r.Reason
	}
	if r.CorrelationID != "" {
		in["correlationId"] = r.CorrelationID
	}
	if len(r.Principal.SessionOwners) > 0 {
		in["sessionOwners"] = r.Principal.SessionOwners
	}
	return in
}

// Decision 是策略判定结果。字段名与 OPA 侧约定为 allow/reason。
type Decision struct {
	Allowed bool   `json:"allow"`
	Reason  string `json:"reason"`
}

// Authorizer 是授权入口。实现只有 OPA 一种：**故意不提供静态规则回落**。
//
// 提供回落会很方便（本地没有 OPA 容器时也能跑起来），但那等于给「策略引擎没起来」
// 开了一个静默放行的后门，而放行的是 pause/abort 这类特权动作。宁可让本地环境明确
// 跑在「敏感动作全拒」之下（日志会说明是引擎不可用），也不要有一份能被误当成生效
// 策略的本地规则。
type Authorizer struct {
	baseURL string
	path    string
	client  *http.Client
}

// New 构造授权器。baseURL 为空时返回的对象**仍然可用**，只是任何请求都会得到
// ErrUnavailable——这样调用点不必到处判 nil，而「未配置」这件事从一条隐式的空指针
// 变成了一条显式的、可测的错误。
func New(baseURL, policyPath string) *Authorizer {
	if strings.TrimSpace(policyPath) == "" {
		// 默认路径必须与 platform/deploy/policies/session-control.rego 的 package
		// 声明一致（`lumo.session_control`）。带服务名而不是通用名也是刻意的：控制指令
		// 的策略是**本服务**的，与连接器出口策略（lumo/egress）不是一套，共用默认值会让
		// 忘了配路径的实例去查错误的策略包，而错误的包恰好可能返回 allow。
		// 这条一致性由 policy_test 的键对齐用例一并断言（它同时读 rego 的 package 行）。
		policyPath = "lumo/session_control"
	}
	return &Authorizer{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		path:    strings.Trim(strings.TrimSpace(policyPath), "/"),
		// 5s 与连接器网关的 OPA 客户端同口径：控制指令是人在等结果的交互路径，
		// 比它更长的超时不如直接失败（用户会重试）。
		client: observability.ConfiguredHTTPClient(5 * time.Second),
	}
}

// Authorize 评估一条控制指令。三种结果：
//
//	(Decision{Allowed:true},  nil)            放行
//	(Decision{Allowed:false}, nil)            策略判定不允许（403，永久）
//	(Decision{}, ErrUnavailable 包装)         拿不到判定（503，可重试）
func (a *Authorizer) Authorize(ctx context.Context, req Request) (Decision, error) {
	if a == nil || a.baseURL == "" {
		return Decision{}, fmt.Errorf("%w: 未配置 OPA 地址（LUMO_OPA_URL 为空），控制指令按 fail-closed 拒绝",
			ErrUnavailable)
	}
	body, err := json.Marshal(map[string]any{"input": req.Input()})
	if err != nil {
		// 序列化失败是**我们的**输入有问题，不是引擎不可用；但它在语义上仍然
		// 「拿不到判定」，所以同样归到 ErrUnavailable 而不是放行。
		return Decision{}, fmt.Errorf("%w: 策略输入序列化失败: %v", ErrUnavailable, err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		a.baseURL+"/v1/data/"+a.path, strings.NewReader(string(body)))
	if err != nil {
		return Decision{}, fmt.Errorf("%w: 构造 OPA 请求失败: %v", ErrUnavailable, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	res, err := a.client.Do(httpReq)
	if err != nil {
		return Decision{}, fmt.Errorf("%w: 请求 OPA 失败: %v", ErrUnavailable, err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return Decision{}, fmt.Errorf("%w: OPA 返回 HTTP %d", ErrUnavailable, res.StatusCode)
	}

	// 限制读取量：策略服务返回一个超大 body 不应把控制面拖垮。
	var envelope struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&envelope); err != nil {
		return Decision{}, fmt.Errorf("%w: OPA 响应解析失败: %v", ErrUnavailable, err)
	}
	// result 缺失或为 null 时**不能**当成 allow=false：那会把「策略包没加载」
	// 静默成「权限不足」，正是本包开头要避免的那种混淆。它属于「拿不到判定」。
	if len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		return Decision{}, fmt.Errorf("%w: OPA 响应缺少 result（策略包未加载？路径 %q 是否正确）",
			ErrUnavailable, a.path)
	}
	var decision Decision
	if err := json.Unmarshal(envelope.Result, &decision); err != nil {
		return Decision{}, fmt.Errorf("%w: OPA result 形状非法（期望 {allow,reason}）: %v",
			ErrUnavailable, err)
	}
	if !decision.Allowed && strings.TrimSpace(decision.Reason) == "" {
		// 拒绝但没给理由：允许它通过，但补一句可读原因。策略作者漏写 reason 时，
		// 审计里至少不会只有一条空洞的 denied。
		decision.Reason = "策略判定不允许（策略未提供 reason）"
	}
	return decision, nil
}
