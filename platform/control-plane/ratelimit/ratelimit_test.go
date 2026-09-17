package ratelimit

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// scriptErr 是「服务端返回的 Redis 错误」这类错误。
//
// 必须实现 redis.Error（多一个 RedisError() 方法）而不只是一个普通 error：go-redis 判定
// NOSCRIPT 用的是 `HasErrorPrefix`，它先做 `errors.As(err, &redis.Error)`，普通 error
// 会直接返回 false。于是「脚本没缓存 → 回落 EVAL」这条路径在桩里根本走不到，测试会假绿。
type scriptErr string

func (e scriptErr) Error() string { return string(e) }
func (e scriptErr) RedisError()   {}

// fakeScripter 桩掉 redis.Scripter，记录调用序列并按配置返回结果。
//
// 记录 shaCalls / evalCalls 而不是只看结果：`Script.Run` 是「先 EVALSHA，遇 NOSCRIPT 才
// 回落 EVAL」的乐观策略，而「结果正确」无法区分「回落对了」和「每次都在回落」——
// 后者在 Redis 正常时每请求多一次往返，是纯性能事故，只能靠次数断言钉住。
type fakeScripter struct {
	shaVal  any
	shaErr  error
	evalVal any
	evalErr error

	shaCalls  int
	evalCalls int
	lastKeys  []string
	lastArgs  []any
}

func (f *fakeScripter) Eval(_ context.Context, _ string, keys []string, args ...any) *redis.Cmd {
	f.evalCalls++
	f.lastKeys, f.lastArgs = keys, args
	return redis.NewCmdResult(f.evalVal, f.evalErr)
}

func (f *fakeScripter) EvalSha(_ context.Context, _ string, keys []string, args ...any) *redis.Cmd {
	f.shaCalls++
	f.lastKeys, f.lastArgs = keys, args
	return redis.NewCmdResult(f.shaVal, f.shaErr)
}

func (f *fakeScripter) EvalRO(_ context.Context, _ string, _ []string, _ ...any) *redis.Cmd {
	return redis.NewCmdResult(nil, nil)
}

func (f *fakeScripter) EvalShaRO(_ context.Context, _ string, _ []string, _ ...any) *redis.Cmd {
	return redis.NewCmdResult(nil, nil)
}

func (f *fakeScripter) ScriptExists(_ context.Context, _ ...string) *redis.BoolSliceCmd {
	return redis.NewBoolSliceCmd(context.Background())
}

func (f *fakeScripter) ScriptLoad(_ context.Context, _ string) *redis.StringCmd {
	return redis.NewStringCmd(context.Background())
}

// TestAllowPassesArgsToScript 钉住传给 Lua 的每个参数。
//
// 这里最值钱的一条是 burst 回落：`burst <= 0` 时若原样把 0 传下去，Lua 里
// `tokens = burst` 就是 0，于是**任何** cost=1 的请求都被拒（retry 还按 rate 算），
// 症状是全站 429 而 Redis 完全健康。参数只能逐个断言，看返回值看不出来。
func TestAllowPassesArgsToScript(t *testing.T) {
	cases := []struct {
		name            string
		requestsPerMin  int
		burst           int
		wantRate        float64
		wantBurstPassed int
	}{
		{"rpm=60 → rate=1；burst 缺省回落成 rpm", 60, 0, 1, 60},
		{"rpm=120 → rate=2；burst 缺省回落成 rpm", 120, 0, 2, 120},
		{"rpm=30 → rate=0.5；burst 缺省回落成 rpm", 30, 0, 0.5, 30},
		{"显式 burst 原样传，不被 rpm 覆盖", 120, 10, 2, 10},
		{"负数 burst 也回落（不是当成 0 传下去）", 60, -5, 1, 60},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeScripter{shaVal: []any{int64(1), int64(0)}}
			if _, err := New(f).Allow(context.Background(), "k1", tc.requestsPerMin, tc.burst); err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if len(f.lastKeys) != 1 || f.lastKeys[0] != "k1" {
				t.Fatalf("KEYS 必须原样传 key，实际 %v", f.lastKeys)
			}
			if len(f.lastArgs) != 3 {
				t.Fatalf("ARGV 必须是 (rate, burst, cost) 三个，实际 %v", f.lastArgs)
			}
			if got, ok := f.lastArgs[0].(float64); !ok || got != tc.wantRate {
				t.Fatalf("ARGV[1] rate: want %v, got %v(%T)", tc.wantRate, f.lastArgs[0], f.lastArgs[0])
			}
			if got, ok := f.lastArgs[1].(int); !ok || got != tc.wantBurstPassed {
				t.Fatalf("ARGV[2] burst: want %v, got %v(%T)", tc.wantBurstPassed, f.lastArgs[1], f.lastArgs[1])
			}
			if got, ok := f.lastArgs[2].(int); !ok || got != 1 {
				t.Fatalf("ARGV[3] cost 必须恒为 1，实际 %v(%T)", f.lastArgs[2], f.lastArgs[2])
			}
		})
	}
}

