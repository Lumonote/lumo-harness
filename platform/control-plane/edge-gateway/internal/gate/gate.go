// Package gate 实现边缘网关的「横切治理」（§12.1 四件事之三）：鉴权之外的
// 网关级治理——限流、请求体大小、连接数、CORS。每一道都是「门」该做的事，
// 不对业务语义负责。traceparent / X-Lumo-Correlation-Id 的传播由
// observability.Middleware 统一负责，这里不重复实现。
package gate

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lumo-harness/platform/ratelimit"
)

// RateLimiter 是限流判定接口，与共享库 ratelimit.Limiter 的签名一致，便于用
// 真实 Redis 令牌桶注入、用假实现做测试。
type RateLimiter interface {
	Allow(ctx context.Context, key string, requestsPerMinute, burst int) (ratelimit.Verdict, error)
}

// RateLimitOpts 单条限流中间件的配置。
type RateLimitOpts struct {
	// RPM 每分钟每客户端配额（0 = 不限流）。
	RPM int
	// Burst 突发容量；<=0 时由令牌桶库按 RPM 兜底。
	Burst int
	// KeyFor 从请求派生限流键（例如「路由 id + 客户端 IP」）。
	KeyFor func(r *http.Request) string
	// FailOpen 限流器本身不可用（Redis 抖动）时是否放行。
	// false（默认）= fail-closed：宁可拒绝，也不让一个抖动变成全站瘫痪或静默放行。
	FailOpen bool
	// Logger 用于「大声打日志」——限流器挂了必须被听见。
	Logger *slog.Logger
}

// RateLimit 返回一个限流中间件。
//
// 行为分三层：
//  1. limiter 为 nil（未配置 Redis）→ 直接放行，但调用方应在启动时已大声说明
//     限流处于关闭态；
//  2. RPM<=0 → 不限流；
//  3. Allow 返回错误（Redis 挂了）：FailOpen=true 放行+告警，FailOpen=false
//     返回 503（fail-closed）。决策点集中在此，避免各处各写一套。
func RateLimit(limiter RateLimiter, opts RateLimitOpts) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if limiter == nil || opts.RPM <= 0 {
				next.ServeHTTP(w, r)
				return
			}
			v, err := limiter.Allow(r.Context(), opts.KeyFor(r), opts.RPM, opts.Burst)
			if err != nil {
				// 限流器不可用：这是运维事件，必须被听见。用一个按秒节流的
				// logger 避免 Redis 抖动期间把日志打爆，同时保证至少每秒一次。
				throttledLog(opts.Logger, "ratelimit unavailable; fail-open="+itoaB(opts.FailOpen), err)
				if opts.FailOpen {
					next.ServeHTTP(w, r)
					return
				}
				http.Error(w, "rate limiter unavailable", http.StatusServiceUnavailable)
				return
			}
			if !v.Allowed {
				w.Header().Set("Retry-After", retryAfter(v.RetryAfter))
				http.Error(w, "too many requests", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// MaxBodyBytes 限制请求体大小。先看 Content-Length（已知即 413 拒绝，确定性
// 最强），再对 body 套 MaxBytesReader 兜底流式请求（无 Content-Length 时）。
func MaxBodyBytes(max int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if max > 0 && r.ContentLength > max {
				http.Error(w, "request entity too large", http.StatusRequestEntityTooLarge)
				return
			}
			if max > 0 {
				r.Body = http.MaxBytesReader(w, r.Body, max)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ConnLimit 全局在途连接数上限。超过即 503，保护网关不被连接耗尽拖垮。
type ConnLimit struct {
	max     int64
	current atomic.Int64
}

// NewConnLimit 创建连接数限制器，max<=0 表示不限制。
func NewConnLimit(max int64) *ConnLimit { return &ConnLimit{max: max} }

func (c *ConnLimit) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c.max <= 0 {
			next.ServeHTTP(w, r)
			return
		}
		// Add 返回加之后的值；若超过上限，本请求不计入（回退后再判）。
		n := c.current.Add(1)
		if n > c.max {
			c.current.Add(-1)
			http.Error(w, "service overloaded", http.StatusServiceUnavailable)
			return
		}
		defer c.current.Add(-1)
		next.ServeHTTP(w, r)
	})
}

// CORS 在边缘网关层做跨域治理。注意：observability.Middleware 也会基于
// LUMO_CORS_ORIGIN 设 CORS 头；部署 edge-gateway 时**不应**再设该变量，否则
// 两套头会重复设置。这里才是边缘 CORS 的权威来源。
func CORS(allowedOrigins []string, methods string) func(http.Handler) http.Handler {
	originSet := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		originSet[strings.TrimSpace(o)] = true
	}
	if methods == "" {
		methods = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				if originSet["*"] || originSet[origin] {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
					w.Header().Set("Access-Control-Allow-Methods", methods)
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Lumo-Correlation-Id, traceparent")
				}
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// throttle：按秒节流日志，避免限流器抖动期间日志被同一条消息刷爆。
type throttle struct {
	mu   sync.Mutex
	last atomic.Int64 // 上次记录的秒级时间戳
	msg  string
}

var rlThrottle = &throttle{}

func throttledLog(log *slog.Logger, msg string, err error) {
	now := time.Now().Unix()
	rlThrottle.mu.Lock()
	changed := rlThrottle.msg != msg || now-rlThrottle.last.Load() >= 1
	if changed {
		rlThrottle.msg = msg
		rlThrottle.last.Store(now)
	}
	rlThrottle.mu.Unlock()
	if log == nil {
		log = slog.Default()
	}
	if changed {
		log.Error("限流器不可用", "detail", msg, "err", err)
	}
}

func retryAfter(d time.Duration) string {
	if d <= 0 {
		return "1"
	}
	s := int64(d.Seconds())
	if s < 1 {
		s = 1
	}
	return itoa(int(s))
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

func itoaB(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// ClientIP 取客户端 IP（与 proxy 同口径：X-Forwarded-For 第一段或 RemoteAddr）。
// 限流键需要稳定的客户端标识，避免同一 NAT 后多用户共享一个桶被互相挤。
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if comma := strings.IndexByte(xff, ','); comma >= 0 {
			return strings.TrimSpace(xff[:comma])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
