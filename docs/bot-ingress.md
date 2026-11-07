# Bot 事件接入

服务端入口为 flows 的 `POST /v1/bot/events/{channel}`。通用渠道适配器把消息转为 JSON，签名后发送到此入口。消息进入现有 PG outbox，由 TriggerBus 匹配已发布流程与启用的 event/webhook 自动化。团队委派要求 v2 签名绑定外部 subject，并以映射的平台发送者身份执行；每个节点检查发送者、Flow 作者、团队 owner、项目和 Agent 的当前授权交集。

这是通用接入协议。飞书、企业微信、Slack、Telegram 等厂商的挑战验证、原生签名转换、可信发送者提取和消息回复仍需对应适配器；当前没有声明支持 A2A 协议。治理服务已有 channel/subject→平台用户映射及团队 capability grant。消息中的 `realm`、`roles`、`user_id` 仅是数据，不能改变流程执行权限。

## 启用与部署

默认关闭。设置 `LUMO_BOT_CHANNELS_FILE` 指向只读 JSON 文件，内容参照 `platform/deploy/bot/channels.example.json`。每项固定 `id`、`realm`、`event` 和 `secret_env`；团队执行渠道另设 `require_subject:true`。对应环境变量至少包含 32 字节随机密钥。配置错误或缺密钥会在连接数据库前阻止启动，渠道变更需要重启 flows。

Compose 的 Standalone、Cluster compact/full 都通过 `api-bundle` 启动 flows。使用可选覆盖文件：

```sh
# 先在部署环境设置 LUMO_BOT_ALERTS_KEY，并准备真实 realm 的配置文件。
export LUMO_BOT_CHANNELS_PATH=/absolute/path/channels.json
LUMO_COMPOSE_EXTRA_FILES="$PWD/platform/deploy/compose.bot.yml" \
  ./platform/deploy/up.sh cluster -d --build
```

`LUMO_BOT_CHANNELS_PATH` 使用绝对路径。示例文件固定绑定 `dev` realm。bundle 子进程只接收带服务前缀的环境变量，因此覆盖文件使用 `LUMO_BUNDLE_FLOWS_LUMO_BOT_CHANNELS_FILE` 和 `LUMO_BUNDLE_FLOWS_LUMO_BOT_ALERTS_KEY`；增加其他渠道时也要增加对应的前缀密钥变量。

Kubernetes 独立 flows Deployment 使用无 bundle 前缀的上述变量：配置文件挂载 ConfigMap，密钥从 Secret 的 `secretKeyRef` 注入。当前 Helm 默认值不启用或公开此入口。对外代理应把该精确路径转发到 flows 并终止 HTTPS；普通控制面 API 继续要求 Bearer 认证。不要把渠道密钥设为控制面令牌。

flows 启动会自动创建 `flow_bot_receipts`。集中迁移 `011_flow_bot_receipts.sql` 用于已有 flows 数据库，前置为 flows 已初始化 `flow_trigger_outbox`；Go DDL 与迁移的列、唯一键和外键有真实 PG 结构一致性检查。使用治理委派算子时，还需 governance 的回执结构（迁移 `012_governance_delegation_receipts.sql`，服务启动也会确保）；回执表引用已存在的治理 Task/Run 基础表。

团队授权还需要 migration `019_bot_team_authorization.sql` 的映射/grant 表和 outbox `bot_scope`。服务启动同样确保这些结构，并将旧 Bot receipt 及其 replay 链标记为无发送者身份的 legacy scope，避免历史事件继承作者权限。治理的 `LUMO_BOT_TEAMS_URL` 指向可信团队 runtime 基址；部署接线与授权 API 见 [Bot 团队授权](../platform/deploy/bot/README.md)。

## 签名契约

请求体为最多 1 MiB 的 JSON 原始字节。团队执行渠道使用 v2，四个头必填：

| Header | 内容 |
|---|---|
| `X-Lumo-Bot-Id` | 渠道内稳定消息 ID，1–200 个字母、数字、`_ . : -` |
| `X-Lumo-Bot-Timestamp` | Unix 秒；允许服务器时间前后 300 秒 |
| `X-Lumo-Bot-Subject` | 适配器从可信渠道事件提取的外部发送者 ID，字符范围及长度同消息 ID |
| `X-Lumo-Bot-Signature` | `v2=` 加小写或大写十六进制 HMAC-SHA256 |

签名输入为以下字节拼接，最后一段是原始请求体，末尾不额外加换行：

```text
{timestamp}\n{channel}\n{message_id}\n{subject}\n{raw_body}
```

未设置 `require_subject` 的旧渠道继续使用 v1，签名输入省略 subject 行，忽略未签名的 Subject 请求头。这类渠道可以执行本地 `echo` 等操作，不能执行外部能力。

重试必须保留原消息 ID、subject 和请求体字节，刷新时间戳并重新签名。JSON 空格或键顺序变化也算不同内容。数据库去重键是 `(realm, channel, message_id)`，摘要同时包含 event 名和已签名 subject。

使用仓库内发送工具：

```sh
node platform/tools/send-bot-event.mjs \
  --url http://127.0.0.1:18087 \
  --channel alerts --message-id incident-001 \
  --subject external-user-123 \
  --secret-env LUMO_BOT_ALERTS_KEY --payload-file /absolute/path/event.json
```

