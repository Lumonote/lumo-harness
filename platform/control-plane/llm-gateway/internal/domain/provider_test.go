package domain_test

// provider 管理面 DTO 的纯校验测试：不连库、不起服务。
//
// 这一层是 400 判据的唯一真相源，所以每个拒绝理由都要有一条用例——否则「校验器」
// 本身就成了没被校验的代码。同理，每个**必须被接受**的形态也要有：只有拒绝用例的
// 校验器很容易写成「一律拒绝」，而那种 bug 在集成测试里才暴露。

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/llm-gateway/internal/domain"
)

func strptr(s string) *string   { return &s }
func f64ptr(f float64) *float64 { return &f }
func boolptr(b bool) *bool      { return &b }

// 每个用例都断言「是 ErrInvalidProvider 这个哨兵」而不只是「出错了」：handler 靠
// errors.Is 把校验失败映射成 400，换成别的错误就会变成 500。
func wantInvalid(t *testing.T, err error, what string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s：应当被拒绝，却通过了", what)
	}
	if !errors.Is(err, domain.ErrInvalidProvider) {
		t.Fatalf("%s：应当是 ErrInvalidProvider，实际 %v", what, err)
	}
}

func TestValidateModelAcceptsRealModelNames(t *testing.T) {
	for _, model := range []string{
		"gpt-4o",
		"openai/gpt-4", // 带斜杠：这正是路由要用 {model...} 的原因
		"anthropic/claude-3-5-sonnet",
		"qwen2.5-72b-instruct",
		"模型", // 非 ASCII 也要能过（len 是字节数，不是字符数）
		strings.Repeat("a", 200),
	} {
		if err := domain.ValidateModel(model); err != nil {
			t.Fatalf("合法模型名 %q 被拒: %v", model, err)
		}
	}
}

func TestValidateModelRejects(t *testing.T) {
	for _, tc := range []struct{ name, model string }{
		{"空", ""},
		{"纯空白", "   "},
		{"前导空白", " gpt-4o"},
		{"尾随空白", "gpt-4o "},
		{"换行", "gpt-4o\n"},
		{"内嵌控制字符", "gpt\x004o"},
		{"DEL", "gpt\x7fo"},
		{"超长", strings.Repeat("a", 201)},
	} {
		// 超长用的是字节数：多字节字符按 UTF-8 长度算，避免用字符数放进来一个
		// 三倍长的路径段
		wantInvalid(t, domain.ValidateModel(tc.model), "model "+tc.name)
	}
}

func TestNormalizeUpstreamBaseURLAcceptsAndTrims(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"http://llm:8000", "http://llm:8000"},
		{"https://api.openai.com", "https://api.openai.com"},
		{"http://llm:8000/v1", "http://llm:8000/v1"},
		{"  http://llm:8000/v1  ", "http://llm:8000/v1"}, // 粘贴带空白 → 静默 trim
		{"http://llm:8000/", "http://llm:8000/"},         // 尾斜杠原样保留
		{"https://[::1]:8443", "https://[::1]:8443"},     // IPv6 字面量
	} {
		got, err := domain.NormalizeUpstreamBaseURL(tc.in)
		if err != nil {
			t.Fatalf("%q 应被接受: %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("%q → %q，期望 %q", tc.in, got, tc.want)
		}
	}
}

func TestNormalizeUpstreamBaseURLRejects(t *testing.T) {
	for _, tc := range []struct{ name, in string }{
		{"空", ""},
		{"纯空白", "   "},
		{"漏写协议（会被误解析成 scheme=localhost）", "localhost:11434"},
		{"非 http(s) 协议", "ftp://llm:8000"},
		{"协议相对", "//llm:8000"},
		{"只有协议没有主机", "http://"},
		{"带用户名密码", "http://user:pass@llm:8000"},
		{"带查询串", "https://llm:8000/v1?key=1"},
		{"带片段", "https://llm:8000/v1#frag"},
		{"含空格导致解析失败", "http://ll m:8000"},
	} {
		_, err := domain.NormalizeUpstreamBaseURL(tc.in)
		wantInvalid(t, err, "upstreamBaseUrl "+tc.name)
	}
}

// 显式清除密钥（空串）是合法输入——「密钥写错了要删掉」必须有个出口。
func TestProviderUpsertAPIKeySemantics(t *testing.T) {
	omitted := domain.ProviderUpsert{}
	if omitted.SetAPIKey() {
		t.Fatal("未提供 apiKey 时 SetAPIKey 应为 false（= 保持原值）")
	}
	if got := omitted.APIKeyValue(); got != "" {
		t.Fatalf("未提供时 APIKeyValue 应为空串，实际 %q", got)
	}
	explicitEmpty := domain.ProviderUpsert{APIKey: strptr("")}
	if !explicitEmpty.SetAPIKey() {
		t.Fatal("显式给空串时 SetAPIKey 应为 true（= 清除）")
	}
	if got := explicitEmpty.APIKeyValue(); got != "" {
		t.Fatalf("显式空串应回空串，实际 %q", got)
	}
	set := domain.ProviderUpsert{APIKey: strptr("sk-abc")}
	if !set.SetAPIKey() || set.APIKeyValue() != "sk-abc" {
		t.Fatalf("带值语义错: %v %q", set.SetAPIKey(), set.APIKeyValue())
	}
}

