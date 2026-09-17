package gate

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/ratelimit"
)

type fakeLimiter struct {
	verdict ratelimit.Verdict
	err     error
	calls   int
}

func (f *fakeLimiter) Allow(context.Context, string, int, int) (ratelimit.Verdict, error) {
	f.calls++
	return f.verdict, f.err
}

func backend() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	})
}

func TestRateLimit_Pass(t *testing.T) {
	// limiter 为 nil（未配 Redis）→ 放行。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		RateLimit(nil, RateLimitOpts{RPM: 100, KeyFor: func(*http.Request) string { return "k" }})(backend()).ServeHTTP(w, r)
	}))
	defer srv.Close()
	resp, _ := http.Get(srv.URL)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("nil limiter 应放行, 得到 %d", resp.StatusCode)
	}

	// RPM=0 → 不限流。
	f := &fakeLimiter{verdict: ratelimit.Verdict{Allowed: true}}
	srv2 := httptest.NewServer(RateLimit(f, RateLimitOpts{RPM: 0, KeyFor: func(*http.Request) string { return "k" }})(backend()))
	defer srv2.Close()
	http.Get(srv2.URL)
	if f.calls != 0 {
		t.Fatalf("RPM=0 不应调用限流器, calls=%d", f.calls)
	}
}

func TestRateLimit_Denied(t *testing.T) {
	f := &fakeLimiter{verdict: ratelimit.Verdict{Allowed: false}, err: nil}
	srv := httptest.NewServer(RateLimit(f, RateLimitOpts{RPM: 100, KeyFor: func(*http.Request) string { return "k" }})(backend()))
	defer srv.Close()
	resp, _ := http.Get(srv.URL)
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("应 429, 得到 %d", resp.StatusCode)
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Fatalf("429 应带 Retry-After")
	}
}

// 限流器不可用 + fail-closed（默认）→ 503，不静默放行。
func TestRateLimit_UnavailableFailClosed(t *testing.T) {
	f := &fakeLimiter{err: context.DeadlineExceeded}
	srv := httptest.NewServer(RateLimit(f, RateLimitOpts{RPM: 100, FailOpen: false, KeyFor: func(*http.Request) string { return "k" }})(backend()))
	defer srv.Close()
	resp, _ := http.Get(srv.URL)
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("fail-closed 应 503, 得到 %d", resp.StatusCode)
	}
}

// 限流器不可用 + fail-open → 放行（但要被听见：这里只验证放行，日志由 throttle 单人测试）。
func TestRateLimit_UnavailableFailOpen(t *testing.T) {
	f := &fakeLimiter{err: context.DeadlineExceeded}
	srv := httptest.NewServer(RateLimit(f, RateLimitOpts{RPM: 100, FailOpen: true, KeyFor: func(*http.Request) string { return "k" }})(backend()))
	defer srv.Close()
	resp, _ := http.Get(srv.URL)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fail-open 应放行(200), 得到 %d", resp.StatusCode)
	}
}

func TestMaxBodyBytes(t *testing.T) {
	srv := httptest.NewServer(MaxBodyBytes(10)(backend()))
	defer srv.Close()

	// 已知 Content-Length 超长 → 413。
	big := make([]byte, 25)
	req, _ := http.NewRequest(http.MethodPost, srv.URL, bytes.NewReader(big))
	req.ContentLength = int64(len(big))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("超长 body 应 413, 得到 %d", resp.StatusCode)
	}

	// 合法大小放行。
	small := []byte("short")
	req2, _ := http.NewRequest(http.MethodPost, srv.URL, bytes.NewReader(small))
	req2.ContentLength = int64(len(small))
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("合法 body 应 200, 得到 %d", resp2.StatusCode)
	}
}

