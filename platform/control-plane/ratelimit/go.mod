// 共享限流库（§12.2「与内部网关共享同一限流库」）。
// 模块路径 github.com/lumo-harness/platform/ratelimit，供 edge-gateway 与
// 连接器网关等所有南北向网关共用同一份令牌桶实现，避免各服务各写一套。
module github.com/lumo-harness/platform/ratelimit

go 1.24.0

require github.com/redis/go-redis/v9 v9.7.0

require (
	github.com/cespare/xxhash/v2 v2.2.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
)