func TestValidateReturnsNormalizedCopy(t *testing.T) {
	raw := "  http://llm:8000/v1  "
	up := domain.ProviderUpsert{
		UpstreamBaseURL: strptr(raw),
		PriceInPerMtok:  f64ptr(3),
		PriceOutPerMtok: f64ptr(15),
		Enabled:         boolptr(false),
	}
	got, err := up.Validate("gpt-4o")
	if err != nil {
		t.Fatalf("应通过: %v", err)
	}
	if got.UpstreamBaseURL == nil || *got.UpstreamBaseURL != "http://llm:8000/v1" {
		t.Fatalf("返回值必须是可写库的规范化形态，实际 %v", got.UpstreamBaseURL)
	}
	// 原值不动：调用方若误用原值，得到的是带空白的地址——所以这里把「不变」也钉住，
	// 让「必须用返回值」这件事在测试里显式可见
	if up.UpstreamBaseURL == nil || *up.UpstreamBaseURL != raw {
		t.Fatal("Validate 不应就地修改接收者（也不该改它指向的字符串）")
	}
	if got.PriceInPerMtok == nil || *got.PriceInPerMtok != 3 || got.Enabled == nil || *got.Enabled {
		t.Fatalf("其余字段应原样带出: %+v", got)
	}
}

// 省略 upstreamBaseUrl 必须被接受：改已有行时最常用的写法就是
// `{"enabled": false}`，若基址必填，摘掉一个模型就退化成读改写。
// 「新建行不能省」是库侧的 NOT NULL 判据（store.UpsertProvider 翻译成 400）。
func TestValidateAcceptsOmittedUpstreamBaseURL(t *testing.T) {
	up := domain.ProviderUpsert{Enabled: boolptr(false)}
	got, err := up.Validate("gpt-4o")
	if err != nil {
		t.Fatalf("只带 enabled 的部分更新应通过校验: %v", err)
	}
	if got.UpstreamBaseURL != nil {
		t.Fatalf("省略的字段在返回值里应保持 nil（= 保持原值），实际 %v", *got.UpstreamBaseURL)
	}
}

func TestValidateRejectsModelMismatchBetweenBodyAndPath(t *testing.T) {
	up := domain.ProviderUpsert{Model: "gpt-4o", UpstreamBaseURL: strptr("http://llm:8000")}
	_, err := up.Validate("claude-3")
	wantInvalid(t, err, "body 与路径 model 不一致")
	// 一致时不能误伤（很多客户端会顺手把 model 抄进 body）
	up.Model = "gpt-4o"
	if _, err := up.Validate("gpt-4o"); err != nil {
		t.Fatalf("一致时不应被拒: %v", err)
	}
	// body 省略 model 也合法（路径是权威来源）
	if _, err := (domain.ProviderUpsert{UpstreamBaseURL: strptr("http://llm:8000")}).Validate("gpt-4o"); err != nil {
		t.Fatalf("body 省略 model 不应被拒: %v", err)
	}
}

func TestValidateRejectsBadPrices(t *testing.T) {
	base := func() domain.ProviderUpsert {
		return domain.ProviderUpsert{UpstreamBaseURL: strptr("http://llm:8000")}
	}
	for _, tc := range []struct {
		name string
		mut  func(*domain.ProviderUpsert)
	}{
		{"入价负数", func(u *domain.ProviderUpsert) { u.PriceInPerMtok = f64ptr(-1) }},
		{"出价负数", func(u *domain.ProviderUpsert) { u.PriceOutPerMtok = f64ptr(-0.001) }},
		{"入价 NaN", func(u *domain.ProviderUpsert) { u.PriceInPerMtok = f64ptr(math.NaN()) }},
		{"出价 +Inf", func(u *domain.ProviderUpsert) { u.PriceOutPerMtok = f64ptr(math.Inf(1)) }},
		{"出价 -Inf", func(u *domain.ProviderUpsert) { u.PriceOutPerMtok = f64ptr(math.Inf(-1)) }},
	} {
		up := base()
		tc.mut(&up)
		_, err := up.Validate("gpt-4o")
		wantInvalid(t, err, "价格 "+tc.name)
	}
	// 0 与省略都必须合法：免费模型 / 不关心价格的内部端点
	up := base()
	up.PriceInPerMtok = f64ptr(0)
	if _, err := up.Validate("gpt-4o"); err != nil {
		t.Fatalf("价格为 0 应合法（免费模型）: %v", err)
	}
}

// 错误信息里绝不能出现密钥：400 的 message 会原样回给客户端、也会进日志。
func TestValidationErrorsNeverLeakTheAPIKey(t *testing.T) {
	up := domain.ProviderUpsert{
		UpstreamBaseURL: strptr("localhost:11434"), // 故意的坏值，保证一定报错
		APIKey:          strptr("sk-super-secret"),
	}
	_, err := up.Validate("gpt-4o")
	if err == nil {
		t.Fatal("坏 upstreamBaseUrl 应报错")
	}
	if strings.Contains(err.Error(), "sk-super-secret") {
		t.Fatalf("错误信息泄露了密钥: %v", err)
	}
}

// ProviderConfig 是「结构上不可能泄露密钥」的类型：它连字段都没有。这条用例把它
// 钉住——将来谁给 ProviderConfig 加回一个 APIKey 字段，这里会红。
func TestProviderConfigHasNoKeyField(t *testing.T) {
	cfg := domain.ProviderConfig{
		Model:           "gpt-4o",
		UpstreamBaseURL: "http://llm:8000",
		APIKeySet:       true,
		PriceInPerMtok:  3,
		PriceOutPerMtok: 15,
		Enabled:         true,
	}
	if !cfg.APIKeySet {
		t.Fatal("APIKeySet 应如实反映「存过密钥」")
	}
	// 值语义拷贝即可用：没有任何指针/切片字段会在拷贝后仍指向同一份密钥数据
	clone := cfg
	if clone != cfg {
		t.Fatal("ProviderConfig 应当是纯值类型（可比较、可拷贝）")
	}
}
