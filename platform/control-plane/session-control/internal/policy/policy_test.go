package policy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func req() Request {
	return Request{
		Command:       "abort",
		SessionRef:    "sess-1",
		CorrelationID: "corr-1",
		Reason:        "runaway tool loop",
		Principal: Principal{
			Realm: "dev", Role: "operator", Subject: "u-7",
			SessionOwners: []string{"u-7", "u-9"},
		},
	}
}

// TestUnconfiguredIsUnavailableNotDenied 是本包存在的理由：未配置 OPA 时必须是
// 「拿不到判定」（503 policy_unavailable），**不是**「权限不足」（403 policy_denied）。
//
// 合成一个 403 的后果很具体：OPA 挂掉会表现成「全公司突然都没有控制权限」，
// 而运维会去查权限配置——真正的故障点在别处，且没有任何线索指向它。
func TestUnconfiguredIsUnavailableNotDenied(t *testing.T) {
	_, err := New("", "").Authorize(context.Background(), req())
	if err == nil {
		t.Fatal("未配置 OPA 时必须报错，绝不能返回一个可用的判定")
	}
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("错误必须可被 errors.Is(., ErrUnavailable) 识别，实际 %v", err)
	}
	// 错误里必须点名变量：运维看到日志要能直接知道该配哪个。
	if !strings.Contains(err.Error(), "LUMO_OPA_URL") {
		t.Fatalf("错误文案应点名 LUMO_OPA_URL，实际 %q", err.Error())
	}
}

// TestUnconfiguredRefusesEveryCommand 把「未配置 = 全拒」钉成覆盖全部指令的性质。
//
// 单测一条 abort 是不够的：有人可能给某条指令（比如只读的 replay）加一条
// 「OPA 没配也放行」的豁免。那看起来无害，但它把 fail-closed 撕开一个口子，
// 而这个口子会随着时间被复制到别的指令上。
func TestUnconfiguredRefusesEveryCommand(t *testing.T) {
	commands := []string{"pause", "resume", "stop", "abort", "approve", "reject", "replay", "degrade"}
	authorizer := New("", "")
	for _, command := range commands {
		r := req()
		r.Command = command
		if _, err := authorizer.Authorize(context.Background(), r); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("指令 %s 在未配置 OPA 时没有被拒（err=%v）—— fail-closed 被开了口子", command, err)
		}
	}
}

// TestNilAuthorizerDoesNotPanic 零值也要保持 fail-closed：构造失败路径上有人忘了
// 初始化时，症状必须是「拒绝」而不是 panic 把请求打成 500 空响应。
func TestNilAuthorizerDoesNotPanic(t *testing.T) {
	var authorizer *Authorizer
	if _, err := authorizer.Authorize(context.Background(), req()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("nil 授权器必须返回 ErrUnavailable，实际 %v", err)
	}
}

// TestDenialIsNotUnavailable 是本包的另一半：策略判定为不允许时 err 必须为 nil。
//
// 如果这里返回了错误，调用方会把一次**正常**的策略拒绝映射成 503，客户端就会重试——
// 而重试一百次结果都一样。拒绝要表现成拒绝。
func TestDenialIsNotUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{"allow": false, "reason": "role operator 不能在 realm dev 上 abort"},
		})
	}))
	defer srv.Close()

	decision, err := New(srv.URL, "").Authorize(context.Background(), req())
	if err != nil {
		t.Fatalf("策略判定不允许时不应报错（它不是「拿不到判定」），实际 %v", err)
	}
	if decision.Allowed {
		t.Fatal("allow=false 被读成了放行")
	}
	if !strings.Contains(decision.Reason, "realm dev") {
		t.Fatalf("拒绝原因应原样带出来，实际 %q", decision.Reason)
	}
}

// TestAllowIsReturned 正向：放行路径也要有断言，否则「永远拒绝」也能让上面几条通过。
func TestAllowIsReturned(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{"allow": true},
		})
	}))
	defer srv.Close()

	decision, err := New(srv.URL, "").Authorize(context.Background(), req())
	if err != nil {
		t.Fatalf("放行路径不应报错: %v", err)
	}
	if !decision.Allowed {
		t.Fatal("allow=true 被读成了拒绝")
	}
}

