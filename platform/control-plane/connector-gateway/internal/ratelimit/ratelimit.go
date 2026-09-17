// Package ratelimit 连接器网关侧的限流接入点。
//
// 实现**不在这里**：令牌桶的 Lua 脚本与判定逻辑住在共享模块
// `github.com/lumo-harness/platform/ratelimit`，由边缘网关与连接器网关共用同一份
// （§12.2「全局速率限制：Redis 令牌桶中间件（与内部网关共享同一限流库）」）。
//
// 本包只留两样东西：
//
//  1. **类型别名**，让既有调用点（`gateway.go` 的字段与构造、`server_test.go` 的
//     fake scripter）一个字都不用改——这是一次纯粹的搬家，不是一次接口重设计。
//     别名而不是包装类型：包装类型会让 `*ratelimit.Limiter` 与共享包的
//     `*ratelimit.Limiter` 成为两个不同的类型，于是每个调用点都要多一次转换，
//     而转换掩盖了「它们本来就是同一个东西」这个事实。
//  2. `Key`：**连接器特有的键分区**（realm+连接器+用户三元组），它属于本服务的
//     领域知识，不属于通用限流库。放在这里而不是共享模块里，是因为共享模块不该
//     知道「连接器」是什么。
package ratelimit

import (
	"fmt"

	shared "github.com/lumo-harness/platform/ratelimit"
	"github.com/redis/go-redis/v9"
)

// Limiter 与共享模块是同一个类型（见包注释）。
type Limiter = shared.Limiter

// Verdict 与共享模块是同一个类型。
type Verdict = shared.Verdict

// New 构造一个令牌桶限流器。
func New(rdb redis.Scripter) *Limiter { return shared.New(rdb) }

// Key 构造连接器调用链路的限流键。
//
// 配额按 realm+连接器+用户 三元组切分：一个用户打爆某连接器，不应牵连同 realm 的
// 其他用户，也不应影响别的连接器。花括号让 Redis Cluster 把同一个桶固定到同一个
// 槽位——否则 `{...}` 两侧变成两个键，Lua 脚本里的 `KEYS[1]` 在多实例下会时而
// 落在不同节点上，原子性即失效。
func Key(realm, connectorID, userID string) string {
	return fmt.Sprintf("lumo:cg:rl:{%s|%s}:%s", realm, connectorID, userID)
}