// TestAllowUnlimitedShortCircuits 不限流（rpm<=0）必须**不打 Redis**。
//
// 只是「放行」是不够的：若仍然打一次 Redis，那么把 rpm 设成 0 想关掉限流的部署，
// 反而让每个请求都依赖 Redis 可用性——Redis 抖动时这些本该「不受限」的请求会拿到错误，
// 由调用方决定 fail-closed 时就被拒了。关掉限流必须真的关掉这条依赖。
func TestAllowUnlimitedShortCircuits(t *testing.T) {
	cases := []struct {
		name string
		rpm  int
	}{
		{"rpm=0", 0},
		{"rpm<0", -1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 故意让脚本返回错误：若实现偷偷打了一次 Redis，这条用例会报错而不是静默通过。
			f := &fakeScripter{shaErr: scriptErr("ERR 不该被调用")}
			v, err := New(f).Allow(context.Background(), "k", tc.rpm, 10)
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if !v.Allowed {
				t.Fatal("rpm<=0 应放行")
			}
			if f.shaCalls != 0 || f.evalCalls != 0 {
				t.Fatalf("不限流时不应打 Redis，实际 EVALSHA=%d EVAL=%d", f.shaCalls, f.evalCalls)
			}
		})
	}
}

// TestAllowParsesScriptVerdict 覆盖脚本返回值的两种形态。
func TestAllowParsesScriptVerdict(t *testing.T) {
	cases := []struct {
		name        string
		scriptVal   any
		wantAllowed bool
		wantRetry   time.Duration
	}{
		{"放行", []any{int64(1), int64(0)}, true, 0},
		{"拒绝并给出等待时长", []any{int64(0), int64(1500)}, false, 1500 * time.Millisecond},
		// 拒绝且 retry=0 是调用方最容易漏的一档：`Retry-After: 0` 会让客户端立刻重试。
		// 库本身只如实上报，不替调用方编一个值——但这条断言把它变成了明确契约而不是意外。
		{"拒绝但脚本没给等待时长（如实上报 0）", []any{int64(0), int64(0)}, false, 0},
		{"allowed=2（非 1 的整数）按拒绝处理", []any{int64(2), int64(10)}, false, 10 * time.Millisecond},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeScripter{shaVal: tc.scriptVal}
			v, err := New(f).Allow(context.Background(), "k", 60, 5)
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if v.Allowed != tc.wantAllowed || v.RetryAfter != tc.wantRetry {
				t.Fatalf("want {%v %v}, got %+v", tc.wantAllowed, tc.wantRetry, v)
			}
		})
	}
}

// TestAllowScriptErrorIsFailClosed 脚本执行失败必须**向上抛错，且返回零值 Verdict**。
//
// 这是本文件最重要的一条。库作者把「fail-open 还是 fail-closed」的决策留给了调用方
// （注释明说「这里选择向上抛，由调用方决定」），那么库这一侧就必须保证：**忽略 err 的
// 调用方也是 fail-closed**。若失败时返回 `Verdict{Allowed: true}`，任何一处漏检 err 的
// 调用点都会静默变成「永不限流」，而流量一大只会表现为「限流没生效」，排查方向完全错。
func TestAllowScriptErrorIsFailClosed(t *testing.T) {
	t.Run("EVALSHA 的普通错误", func(t *testing.T) {
		f := &fakeScripter{shaErr: scriptErr("ERR 脚本炸了")}
		v, err := New(f).Allow(context.Background(), "k", 60, 5)
		if err == nil {
			t.Fatal("脚本失败必须报错，不能静默放行")
		}
		if !strings.Contains(err.Error(), "令牌桶执行失败") {
			t.Fatalf("错误应点明是令牌桶执行失败以便巡检定位，实际 %q", err.Error())
		}
		if v.Allowed {
			t.Fatal("报错时 Verdict 必须是零值，否则漏检 err 的调用点会变成 fail-open")
		}
	})

	t.Run("连接错误同样向上抛", func(t *testing.T) {
		f := &fakeScripter{shaErr: context.DeadlineExceeded}
		v, err := New(f).Allow(context.Background(), "k", 60, 5)
		if err == nil {
			t.Fatal("连接失败必须报错")
		}
		if v.Allowed {
			t.Fatal("报错时 Verdict 必须是零值")
		}
	})
}