func TestConnLimit(t *testing.T) {
	// 确定性验证「超额即拒」：max=1 时，3 个并发请求下第一个占用槽位期间，其余
	// 到达网关的请求必然看到 current>max 被拒。关键是让三个请求**先并发到达网关**，
	// 再放行占用槽位的那一路——否则后到的会在槽位释放后才到、误判为放行。
	released := make(chan struct{})
	cl := NewConnLimit(1)
	srv := httptest.NewServer(cl.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-released // 持住连接直到测试放行
		_, _ = io.WriteString(w, "ok")
	})))
	defer srv.Close()

	const n = 3
	results := make(chan int, n)
	for i := 0; i < n; i++ {
		go func() {
			resp, err := http.Get(srv.URL)
			if err != nil {
				results <- 0
				return
			}
			defer resp.Body.Close()
			_, _ = io.Copy(io.Discard, resp.Body)
			results <- resp.StatusCode
		}()
	}
	// 等待足够长，确保三个请求都已到达网关的限流闸门（实际在毫秒级），
	// 此时占用槽位的那一路仍持住连接，其余两路必被拒。
	time.Sleep(200 * time.Millisecond)
	close(released)

	ok, overload := 0, 0
	timeout := time.After(5 * time.Second)
	for i := 0; i < n; i++ {
		select {
		case st := <-results:
			switch st {
			case http.StatusOK:
				ok++
			case http.StatusServiceUnavailable:
				overload++
			}
		case <-timeout:
			t.Fatalf("收集响应超时：ok=%d overload=%d", ok, overload)
		}
	}
	if ok != 1 || overload != n-1 {
		t.Fatalf("max=1 并发 %d：期望 1 个 200、%d 个 503，实际 ok=%d overload=%d", n, n-1, ok, overload)
	}

	// 充足上限：放行。
	cl2 := NewConnLimit(1000)
	srv2 := httptest.NewServer(cl2.Wrap(backend()))
	defer srv2.Close()
	resp2, err := http.Get(srv2.URL)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("max 充足应 200, 得到 %d", resp2.StatusCode)
	}
}

func TestCORS(t *testing.T) {
	cors := CORS([]string{"https://app.example"}, "")
	srv := httptest.NewServer(cors(backend()))
	defer srv.Close()

	// 允许的来源 → 设头。
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Header.Set("Origin", "https://app.example")
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.Header.Get("Access-Control-Allow-Origin") != "https://app.example" {
		t.Fatalf("应回显允许的 Origin")
	}

	// 不允许的来源 → 不设头。
	req2, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req2.Header.Set("Origin", "https://evil.example")
	resp2, _ := http.DefaultClient.Do(req2)
	resp2.Body.Close()
	if resp2.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("不允许的来源不应设 CORS 头")
	}

	// 预检 → 204。
	req3, _ := http.NewRequest(http.MethodOptions, srv.URL, nil)
	req3.Header.Set("Origin", "https://app.example")
	resp3, _ := http.DefaultClient.Do(req3)
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusNoContent {
		t.Fatalf("预检应 204, 得到 %d", resp3.StatusCode)
	}
}

// throttledLog 的节流：同一消息在一秒内只记一次。
func TestThrottledLog(t *testing.T) {
	rlThrottle.mu.Lock()
	rlThrottle.msg = ""
	rlThrottle.last.Store(0)
	rlThrottle.mu.Unlock()

	var buf strings.Builder
	log := slog.New(slog.NewTextHandler(&buf, nil))
	throttledLog(log, "same", context.DeadlineExceeded)
	throttledLog(log, "same", context.DeadlineExceeded) // 同秒同消息应被节流
	if strings.Count(buf.String(), "same") != 1 {
		t.Fatalf("同秒同消息应只记一次, 实际:\n%s", buf.String())
	}
	// 不同消息立即记。
	throttledLog(log, "other", context.DeadlineExceeded)
	if strings.Count(buf.String(), "other") != 1 {
		t.Fatalf("不同消息应立即记, 实际:\n%s", buf.String())
	}
	_ = time.Second
}