// TestEngineFailuresAreAllUnavailable 逐个注入「拿不到判定」的各种形态。
//
// 这张表要覆盖的是**所有**会把「未知」误读成「否」的路径——每一种都曾经在别处
// 变成过一个安静的放行或一个误导性的 403。
func TestEngineFailuresAreAllUnavailable(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		body    string
		timeout time.Duration
	}{
		{name: "HTTP 500", status: 500, body: `internal error`},
		{name: "HTTP 404（策略路径写错）", status: 404, body: `not found`},
		{name: "非 JSON 响应", status: 200, body: `<!doctype html><html>proxy</html>`},
		{name: "缺 result 字段", status: 200, body: `{}`},
		{name: "result 为 null（策略包未加载）", status: 200, body: `{"result": null}`},
		{name: "result 形状非法", status: 200, body: `{"result": {"allow": "yes"}}`},
		{name: "空响应体", status: 200, body: ``},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()

			decision, err := New(srv.URL, "").Authorize(context.Background(), req())
			if !errors.Is(err, ErrUnavailable) {
				t.Fatalf("必须归为 ErrUnavailable，实际 err=%v decision=%+v", err, decision)
			}
			// 同时断言**没有**返回一个判定：调用方若忽略 err 直接看 decision，
			// 也不该看到「放行」。
			if decision.Allowed {
				t.Fatal("失败路径上返回了放行判定")
			}
		})
	}
}

// TestUnreachableEngineIsUnavailable 连不上（端口没人听）也必须归为不可用。
func TestUnreachableEngineIsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // 关掉，制造连接被拒

	_, err := New(url, "").Authorize(context.Background(), req())
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("连接被拒必须归为 ErrUnavailable，实际 %v", err)
	}
}

// TestSlowEngineIsUnavailable 慢引擎不能把控制面一起拖住：超时后必须明确失败。
//
// 这一条的价值不在超时本身，而在「超时之后走的是哪条路」——如果它落进放行分支，
// 那么一个卡住的 OPA 就等于一个全开的授权面。
func TestSlowEngineIsUnavailable(t *testing.T) {
	release := make(chan struct{})
	var called atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		select {
		case <-release:
		case <-r.Context().Done():
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"allow": true}})
	}))
	defer srv.Close()
	defer close(release)

	authorizer := New(srv.URL, "")
	authorizer.client = &http.Client{Timeout: 80 * time.Millisecond}

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	decision, err := authorizer.Authorize(ctx, req())
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("超时必须归为 ErrUnavailable，实际 err=%v decision=%+v", err, decision)
	}
	if decision.Allowed {
		t.Fatal("超时路径上返回了放行判定")
	}
	if !called.Load() {
		t.Fatal("请求根本没发出去（测的不是超时路径）")
	}
}

// TestDefaultPathIsServiceSpecific 默认策略路径必须带服务名。
//
// 与连接器网关共用默认路径（lumo/egress）时，忘了配路径的实例会去查一套为出口流量写的
// 策略——而那套策略对「command/sessionRef」这些字段一无所知，很可能返回 allow。
func TestDefaultPathIsServiceSpecific(t *testing.T) {
	var got atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.Store(r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"allow": true}})
	}))
	defer srv.Close()

	if _, err := New(srv.URL, "").Authorize(context.Background(), req()); err != nil {
		t.Fatalf("报错: %v", err)
	}
	path, _ := got.Load().(string)
	if path != "/v1/data/lumo/session_control" {
		t.Fatalf("默认策略路径应为 /v1/data/lumo/session_control，实际 %q", path)
	}

	// 自定义路径要生效（部署侧可能按团队约定改名）。
	if _, err := New(srv.URL, "/custom/ctl/").Authorize(context.Background(), req()); err != nil {
		t.Fatalf("报错: %v", err)
	}
	path, _ = got.Load().(string)
	if path != "/v1/data/custom/ctl" {
		t.Fatalf("自定义路径应被规整为 /v1/data/custom/ctl，实际 %q", path)
	}
}

// stripRegoComments 去掉 rego 的行注释（`#` 到行尾），但不碰字符串里的 `#`。
//
// rego 只有行注释这一种注释形式，所以按行处理就够；用引号状态机而不是「切第一个 #」
// 是为了不误伤 `"a#b"` 这种字面量（本策略现在没有，但抽取器不该假设它永远没有）。
func stripRegoComments(text string) string {
	var b strings.Builder
	for _, line := range strings.Split(text, "\n") {
		inString := false
		cut := len(line)
		for i := 0; i < len(line); i++ {
			switch line[i] {
			case '"':
				inString = !inString
			case '#':
				if !inString {
					cut = i
				}
			}
			if cut != len(line) {
				break
			}
		}
		b.WriteString(line[:cut])
		b.WriteString("\n")
	}
	return b.String()
}

