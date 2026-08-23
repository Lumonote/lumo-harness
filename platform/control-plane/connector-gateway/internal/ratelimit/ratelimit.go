// Package ratelimit Redis 令牌桶（§12.2「与内部网关共享同一限流库」）。
//
// 时钟取自 Redis 的 TIME 而非各网关实例的本地时钟：多实例部署下本地时钟偏移
// 会让同一个桶的补充速率忽快忽慢，配额就不再是配额。
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// 桶状态存 hash（tokens, ts_ms）。整段逻辑在 Lua 内原子完成——
// 读-算-写分三次往返的实现在并发下必然超发。
var bucketScript = redis.NewScript(`
local key   = KEYS[1]
local rate  = tonumber(ARGV[1])   -- tokens per second
local burst = tonumber(ARGV[2])
local cost  = tonumber(ARGV[3])

local t   = redis.call('TIME')
local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end

local delta = math.max(0, now - ts) / 1000.0
tokens = math.min(burst, tokens + (delta * rate))

local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil(((cost - tokens) / rate) * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- 空闲桶自然过期：满桶所需时间 + 1s 余量
redis.call('PEXPIRE', key, math.ceil((burst / rate) * 1000) + 1000)

return {allowed, retry_ms}
`)

// Limiter 令牌桶限流器。
type Limiter struct {
	rdb redis.Scripter
}

func New(rdb redis.Scripter) *Limiter { return &Limiter{rdb: rdb} }

// Verdict 一次限流判定。
type Verdict struct {
	Allowed    bool
	RetryAfter time.Duration
}

// Allow 扣一个令牌。requestsPerMinute<=0 视为不限流（直接放行，不打 Redis）。
func (l *Limiter) Allow(ctx context.Context, key string, requestsPerMinute, burst int) (Verdict, error) {
	if requestsPerMinute <= 0 {
		return Verdict{Allowed: true}, nil
	}
	if burst <= 0 {
		burst = requestsPerMinute
	}
	rate := float64(requestsPerMinute) / 60.0

	res, err := bucketScript.Run(ctx, l.rdb, []string{key}, rate, burst, 1).Result()
	if err != nil {
		// 限流器故障不能变成「全部放行」，也不该变成「全站瘫痪」。
		// 这里选择向上抛，由 Gateway 决定 fail-open/closed —— 决策点集中在一处。
		return Verdict{}, fmt.Errorf("ratelimit: 令牌桶执行失败: %w", err)
	}
	vals, ok := res.([]any)
	if !ok || len(vals) != 2 {
		return Verdict{}, fmt.Errorf("ratelimit: 非预期的脚本返回 %T", res)
	}
	allowed, _ := vals[0].(int64)
	retryMS, _ := vals[1].(int64)
	return Verdict{
		Allowed:    allowed == 1,
		RetryAfter: time.Duration(retryMS) * time.Millisecond,
	}, nil
}

// Key 构造限流键。配额按 realm+连接器+用户 三元组切分：
// 一个用户打爆某连接器，不应牵连同 realm 的其他用户，也不应影响别的连接器。
func Key(realm, connectorID, userID string) string {
	return fmt.Sprintf("lumo:cg:rl:{%s|%s}:%s", realm, connectorID, userID)
}
