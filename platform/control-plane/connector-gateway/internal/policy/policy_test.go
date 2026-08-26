package policy

import (
	"context"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
)

// EvaluateWeb 的判定面（seam 远程形态 §1 项 2）：
//   - 全局黑名单精确拒绝（复用 DefaultRules.GlobalDenyHosts，不可覆盖）；
//   - host 归一化：大小写、端口剥离后比对；
//   - 不放 realm/roles 闸 —— web 是通用能力，任何 realm 的任何角色都可出站
//     （授权在 Authenticator，web 不注册进 realm）。
func TestEvaluateWebGlobalDenyList(t *testing.T) {
	r := DefaultRules()
	cases := []struct {
		name string
		host string
		deny bool
	}{
		{"云元数据 IP", "169.254.169.254", true},
		{"GCP 元数据", "metadata.google.internal", true},
		{"GCP 元数据带端口", "metadata.google.internal:80", true},
		{"GCP 元数据大小写归一", "METADATA.GOOGLE.INTERNAL", true},
		{"metadata.goog 前缀域", "metadata.goog", true},
		{"AWS 元数据", "instance-data", true},
		{"普通域名", "example.com", false},
		{"普通域名带端口", "example.com:443", false},
		{"子域不放宽黑名单", "api.example.com", false},
		{"黑名单子串不误伤", "notmetadata.google.internal.evil.example.com", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dec, err := r.EvaluateWeb(context.Background(),
				WebPolicyRequest{Caller: domain.Caller{Realm: "r1"}, Host: c.host})
			if err != nil {
				t.Fatalf("EvaluateWeb(%q) 意外报错: %v", c.host, err)
			}
			if dec.Allow == c.deny {
				t.Fatalf("host=%q: allow=%v，期望 deny=%v（reason=%q）", c.host, dec.Allow, c.deny, dec.Reason)
			}
			if c.deny && !strings.Contains(dec.Reason, "黑名单") {
				t.Fatalf("拒绝原因应点名黑名单: %q", dec.Reason)
			}
		})
	}
}

// web 不做 realm/roles 闸：空角色、任意 realm 的出站都放行（授权在 Authenticator，
// realm 只用于限速/计量归因）。锁死这个语义，防止将来有人「顺手」把连接器闸搬过来。
func TestEvaluateWebNoRealmOrRoleGate(t *testing.T) {
	r := DefaultRules()
	dec, err := r.EvaluateWeb(context.Background(),
		WebPolicyRequest{Caller: domain.Caller{Realm: "other", Roles: nil}, Host: "example.com"})
	if err != nil {
		t.Fatalf("意外报错: %v", err)
	}
	if !dec.Allow {
		t.Fatalf("web 出站不应要求角色/域归属: %q", dec.Reason)
	}
}
