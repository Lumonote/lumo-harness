package policy

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeEvaluator 是 Evaluator 的测试替身：allow / err 由构造参数决定，不发真实网络请求。
type fakeEvaluator struct {
	allow bool
	err   error
}

func (f fakeEvaluator) Evaluate(_ context.Context, _ map[string]any) (Decision, error) {
	return Decision{Allow: f.allow, Reason: "from-fake"}, f.err
}

func signedClaim(secret string, c ControlClaim) ControlClaim {
	c.Signature = Sign(secret, c)
	return c
}

func baseClaim() ControlClaim {
	return ControlClaim{
		SessionRef:    "s1",
		Claimant:      "u1",
		CredentialKey: CredentialKey{Realm: "r1", Role: "operator", User: "u1"},
	}
}

// 正常路径：密钥配置 + OPA 放行 → 允许。
func TestAuthorize_HappyPath(t *testing.T) {
	a := &Authorizer{secret: "k", eval: fakeEvaluator{allow: true}}
	dec, err := a.AuthorizeControlClaim(context.Background(), signedClaim("k", baseClaim()))
	if err != nil {
		t.Fatalf("不应出错: %v", err)
	}
	if !dec.Allow {
		t.Fatalf("OPA 放行时应允许，得到 reason=%q", dec.Reason)
	}
}

// 反例：签名缺失 → 拒绝。
func TestAuthorize_MissingSignature(t *testing.T) {
	a := &Authorizer{secret: "k", eval: fakeEvaluator{allow: true}}
	c := baseClaim() // 不带签名
	dec, _ := a.AuthorizeControlClaim(context.Background(), c)
	if dec.Allow {
		t.Fatalf("缺签名应被拒绝")
	}
	if !strings.Contains(dec.Reason, "签名") {
		t.Fatalf("拒绝原因应说明签名问题: %q", dec.Reason)
	}
}

// 反例：签名不匹配（篡改 claim 后复用旧签名）→ 拒绝。
func TestAuthorize_BadSignature(t *testing.T) {
	a := &Authorizer{secret: "k", eval: fakeEvaluator{allow: true}}
	c := signedClaim("k", baseClaim())
	c.SessionRef = "tampered" // 改了内容但签名未重算
	dec, _ := a.AuthorizeControlClaim(context.Background(), c)
	if dec.Allow {
		t.Fatalf("签名不匹配应被拒绝")
	}
	if !strings.Contains(dec.Reason, "签名校验失败") {
		t.Fatalf("拒绝原因应说明验签失败: %q", dec.Reason)
	}
}

// 关键反例：OPA 未配置（eval==nil）→ fail-closed 拒绝，且原因写明「OPA 未配置」。
func TestAuthorize_OPAUnconfigured_FailClosed(t *testing.T) {
	// 用 NewAuthorizer 空 opaURL 构造，等价于部署未接线 OPA。
	a := NewAuthorizer("k", "")
	if a.eval != nil {
		t.Fatalf("OPA 未配置时 eval 应为 nil")
	}
	dec, _ := a.AuthorizeControlClaim(context.Background(), signedClaim("k", baseClaim()))
	if dec.Allow {
		t.Fatalf("OPA 未配置必须 fail-closed 拒绝，却放行了")
	}
	if !strings.Contains(dec.Reason, "OPA 未配置") {
		t.Fatalf("拒绝原因应写明 OPA 未配置，得到 %q", dec.Reason)
	}
}

// OPA 评估出错（网络/形状）→ 同样 fail-closed 拒绝，绝不因抖动而放行。
func TestAuthorize_OPAError_FailClosed(t *testing.T) {
	a := &Authorizer{secret: "k", eval: fakeEvaluator{err: errors.New("opa unreachable")}}
	dec, _ := a.AuthorizeControlClaim(context.Background(), signedClaim("k", baseClaim()))
	if dec.Allow {
		t.Fatalf("OPA 出错必须 fail-closed 拒绝，却放行了")
	}
	if !strings.Contains(dec.Reason, "OPA 评估失败") {
		t.Fatalf("拒绝原因应说明 OPA 出错，得到 %q", dec.Reason)
	}
}

// OPA 明确拒绝 → 拒绝，并透出 OPA 的原因。
func TestAuthorize_OPADenies(t *testing.T) {
	a := &Authorizer{secret: "k", eval: fakeEvaluator{allow: false}}
	dec, _ := a.AuthorizeControlClaim(context.Background(), signedClaim("k", baseClaim()))
	if dec.Allow {
		t.Fatalf("OPA 拒绝时应被拒绝")
	}
	if dec.Reason != "from-fake" {
		t.Fatalf("应透出 OPA 原因，得到 %q", dec.Reason)
	}
}

// 签名密钥未配置 → fail-closed 拒绝（连验真都做不到，不能放行）。
func TestAuthorize_NoSecret_FailClosed(t *testing.T) {
	a := &Authorizer{secret: "", eval: fakeEvaluator{allow: true}}
	dec, _ := a.AuthorizeControlClaim(context.Background(), baseClaim())
	if dec.Allow {
		t.Fatalf("无签名密钥必须 fail-closed 拒绝，却放行了")
	}
	if !strings.Contains(dec.Reason, "签名密钥未配置") {
		t.Fatalf("拒绝原因应说明密钥未配置，得到 %q", dec.Reason)
	}
}

// OPAClient 空 baseURL 必须返回错误，保证「未配置」永远走 fail-closed 而不是发空请求。
func TestOPAClient_UnconfiguredReturnsError(t *testing.T) {
	c := NewOPAClient("", "lumo/terminal_control")
	if _, err := c.Evaluate(context.Background(), map[string]any{}); err == nil {
		t.Fatalf("空 baseURL 应返回错误")
	}
}
