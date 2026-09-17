package waf

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// 用一个会记录是否被调用的下游，判断 WAF 是否放行。
func wrap(rules Rules, allow *bool) http.Handler {
	*allow = false
	return Middleware(rules)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		*allow = true
	}))
}

func TestWAF_OK(t *testing.T) {
	var allowed bool
	srv := httptest.NewServer(wrap(DefaultRules(), &allowed))
	defer srv.Close()

	for _, path := range []string{"/api/foo", "/a/b?x=1&y=hello"} {
		allowed = false
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("请求 %s 失败: %v", path, err)
		}
		resp.Body.Close()
		if !allowed {
			t.Errorf("合法路径 %s 被 WAF 误拦", path)
		}
	}
}

func TestWAF_Traversal(t *testing.T) {
	var allowed bool
	srv := httptest.NewServer(wrap(DefaultRules(), &allowed))
	defer srv.Close()

	cases := []string{"/../etc/passwd", "/a/..%2f..%2fsecret", "/a/b/../c"}
	for _, path := range cases {
		allowed = false
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("请求 %s 失败: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("路径穿越 %q 应被拦为 400, 得到 %d", path, resp.StatusCode)
		}
		if allowed {
			t.Errorf("路径穿越 %q 仍被放行到下游", path)
		}
	}
}

func TestWAF_LengthLimits(t *testing.T) {
	rules := Rules{MaxPathLen: 8, MaxQueryLen: 10}
	var allowed bool
	srv := httptest.NewServer(wrap(rules, &allowed))
	defer srv.Close()

	// 路径超长。
	resp, _ := http.Get(srv.URL + "/aaaaaaaaaaaa")
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("超长路径应 400, 得到 %d", resp.StatusCode)
	}
	// 查询超长。
	resp2, _ := http.Get(srv.URL + "/x?q=aaaaaaaaaaaaaaaaaa")
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Errorf("超长查询应 400, 得到 %d", resp2.StatusCode)
	}
	// 正常长度放行。
	resp3, _ := http.Get(srv.URL + "/ok?q=1")
	resp3.Body.Close()
	if !allowed {
		t.Errorf("正常长度请求不应被拦")
	}
}

func TestWAF_ControlBytes(t *testing.T) {
	// 控制字符（含 NUL 0x00、DEL 0x7F、以及 0x1F 段）都应在检测范围内；
	// 它们无法经正常 HTTP 传输，故直接测 hasControlByte 这个判定核心。
	cases := map[string]bool{
		"normal-path":   false,
		"with\ttab":     false, // 水平制表符属于允许的空白，不算控制字符
		"with\nnewline": false, // 换行同样放行
		"has\x00nul":    true,
		"has\x7fdel":    true,
		"has\x1fctrl":   true,
	}
	for in, want := range cases {
		if got := hasControlByte(in); got != want {
			t.Errorf("hasControlByte(%q)=%v, want %v", in, got, want)
		}
	}
}