远程 URL 要求 HTTPS，工具拒绝重定向，不打印密钥或消息体。响应示例：

```json
{"status":"queued","trigger_id":"42","duplicate":false}
```

同内容重投返回同一个字符串 ID，`duplicate:true`；重新使用消息 ID 改内容、subject 或绑定 event 返回 `409 message_conflict`。其他状态：401 签名/时钟/ID 不合法；403 发送者没有当前有效映射；404 渠道不存在；405 方法错误；413 超过体积限制；503 数据库暂不可用。503 后使用原 ID 重试。

## 自动化绑定与执行边界

为目标项目配置已发布流程与启用的自动化，`triggerKind` 为 `event` 或 `webhook`，`triggerSpec` 与渠道 `event` 完全相同，例如 `bot.message`。流程收到：

```json
{"channel":"alerts","message_id":"incident-001","data":{"text":"检查这次发布"}}
```

`202 queued` 证明持久入队；不保证已经存在匹配的自动化，也不代表流程执行成功。执行结果读取原有流程运行台账和回放接口。

回执和 outbox 同一事务提交；并发、服务重启不会重复生成同一触发。worker 仍采用至少一次投递，流程副作用遵循原执行器/算子的幂等契约。不要把入口去重宣称为外部副作用的 exactly-once。回执没有自动 TTL；删除回执会重新允许对应消息入队，保留期必须覆盖渠道重试窗口。外键要求先处理回执，再清理关联 outbox。

## 通过已审核流程创建治理委派

`delegation.create` 已接入 FlowEngine，允许审核过的流程创建治理 Task/Run。先为 flows 配置 `LUMO_GOVERNANCE_URL` 与控制面凭据；Compose bundle 使用 `LUMO_BUNDLE_FLOWS_LUMO_GOVERNANCE_URL`，Helm 从同一 release 已启用的 governance 服务派生地址。算子未配置地址时不可用。治理委派仍需就绪 Cluster；Standalone 即使装配了地址也不会绕过治理门禁。

流程定义示例：

```json
{
  "nodes": [{
    "id": "delegate",
    "operator": "delegation.create",
    "config": {
      "projectId": "project-a",
      "assigneeWorkerId": "agent:preset-a",
      "teamId": "team-a",
      "captainSessionRef": "captain-session-a",
      "intent": "分析这次告警并提交报告",
      "requiredTags": ["report"]
    }
  }],
  "edges": []
}
```

项目必须等于流程自身项目。Worker、意图、`requiredTags` 和可选 `requiredSkills` 均来自已审核配置，固定 `auto_assign:false`；消息里的同名字段不能覆盖它们。消息 JSON 作为不可信数据附加到意图：输入最多 256 KiB，合并后的意图最多 8000 字符，请求与响应各最多 1 MiB；超过限制会产生失败运行台账，不会静默截断文本。

管理员先通过治理 API 建立受信 channel/subject→user 映射和 `delegation.create` capability grant；grant 固定映射用户/版本、团队 owner/captain/revision、项目、Agent 及其 preset revision。入队时把当前 grant 目标和版本记录在独立服务端 scope 中。每个委派节点执行前，治理重新读取当前发送者、Flow 作者、团队 owner 的有效状态、角色和项目成员关系，以及发布 Flow 的不可变节点配置、团队当前事实和 preset。任何撤权或版本变化均拒绝。消息 JSON 无法提供权限；旧消息和 replay 也不能借用后续新增或更新的 grant。当前 Bot 外部 capability 仅开放 `delegation.create`；这仍通过治理 Task/Run 执行，不直接调用 dsh 团队模型工具。

事件中的同次投递使用由 trigger/automation/flow/version 派生的稳定执行键；算子再结合 realm/user/node 产生治理 `Idempotency-Key`。Governance 先检查当前权限，再查持久回执；同作用域同请求重试返回原 Task/首次 Run，同键改请求为 409，权限撤销后拒绝。Task 后续改派时，重放仍返回首次 Run；回执不设自动 TTL。显式重放失败流程是新的业务尝试，不是同次消息重投。

手工运行使用当前经认证并通过项目成员检查的调用者身份。调用 `POST /v1/flows/{id}/run` 执行此算子必须携带合法 `Idempotency-Key`（1..200 个 ASCII 字母、数字或 `_ . : -`）。页面试运行及派单会在当前挂载期间保留失败请求的键、成功后清除；刷新或关闭页面不会保留它。直接调用方应持久保存自己的请求键，不能把页面临时状态当作跨刷新防重保证。

真实 PostgreSQL 与 HTTP 测试覆盖 v2 入队、并发与重启去重、scope 重放固定，以及发送者/作者/团队/project/preset 的撤权矩阵；团队 authority 测试覆盖服务凭据、realm、当前 KV revision 和删除墓碑。早期独立进程证据验证过作者身份版本的 Task/Run 去重，不能替代本次发送者授权链或真实 LLM/厂商适配器验收。相关迁移背景见 [团队迁移、流程委派与分页](./team-migration-and-governed-flows-2026-11-06.md)。`tool.invoke` 仍是 connector 网关算子。