func sortedKeys(keys map[string]bool) []string {
	out := make([]string, 0, len(keys))
	for k := range keys {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// deployedPolicyPath 是部署侧真正被加载的策略文件（compose.cluster.yml 把
// platform/deploy/policies 挂进 OPA 并 `--server /policies`）。本包与它之间是
// **跨目录**的一致性，没有任何编译器会检查。
const deployedPolicyPath = "../../../../deploy/policies/session-control.rego"

var (
	regoPackageRe = regexp.MustCompile(`(?m)^\s*package\s+([A-Za-z_][\w.]*)`)
	regoInputRe   = regexp.MustCompile(`input\.([A-Za-z_][A-Za-z0-9_]*)`)
)

// TestInputCoversKeysReadByDeployedPolicy 是这一轮真正值钱的一条：它把「我们发出去的
// input」与「部署侧策略读的键」钉在一起。
//
// 背景（一次真实的自伤）：Go 侧原先按嵌套形状发送 `actor: {realm, role, subject}`，
// 而部署的 rego 读的是平铺的 `input.realm` / `input.role`。两边各自都自洽，Go 侧的单测
// 也只断言自己发出去的形状，于是「input.realm 恒为 undefined」这件事**没有任何测试
// 会看见**——它只在真部署上表现成「每一条控制指令都被拒」，而拒绝的理由还会显示成
// 权限不足，把人引到权限配置上去。所以这里的期望值不从 Go 结构体反推，而是**从 rego
// 原文里抽键**：策略读什么，我们就必须发什么。
func TestInputCoversKeysReadByDeployedPolicy(t *testing.T) {
	raw, err := os.ReadFile(deployedPolicyPath)
	if err != nil {
		t.Fatalf("读不到被部署的策略文件 %s: %v（路径变了就要同步改这里，否则本用例会静默变成「没检查」）",
			deployedPolicyPath, err)
	}
	text := string(raw)

	// 只扫**代码**行：注释里出现 `input.<键名>` 是说明文字而不是引用。第一版没剥注释，
	// 结果被本文件自己的注释抓了个正着（注释里举例用的键名被当成真的引用了）——
	// 门禁误报还只是烦，但反过来「注释里的键名让门禁看不见真的引用」会让它静默失效。
	code := stripRegoComments(text)
	matches := regoInputRe.FindAllStringSubmatch(code, -1)
	keys := map[string]bool{}
	for _, m := range matches {
		keys[m[1]] = true
	}
	// 计数守卫：抽取器一旦失效（正则改坏、文件被换成别的东西），它就退化成「没有发现
	// 缺失」——而「没发现」与「真的都对」在输出上长得一样。下面这几个键是 allow 规则
	// 的判据，少任何一个都意味着放行条件被削弱，属于必须显式改这份清单的改动。
	for _, required := range []string{"command", "sessionRef", "realm", "role", "actor"} {
		if !keys[required] {
			t.Fatalf("没有从 rego 代码里抽到 input.%s —— 抽取失效，或者授权判据被删了一项"+
				"（两者都必须停下来看一眼）。抽到的是 %v", required, sortedKeys(keys))
		}
	}

	// 请求里的可选字段全部填满，确保「没填所以没展平」不会被误判成「形状不对」。
	in := req().Input()
	missing := []string{}
	for key := range keys {
		if _, ok := in[key]; !ok {
			missing = append(missing, key)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("策略读了 input.%s，而 Request.Input() 没有产出这些键——"+
			"部署后这些规则会恒不匹配（症状是「所有人都没有控制权限」）。实际产出：%v",
			strings.Join(missing, ", input."), in)
	}

	// 反方向也要看一眼：Input() 产出的键里，除了策略会读的，其余必须是「有意的载具」
	// （§8.4.2 事件载荷的一部分，供策略作者日后使用）。**刻意不做成「多一个键就红」**：
	// 那会让每次往载荷里加信息都要改测试，而人一旦开始无脑改测试，门禁就失去意义。
	// 这里只要求它们落在已登记的名单内，新增载具需要显式登记。
	carriers := map[string]bool{"reason": true, "correlationId": true, "sessionOwners": true}
	for key := range in {
		if keys[key] || carriers[key] {
			continue
		}
		t.Fatalf("input 里的 %q 既不被策略读取、也没登记为载荷载具——"+
			"要么是拼错了键名（策略读不到 = 规则恒不匹配），要么该把它登记进 carriers", key)
	}

	// 顺手把 package 声明与默认策略路径也钉住：两者不一致时 OPA 会查到一个不存在的
	// 文档，而 policy.go 把「result 缺失」归为 ErrUnavailable——表现为「OPA 明明起着
	// 却总是不可用」，同样会把排查引偏。
	pkg := regoPackageRe.FindStringSubmatch(text)
	if pkg == nil {
		t.Fatal("rego 里没有 package 声明（抽不到就无从核对默认路径）")
	}
	wantPath := strings.ReplaceAll(pkg[1], ".", "/")
	if got := New("http://opa.invalid", "").path; got != wantPath {
		t.Fatalf("默认策略路径 %q 与 rego 的 package %q（应为 %q）不一致", got, pkg[1], wantPath)
	}
}