// TestAllowRejectsUnexpectedScriptReturn 脚本返回形状不对时必须报错。
//
// 返回形状变了（比如有人改了 Lua 的 return 语句）时，最危险的两种「宽容」处理是
// 当成空数组或当成放行。都必须变成显式错误。
func TestAllowRejectsUnexpectedScriptReturn(t *testing.T) {
	cases := []struct {
		name      string
		scriptVal any
	}{
		{"返回值不是数组", "ok"},
		{"只有 1 个元素", []any{int64(1)}},
		{"有 3 个元素", []any{int64(1), int64(0), int64(0)}},
		{"nil", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeScripter{shaVal: tc.scriptVal}
			v, err := New(f).Allow(context.Background(), "k", 60, 5)
			if err == nil {
				t.Fatal("非预期返回值必须报错")
			}
			if !strings.Contains(err.Error(), "非预期的脚本返回") {
				t.Fatalf("错误应说明是返回值形状问题，实际 %q", err.Error())
			}
			if v.Allowed {
				t.Fatal("报错时不得放行")
			}
		})
	}
}

// TestAllowFallsBackToEvalOnNOSCRIPT 只在 NOSCRIPT 时回落 EVAL，其他错误不回落。
//
// 两个方向都要钉住：
//   - 该回落不回落 → 首次调用（脚本未缓存）直接失败，服务冷启动即 500；
//   - 不该回落却回落 → Redis 真的故障时每次请求多打一次往返，把一次故障放大成双倍流量。
func TestAllowFallsBackToEvalOnNOSCRIPT(t *testing.T) {
	t.Run("NOSCRIPT 触发回落并采用 EVAL 的结果", func(t *testing.T) {
		f := &fakeScripter{
			shaErr:  scriptErr("NOSCRIPT No matching script. Please use EVAL."),
			evalVal: []any{int64(0), int64(2500)},
		}
		v, err := New(f).Allow(context.Background(), "k", 60, 5)
		if err != nil {
			t.Fatalf("回落路径不应报错: %v", err)
		}
		if f.shaCalls != 1 || f.evalCalls != 1 {
			t.Fatalf("应恰好 EVALSHA 一次 + EVAL 一次，实际 %d/%d", f.shaCalls, f.evalCalls)
		}
		if v.Allowed || v.RetryAfter != 2500*time.Millisecond {
			t.Fatalf("必须采用 EVAL 的结果，实际 %+v", v)
		}
	})

	t.Run("非 NOSCRIPT 错误不得回落", func(t *testing.T) {
		f := &fakeScripter{
			shaErr:  scriptErr("ERR unknown command"),
			evalVal: []any{int64(1), int64(0)},
		}
		if _, err := New(f).Allow(context.Background(), "k", 60, 5); err == nil {
			t.Fatal("非 NOSCRIPT 错误必须向上抛")
		}
		if f.evalCalls != 0 {
			t.Fatalf("非 NOSCRIPT 错误不应回落 EVAL（会放大故障流量），实际 EVAL=%d", f.evalCalls)
		}
	})

	// ERR 前缀是 KVRocks 之类的实现会加的，go-redis 的判定会先剥掉它。桩里复现一遍，
	// 保证「换了 Redis 兼容实现」不会让回落路径悄悄失效。
	t.Run("ERR NOSCRIPT 前缀也会回落", func(t *testing.T) {
		f := &fakeScripter{
			shaErr:  scriptErr("ERR NOSCRIPT No matching script."),
			evalVal: []any{int64(1), int64(0)},
		}
		if _, err := New(f).Allow(context.Background(), "k", 60, 5); err != nil {
			t.Fatalf("不应报错: %v", err)
		}
		if f.evalCalls != 1 {
			t.Fatalf("应回落到 EVAL，实际 EVAL=%d", f.evalCalls)
		}
	})
}
