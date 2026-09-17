// 终端网关 terminal-gateway（§8.2「多端」落地、缺口 C4 的实现）。一个服务一个 Go module。
module github.com/lumo-harness/platform/terminal-gateway

go 1.24.0

require github.com/lumo-harness/platform/observability v0.0.0

replace github.com/lumo-harness/platform/observability => ../observability

require github.com/lumo-harness/platform/heartbeat v0.0.0

replace github.com/lumo-harness/platform/heartbeat => ../heartbeat

require github.com/jackc/pgx/v5 v5.7.2

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/sync v0.10.0 // indirect
	golang.org/x/text v0.21.0 // indirect
)
