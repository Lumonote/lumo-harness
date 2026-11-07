# 原生模型配置与 Docker 双节点验收（2026-11-07）

本轮在 `codex/v1.2.1` 对齐了 DeepSeek Harness 的原生模型配置，并完成单机 Docker
中的双节点 Thread 故障验收及完整集群生命周期故障验收。外部供应商的原生调用返回
`AUTH / access-denied`，真实模型两轮历史和用量仍未验收。未进行物理跨主机或生产
高可用验收，也未部署生产。

## 模型配置与部署

模型路由通过原生 `cordis.patch.yml` 修改已有的 `llm-pi-ai`、`agent-default-model`，
不新增另一套平台 provider 配置。Anthropic Bearer 由 catalog 发现
`ANTHROPIC_AUTH_TOKEN`；显式 `apiKeyEnv` 使用 API-key 认证。URL 前缀和模型 id
按 SDK 原样传递。字段、加载优先级、凭据轮换见[配置边界](./configuration.md)，
可直接使用[部署示例](../platform/deploy/examples/dsh-models.anthropic.patch.yml)。

Compose 的 standalone/full/compact 各有可选模型 overlay，挂载只读 home patch，
通过 raw 环境文件注入凭据。每个 DSH 进程使用独立 home 卷；compact 的平台生成
patch 也按进程分别写入 home，避免两个角色互相覆盖或删除。Helm 使用既有
ConfigMap/Secret，可选择每 Pod 独立 home PVC；持久 home 仅允许 StatefulSet。
升级、迁移和重启步骤见[部署说明](../platform/deploy/README.md#原生模型配置的部署)。

修复了 compact 拓扑中 A 独立 DSH 缺少 `cluster-full` 标记的问题，默认 compact
只启动两个 bundle。另纠正独立 Go `llm-gateway` 文档中的重复 `/v1` 示例；该网关
注册表与 DSH 原生配置是不同入口。镜像上下文新增排除非模板 `.env` 文件。

## 实际验证

| 验证 | 结果与范围 |
|---|---|
| 原生 HTTP 合约 | 4 项通过。公开 Cordis root Include 对上游 base bundle 的真实模型服务行应用 patch，经原生 adapter 发往本机 HTTP 服务；验证 Bearer/API-key 互斥、路径前缀、版本头及模型名透传。使用合成凭据，无外部调用。 |
| 外部供应商 | 原生配置链执行首轮一次，输出上限 32 token、禁止重试；返回 `AUTH / access-denied`，无成功文本，未执行第二轮。usage 为 0 不证明供应商未计费。 |
| 部署配置 | 26 项定向渲染检查、4 个回归测试通过，覆盖三种 Compose 形态、raw 凭据、默认服务集合、独立 home/生成 patch、Helm ConfigMap/Secret/PVC 及非法配置拒绝。 |
| Helm 全组合 | 本机实际模板渲染、唯一键 YAML 与结构检查通过；本机未安装 kubeconform，Kubernetes schema 检查由 CI 强制执行。本轮未向 Kubernetes apply。 |
| 完整镜像 | DSH runtime 与控制面验收镜像成功构建。运行时关键 Thread/启动器源码哈希与工作区一致；离线扫描镜像 `/workspace` 未发现非模板 `.env` 文件。 |
| 集群健康与行为 | 故障前后均通过：14 个控制面健康接口、两个执行 host 就绪、调度目录、Web 登录与未认证拒绝、Prometheus，以及 6 项网关/控制面行为探针。 |
| 集群故障 | 22 个断言通过：leader SIGKILL 后更高 fencing token 接管、放置和终态重放幂等、执行节点移出真实 Nacos 及重注册、drain 区分存活与就绪、PG 暂停拒绝新准入且无新增持久执行、Nacos 暂停暴露过期目录并拒绝放置、依赖恢复。故障状态恢复无失败。 |
| Thread 双节点 | 28 个断言通过，详见下文。使用真实控制面、PG/Redis、平台插件、公开 AgentLoop/JSONL；仅模型 adapter 为确定性替身。 |
| 上游边界 | `deepseek-harness` 保持 `fcc0ad46` pristine，未修改上游源码或锁文件。 |

原生模型合约使用的是模型配置切片，不代表完整 headless profile 已成功调用外部
供应商。完整集群的 DSH profile 已实际启动并通过健康检查，但未配置外部供应商调用。
最后补充的 compact 生成 patch 隔离通过真实子进程环境函数的回归断言；本轮未另行
启动 compact bundle，因此不将 full 拓扑故障结果当作 compact 的运行验收。

## Thread 双节点故障结果

- 源节点发布真实协调者 Agent，目标 Thread 的 user/project/node/session 由 authority
  分配；伪造 `parent.id` 在入队前被拒绝。
- 源节点通过持久 mailbox 派发，只有登记目标节点执行模型；源节点调用数为 0。
- 控制面与两个运行时全部重启后，持久等待事件自动续跑，保留前轮历史及逐轮计量归属，
  Agent 与计量 scope 完成后释放。重复 wake 和回执重放不增加调用。
- 目标 Docker 网络断开时命令保持 pending，其他节点不能 claim；恢复网络后只执行一次。
- owner 撤权在模型执行前拒绝命令，不产生新轮次。
- 在模型流已经开始后 SIGKILL 目标节点，重启后保留 claimed/running 的不确定状态，
  不自动回收或重放。最终为 3 个完成轮次、1 个不确定轮次，目标共调用 4 次。
- 源、目标使用独立卷并核验隔离标记。测试项目的容器、卷、网络和临时凭据全部清理。

前两次尝试发现并修复了验收脚本的健康响应解析、重启后随机宿主端口缓存问题；
失败记录保留，没有把这些尝试计作通过。

## 证据与剩余边界

本机保留脱敏证据：

- `platform/.build/provider-acceptance-20261107/`：原生 HTTP 合约、外部调用及配置复核。
- `platform/.build/native-model-deployment-20261107/`：部署定向报告、最终回归日志。
- `platform/.build/thread-docker-20261107/`：28 个断言、节点与镜像身份、失败尝试和清理记录。
- `platform/.build/docker-acceptance-20261107/`：构建日志、故障前后探针、22 个故障断言、
  镜像源码核验及清理汇总。

两个独立 Docker 验收项目均已删除容器、卷、网络和临时凭据；验收镜像及脱敏报告保留。

此前 TS 1180/Go race 812 的全回归结果见[五项交付说明](./thread-fleet-delivery-2026-11-07.md)；
本轮部署修复未改应用层执行协议。Docker 共享同一个宿主、内核和磁盘，不能据此确认
物理跨主机网络分区、基础设施主备切换、生产容量、RPO/RTO 或真实模型成本。
外部模型验收还需要能接受原生流式请求的端点、凭据和模型权限；当前拒绝结果不能
单独定位为凭据、网关 ACL、模型权限或中间网络策略中的某一项。
