package routing

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 校验：合法表通过。
func TestValidate_OK(t *testing.T) {
	rt := &RouteTable{
		Whitelist: []string{"svc-a:8080", "svc-b:8080"},
		Routes: []Route{
			{Prefix: "/api/a", Upstream: "http://svc-a:8080"},
			{Prefix: "/api/b", Upstream: "http://svc-b:8080", Canary: &Canary{Upstream: "http://svc-b:8080", Weight: 30}},
		},
	}
	if err := rt.Validate(); err != nil {
		t.Fatalf("期望合法表通过, 实际: %v", err)
	}
}

// 校验：空路由表是配置错误，不是「什么都不代理」的合法取舍。
//
// 0 条路由与「一次坏合并把 routes 删空」在运行时表现完全一致（全站 404），
// 而后者必须让人在部署时就发现。注意这个用例断言的是**报错且点名是空表**，
// 不是「随便报了个错」——把错误换成「白名单为空」之类会让缺陷换一种形态继续存在。
func TestValidate_EmptyRoutesRejected(t *testing.T) {
	cases := []struct {
		name string
		rt   *RouteTable
	}{
		{"routes 字段缺失", &RouteTable{Whitelist: []string{"svc:8080"}}},
		{"routes 显式为 null 解析出的空切片", &RouteTable{Whitelist: []string{"svc:8080"}, Routes: []Route{}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.rt.Validate()
			if err == nil {
				t.Fatal("空路由表必须被拒绝")
			}
			if !strings.Contains(err.Error(), "没有任何路由") {
				t.Fatalf("错误应点明空表，实际: %v", err)
			}
		})
	}
}

// 校验：未知字段被拒绝（DisallowUnknownFields 递归）。
func TestValidate_UnknownField(t *testing.T) {
	doc := `{"whitelist":["svc:8080"],"routes":[{"prefix":"/x","upstream":"http://svc:8080","bogus":1}]}`
	if _, err := Parse([]byte(doc)); err == nil {
		t.Fatal("期望未知字段报错")
	}
}

// 校验：重复路由（同 prefix 同 host）。
func TestValidate_Duplicate(t *testing.T) {
	rt := &RouteTable{
		Whitelist: []string{"svc:8080"},
		Routes: []Route{
			{Prefix: "/x", Upstream: "http://svc:8080"},
			{Prefix: "/x", Upstream: "http://svc:8080"},
		},
	}
	if err := rt.Validate(); err == nil {
		t.Fatal("期望重复路由报错")
	}
}

// 校验：前缀重叠（一条是另一条的前缀）。
func TestValidate_Overlap(t *testing.T) {
	rt := &RouteTable{
		Whitelist: []string{"svc:8080"},
		Routes: []Route{
			{Prefix: "/api", Upstream: "http://svc:8080"},
			{Prefix: "/api/foo", Upstream: "http://svc:8080"},
		},
	}
	if err := rt.Validate(); err == nil {
		t.Fatal("期望重叠路由报错")
	}
}

// 校验：上游主机不在白名单 → 拒绝。
func TestValidate_UpstreamNotWhitelisted(t *testing.T) {
	rt := &RouteTable{
		Whitelist: []string{"svc-a:8080"},
		Routes:    []Route{{Prefix: "/x", Upstream: "http://evil:9999"}},
	}
	if err := rt.Validate(); err == nil {
		t.Fatal("期望未白名单上游报错")
	}
}

// 校验：canary 上游不在白名单 → 拒绝。
func TestValidate_CanaryUpstreamNotWhitelisted(t *testing.T) {
	rt := &RouteTable{
		Whitelist: []string{"svc-a:8080"},
		Routes:    []Route{{Prefix: "/x", Upstream: "http://svc-a:8080", Canary: &Canary{Upstream: "http://evil:9999", Weight: 30}}},
	}
	if err := rt.Validate(); err == nil {
		t.Fatal("期望 canary 未白名单上游报错")
	}
}

// 校验：canary 缺权重 → 拒绝。
func TestValidate_CanaryMissingWeight(t *testing.T) {
	rt := &RouteTable{
		Whitelist: []string{"svc-a:8080", "svc-b:8080"},
		Routes:    []Route{{Prefix: "/x", Upstream: "http://svc-a:8080", Canary: &Canary{Upstream: "http://svc-b:8080"}}},
	}
	if err := rt.Validate(); err == nil {
		t.Fatal("期望 canary 缺权重报错")
	}
}

// 校验：canary 权重越界（0 与 100 都不是分流）→ 拒绝。
func TestValidate_CanaryWeightOutOfRange(t *testing.T) {
	for _, w := range []int{0, 100, 150, -5} {
		rt := &RouteTable{
			Whitelist: []string{"svc-a:8080", "svc-b:8080"},
			Routes:    []Route{{Prefix: "/x", Upstream: "http://svc-a:8080", Canary: &Canary{Upstream: "http://svc-b:8080", Weight: w}}},
		}
		if err := rt.Validate(); err == nil {
			t.Fatalf("权重 %d 期望报错", w)
		}
	}
}

