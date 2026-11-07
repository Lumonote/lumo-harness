# Bot 团队授权

启用团队执行的 channel 必须配置 `"require_subject": true`。适配器从聊天平台的可信发送者事件提取外部 subject，使用 channel secret 签名；消息 JSON 内的 `sender`、`user_id` 和 `roles` 都不提供执行权限。

v2 签名为 HMAC-SHA256，输入为 `timestamp + "\n" + channel + "\n" + messageId + "\n" + subject + "\n" + 原始请求体字节`。请求头包括 `X-Lumo-Bot-Id`、`X-Lumo-Bot-Timestamp`、`X-Lumo-Bot-Subject` 和 `X-Lumo-Bot-Signature: v2=<hex>`。时间窗为正负 5 分钟；subject 与 message ID 只能包含字母、数字、`_ . : -`，最多 200 字符。

```sh
node platform/tools/send-bot-event.mjs \
  --url https://flows.example.com --channel alerts \
  --message-id chat-message-123 --subject external-user-123 \
  --secret-env LUMO_BOT_ALERTS_KEY --payload-file /path/to/message.json
```

治理服务设置 `LUMO_BOT_TEAMS_URL` 为可信 Agent Teams runtime 的 HTTP(S) 基址。该服务须实现 `GET /lumo/runtime/teams/{id}`，验证控制面 Bearer token 和 `X-Lumo-Realm`，返回当前持久团队事实：`realm`、`id`、`owner_user_id`、`captain_session_ref` 和不透明 `revision`。服务不可达、响应不一致或 revision 变化时执行拒绝。治理数据库运行 migration `019_bot_team_authorization.sql`；Flows 运行相应 outbox `bot_scope` 升级。

Realm 管理员通过治理 API 建立映射并授权。下列请求沿用控制面的认证方式及 `X-Lumo-Realm`、`X-Lumo-User`、`X-Lumo-Roles` 可信头边界。

```http
PUT /v1/bot/channels/alerts/subjects/external-user-123
Content-Type: application/json

{"user_id":"platform-user","status":"active"}

PUT /v1/bot/channels/alerts/subjects/external-user-123/grants
Content-Type: application/json

{"team_id":"team-id","project_id":"project-id","agent_id":"preset-id","capability":"delegation.create","status":"active"}
```

授权固定映射用户和版本、团队 owner/captain/revision 以及 Agent preset revision。团队须已有明确 captain；Agent 必须属于团队 owner 和同一项目。被审核发布的 Flow 节点须在 config 明确指定 `teamId`、`captainSessionRef`、`projectId`、`assigneeWorkerId: "agent:<preset-id>"`。

每个 `delegation.create` 节点执行前重新查询当前事实，要求映射发送者、Flow 作者、团队 owner 都是有效用户，具有当前委派角色和该项目成员关系。任一角色、成员关系、映射、grant、团队或 preset 撤销/变化都会拒绝后续执行。当前 Bot capability 只开放 `delegation.create`，其他外部操作拒绝；本地 `echo` 等无副作用节点可以继续使用。没有 `require_subject` 的旧 v1 channel 不能执行外部操作。

同 realm/channel/message ID 并发投递和服务重启只保留一次 durable trigger；相同 ID 的不同内容或不同 subject 返回 409。入站身份和当时有效的 grant 目标及版本写入独立服务端 `bot_scope`，不会从 payload 重建。重投及失败 replay 保留原用户、映射版本、grant 版本、Flow 和 Flow 版本；重新绑定 subject 不会改变旧任务身份，重新授权 grant 也不会追溯授权旧消息。显式更新映射、团队或 preset 后，管理员需要重新提交 grant，后续新消息才能使用新范围。

撤销时将映射或 grant 的 `status` 改为 `revoked`；grant 撤销仍提交原 team/project/agent/capability。团队 runtime 不可达时也可以撤销已有 grant。
