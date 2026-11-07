# 业务入口指标与告警（2026-11-07）

本批为 Session 执行、附件读取、受控审核文件和 owned connector 的真实服务入口增加
`lumo_business_requests_total{operation,outcome}`。指标用于定位故障与提醒运维，业务授权、
租约、审核证据和连接器 consent receipt 仍以各自的权威事务为准。

## 覆盖范围与维度

| operation | 服务及入口 | 主要结果 |
| --- | --- | --- |
| `session_execution_node` | session-control 执行节点获取、读取及续租 | success、invalid、fenced、conflict、not_found、unavailable |
| `session_execution_lease` | session-control 会话执行租约操作 | success、invalid、fenced、conflict、not_found、unavailable |
| `session_attachment` | session-control 权威附件清单读取 | success、invalid、not_found、unavailable |
| `review_file_read` | governance 受控逐文件审核读取 | success、denied、invalid、not_found、conflict、unavailable |
| `connector_request` | connector-gateway owned list、prepare、decide、execute 的请求结果 | success、denied、conflict、unavailable、unknown、failed |
| `connector_invoke` | owned connector 实际执行流程的结果 | success、unknown、failed |

`operation` 仅允许表中的 6 个值；`outcome` 的完整闭集为 `success`、`invalid`、`fenced`、
`conflict`、`not_found`、`denied`、`unavailable`、`unknown`、`failed`。共享闭集不代表每个操作
都能产生全部结果，表格列出其常见路径。未进入业务处理器的认证中间件拒绝不在本指标覆盖内。

不加入 realm、user、session、project、connector、receipt、URL 或错误正文等动态标签。
Prometheus 的 `service`/`instance` 来自抓取配置，业务调用方不能自行传入。

## 计数与资源边界

指标为进程存活期间单调累加的值，每次业务结果增加 1。为了兼容现有手工指标导出器，
Prometheus 文本和 OTLP 仍按 gauge 输出；告警对该单调值使用 `increase(...[5m])`，
按原始序列计算增量后再聚合，允许进程重启归零。不要使用 `sum(...) > 0` 表示当前故障，
否则历史故障会持续触发。

各服务在加载 OTel 配置之后、注册路由时预注册本服务 operation 的全部 outcome 零值。
session-control 使用 27 条、governance 使用 9 条、connector-gateway 使用 18 条序列。
同一进程重复注册只增加零，不重置已有计数。首次抓取前发生的事件、抓取中断期间的进程退出，
以及事件写入后立刻崩溃，仍可能使短暂事件无法被 Prometheus 观察；指标不提供持久投递保证。

原子增量与现有手工 gauge 共享序列预算，默认每进程 128 条，可通过 OTel 成本配置约束。
非法枚举、非法指标/标签、非有限值和超预算写入均拒收并增加
`lumo_observability_metric_series_dropped_total`。累计值、标签复制和预算判断在同一锁下完成，
避免并发请求丢计数或标签复用污染。应同时观察该 dropped 信号；被丢弃的业务序列不能视为零故障。

connector invocation 的 `unknown` 在回执持久化前记录。即使数据库随后写回执失败，也能保留
本进程观察到的不确定结果；对应 `connector_request` 仍可为 `unavailable`，两者分别反映外部执行
和请求完成状态，不能相加充当唯一业务请求总数。

## 告警处置

三条新增规则均为 P2 / warning，观察近 5 分钟增量，`for: 0m` 表示下一次规则计算即可触发。

| 告警 | 触发结果 | 处置 |
| --- | --- | --- |
| `LumoSessionExecutionFenced` | 执行节点或会话租约的 fenced 增量大于零 | 核对 session-control 数据库延迟、节点心跳与重启记录；失租进程停止执行，由新进程取得权威租约。 |
| `LumoReviewFileUnavailable` | 审核文件 unavailable、not_found 或 conflict 增量大于零 | 检查治理服务、数据库文件 blob 和原始 manifest，保留审核阻断；读取或摘要校验失败不能记为已审核。 |
| `LumoOwnedConnectorOutcomeUnknown` | connector_invoke 的 unknown 增量大于零 | 人工核对外部系统与 consent receipt；不可自动重试或重置为可执行，外部操作可能已经提交。 |

fenced 也可能来自正常接管后的旧进程请求，需结合心跳和台账判断影响。正常授权撤销的
review-file denied 单独计数，不触发文件不可用告警。业务指标不含对象身份，具体对象通过
有访问控制的日志、租约台账及回执查询定位。

## 部署与规则门禁

告警唯一源文件为 `platform/deploy/prometheus-alerts.yml`。标准 Compose Prometheus 已将其只读
挂载为 `/etc/prometheus/lumo-alerts.yml`，并由抓取配置的 `rule_files` 加载。

Helm chart 的 observability ConfigMap 仅提供 Collector、日志、生命周期配置及两条 recording
rules，不部署外部 Prometheus/Alertmanager，也不自动加载上述告警文件。Helm 用户须让外部
Prometheus 加载该 canonical 文件，并提供与规则匹配的 `service` 标签和 scrape targets。
不要只加载 chart 内的 recording rules 就认为业务告警已经启用。

`platform/deploy/alerts-verify.sh` 检查指标写入点、抓取服务、标签及有限枚举、告警类别和路由等级。
它同时要求 14 个已知错误样例以指定原因失败，覆盖业务 outcome 拼写错误、私有动态标签以及
连接器未知结果告警被删等回归。新增 operation/outcome 必须同时修改 Go 闭集、入口和告警合同。

## 本分项验证

- observability 全模块 `go test -race -count=1 ./...` 通过，包括原子并发增量、序列预算、零值、
  枚举拒收和告警检查器正反例。
- session-control 执行及附件入口、governance 审核文件入口、connector-gateway rejection 指标的
  定向 race 测试通过；三服务启动路由的初始零值也在入口测试中验证。
- 三服务 `go vet ./...` 和 `go build ./...` 通过。
- 告警门禁通过：24 条真实规则及 14 个反例。
- 最终集中验收已覆盖 connector-gateway 完整模块的真实 PG 与 `httptest` 本地监听，
  共 71 项 race 测试通过、无失败或跳过；此前离线沙箱监听被拒的结果不作为通过证据。
  跨模块最终计数见 [六项优化交付](six-optimization-2026-11-07.md)。

以上验证不代表生产 Prometheus 已加载规则或完成告警投递演练。部署后仍需核查 targets、
规则加载状态与实际告警路由。
