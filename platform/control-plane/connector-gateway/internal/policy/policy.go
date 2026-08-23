// Package policy 出站策略评估（§6.3 单一策略点的下沉实现）。
//
// 形态替代（铁律 21）：Local-lite 用进程内规则；Standalone+ 换 OPA(Rego) 实现
// 同一 Policy 接口。**判定语义在两种实现里必须一致**，所以规则写得直白可枚举，
// 而不是散落在各处的 if。
package policy

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
)

// Request 一次出站评估的输入。
type Request struct {
	Caller    domain.Caller
	Connector domain.Connector
	Operation domain.Operation
	// Host 实际将要连接的主机名（从拼装后的 URL 取，非 manifest 声明值）。
	Host string
}

// Decision 评估结论。Allow=false 时 Reason 必须可读 —— 它会进审计与错误响应。
type Decision struct {
	Allow           bool
	Reason          string
	RequireApproval bool
}

// Policy 策略点。
type Policy interface {
	Evaluate(ctx context.Context, req Request) (Decision, error)
}

// RuleSet 进程内规则实现。
type RuleSet struct {
	// GlobalDenyHosts 全局黑名单（云元数据端点等），优先级高于任何 manifest 白名单。
	GlobalDenyHosts []string
	// RequireApprovalForHighWrite 高敏感写操作是否强制 HITL（§10.3 默认 true）。
	RequireApprovalForHighWrite bool
}

// DefaultRules 平台默认。169.254.169.254 / metadata.* 是云上凭证泄露的经典路径 ——
// 即便某个 manifest 打开了 allowPrivateNetwork，也不能碰它们。
func DefaultRules() *RuleSet {
	return &RuleSet{
		GlobalDenyHosts: []string{
			"169.254.169.254",
			"metadata.google.internal",
			"metadata.goog",
			"instance-data",
		},
		RequireApprovalForHighWrite: true,
	}
}

func (r *RuleSet) Evaluate(_ context.Context, req Request) (Decision, error) {
	// 1) realm 隔离（首要边界）：连接器不属于调用者 realm 一律拒绝
	if req.Connector.Realm != req.Caller.Realm {
		return Decision{Reason: fmt.Sprintf("连接器属于 realm %s，调用者在 %s",
			req.Connector.Realm, req.Caller.Realm)}, nil
	}

	// 2) 角色：调用者角色须与连接器声明的 roles 有交集
	if !intersects(req.Caller.Roles, req.Connector.Roles) {
		return Decision{Reason: fmt.Sprintf("角色 %s 不在连接器允许列表 %s 内",
			strings.Join(req.Caller.Roles, ","), strings.Join(req.Connector.Roles, ","))}, nil
	}

	// 3) 全局黑名单（不可被 manifest 覆盖）
	host := strings.ToLower(hostOnly(req.Host))
	for _, deny := range r.GlobalDenyHosts {
		if host == strings.ToLower(deny) {
			return Decision{Reason: fmt.Sprintf("目标主机 %s 在平台全局黑名单内", host)}, nil
		}
	}

	// 4) egress 白名单：manifest 未声明 allowedHosts 时，只允许 BaseURL 自身的 host
	if !hostAllowed(host, req.Connector) {
		return Decision{Reason: fmt.Sprintf("目标主机 %s 不在连接器 egress 白名单内", host)}, nil
	}

	// 5) HITL：高敏感外部写默认需人工批准（§10.3）
	if r.RequireApprovalForHighWrite && req.Operation.Write && req.Operation.Sensitivity == "high" && !req.Caller.Approved {
		return Decision{Allow: true, RequireApproval: true,
			Reason: "高敏感外部写操作需人工批准"}, nil
	}
	return Decision{Allow: true}, nil
}

func hostAllowed(host string, c domain.Connector) bool {
	allowed := c.Egress.AllowedHosts
	if len(allowed) == 0 {
		u, err := url.Parse(c.BaseURL)
		if err != nil {
			return false
		}
		return strings.EqualFold(hostOnly(u.Host), host)
	}
	for _, a := range allowed {
		a = strings.ToLower(strings.TrimSpace(a))
		if a == host {
			return true
		}
		// 单层通配：*.example.com 匹配 api.example.com，不匹配 example.com 与 a.b.example.com
		if rest, ok := strings.CutPrefix(a, "*."); ok {
			if sub, found := strings.CutSuffix(host, "."+rest); found && sub != "" && !strings.Contains(sub, ".") {
				return true
			}
		}
	}
	return false
}

func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return hostport
}

func intersects(a, b []string) bool {
	set := make(map[string]struct{}, len(b))
	for _, v := range b {
		set[strings.ToLower(strings.TrimSpace(v))] = struct{}{}
	}
	for _, v := range a {
		if _, ok := set[strings.ToLower(strings.TrimSpace(v))]; ok {
			return true
		}
	}
	return false
}