// 校验：prefix 不以 / 开头 → 拒绝。
func TestValidate_BadPrefix(t *testing.T) {
	rt := &RouteTable{
		Whitelist: []string{"svc:8080"},
		Routes:    []Route{{Prefix: "api", Upstream: "http://svc:8080"}},
	}
	if err := rt.Validate(); err == nil {
		t.Fatal("期望非法 prefix 报错")
	}
}

// 匹配：最长前缀优先，Host 约束生效。两条路由 Host 不同（"" 表示任意），故不重叠。
func TestMatch(t *testing.T) {
	c := mustCompile(t, &RouteTable{
		Whitelist: []string{"a:8080", "b:8080"},
		Routes: []Route{
			{Prefix: "/api", Upstream: "http://a:8080"},                       // host 任意
			{Prefix: "/api/deep", Upstream: "http://b:8080", Host: "special"}, // 仅 special
		},
	})
	// 任意 Host 命中宽松路由 /api（最长匹配里 /api/deep 因 host 不符不算）。
	got := c.Match("/api/deep/x", "any")
	if got == nil || got.Host != "" || got.Prefix != "/api" {
		t.Fatalf("期望命中 /api 宽松路由, 得到 %+v", got)
	}
	// special Host 命中专属 /api/deep（最长且 host 匹配）。
	got = c.Match("/api/deep/x", "special")
	if got == nil || got.Host != "special" {
		t.Fatalf("期望命中 special 路由, 得到 %+v", got)
	}
	// 未命中。
	if c.Match("/other", "any") != nil {
		t.Fatal("期望 /other 未命中")
	}
}

// 灰度：header 命中 → 必走 canary（确定性）。
func TestSelectUpstream_HeaderSticky(t *testing.T) {
	cr := mustCompileRoute(t, Route{
		Prefix: "/x", Upstream: "http://primary:8080",
		Canary: &Canary{Header: "X-Canary", HeaderValue: "yes", Upstream: "http://canary:8080", Weight: 1},
	})
	hit := httptest.NewRequest(http.MethodGet, "/x", nil)
	hit.Header.Set("X-Canary", "yes")
	if got := cr.SelectUpstream(hit); got.Host != "canary:8080" {
		t.Fatalf("X-Canary 命中应走 canary, 得到 %s", got.Host)
	}
	miss := httptest.NewRequest(http.MethodGet, "/x", nil)
	if got := cr.SelectUpstream(miss); got.Host != "primary:8080" {
		t.Fatalf("无 header 应走 primary, 得到 %s", got.Host)
	}
}

// 灰度：同一 seed 必得同一上游（确定性），且权重分布收敛。
func TestSelectUpstream_WeightDistribution(t *testing.T) {
	const weight = 30
	cr := mustCompileRoute(t, Route{
		Prefix: "/x", Upstream: "http://primary:8080",
		Canary: &Canary{Upstream: "http://canary:8080", Weight: weight},
	})
	// 确定性：固定 seed 重复调用结果一致。
	seedReq := func(seed string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/x", nil)
		r.Header.Set("X-Lumo-Correlation-Id", seed)
		return r
	}
	first := cr.SelectUpstream(seedReq("client-42")).Host
	for i := 0; i < 50; i++ {
		if got := cr.SelectUpstream(seedReq("client-42")).Host; got != first {
			t.Fatalf("相同 seed 选择不一致: 首次 %s 后续 %s", first, got)
		}
	}

	// 分布：1e5 个 seed 下 canary 命中率应接近 weight%。
	const n = 100_000
	var canary int
	for i := 0; i < n; i++ {
		if cr.SelectUpstream(seedReq("client-"+itoa(i))).Host == "canary:8080" {
			canary++
		}
	}
	gotPct := float64(canary) / float64(n) * 100
	if gotPct < float64(weight)-2 || gotPct > float64(weight)+2 {
		t.Fatalf("canary 分布 %.2f%% 偏离期望 %d%%（容差 2 个百分点）", gotPct, weight)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

func mustCompile(t *testing.T, rt *RouteTable) *Compiled {
	t.Helper()
	if err := rt.Validate(); err != nil {
		t.Fatalf("校验失败: %v", err)
	}
	c, err := rt.Compile()
	if err != nil {
		t.Fatalf("编译失败: %v", err)
	}
	return c
}

func mustCompileRoute(t *testing.T, r Route) *CompiledRoute {
	t.Helper()
	c := mustCompile(t, &RouteTable{Whitelist: []string{"primary:8080", "canary:8080"}, Routes: []Route{r}})
	return c.Routes[0]
}
