# 双受众插件工具权限判定

`POST /v1/permissions/decide` 是 Governance 的服务间只读接口。它回答“这个用户现在能否对这个资源调用该工具”，不执行工具、不创建审批，也不签发可重放的凭证。已有任务动作的 [Realm / Project / Space 授权契约](./authorization-contract.md) 保持不变。

## 请求与响应

调用宿主用 `Authorization: Bearer <LUMO_CONTROL_PLANE_TOKEN>` 认证，并用 `X-Lumo-Realm`、`X-Lumo-User` 声明已经核验的调用者。请求体的 realm、资源 realm 和 principal 必须与头部一致。不要从表单或模型参数构造身份。服务端忽略请求头中的角色，逐次从 PostgreSQL 读取活跃用户和有效直接角色。

```json
{
  "realm": "team-a",
  "principal": {"kind": "user", "id": "alice"},
  "action": "project:read",
  "resource": {"realm": "team-a", "kind": "dual-tool", "id": "project/project_context", "project_id": "project-1"},
  "risk": "low",
  "approval": "never"
}
```

```json
{
  "decision_id": "decision-example",
  "effect": "allow",
  "reason_code": "authorized",
  "reason": "tool access granted",
  "matched": ["realm:action", "project:member"]
}
```

| 已登记资源 | 动作 | 服务器端授权条件 |
|---|---|---|
| `project/project_context` | `project:read` | 当前有效用户是同 realm、active 项目的成员；必须给出 `project_id`。执行端另核对与节点实际读取的项目一致。 |
| `acp-engines/acp_engines_list` | `agent:engine:list` | 当前有效用户有直接、未过期的 `admin`、`realm_admin` 或 `platform_admin` 角色；提供项目时仍需项目成员资格。判定允许不等于引擎已装配。 |

动作与资源按对登记，不接受任意插件自报动作。可选 `actor` 只接受带 `agent_id` 的 `agent`，深度须在 0–3，不增加负责人的权限。`run_id`、`session_ref` 不是授权凭据。既有 OPA 配置只能收窄上述结果。这两个只读动作没有加入可编辑的任务角色动作目录。

`200` 包含 `allow`、`deny` 或 `ask`，不能把 HTTP 成功当作放行。只有已获授权的调用才会因 `approval=always` 或 `risk=high, approval=auto` 返回 `ask`；`high + never` 拒绝。未知字段、超限请求体或多段 JSON 返回 `400`；缺身份或凭据错误返回 `401`；服务未配置凭据、事实源或策略故障返回 `503`。正常决策不缓存。

## 配置和边界

服务器宿主优先使用 `LUMO_AUTHZ_DECIDE_URL` 指定的 Governance **基地址**，否则使用 `governanceUrl`。远端失败、重定向、响应缺字段与真实拒绝在 `enforce`、`shadow` 都不会执行工具。只有明确标记 `advisory_deny` 的观察策略可被 `shadow` 放行。单机桌面仍用原有 LocalDecider。非本机宿主不会用部署默认身份补齐缺失的工具调用者；仅有会话 ID 或 Agent ID 的平台调用将被拒绝。关闭双受众插件而回到旧的注册方式时，此接口不在执行路径中。

可嵌入库是 `github.com/lumo-harness/platform/governance/permission`。其他 Go 服务可以调用 `Decide`，并提供查询权威授权事实的回调；自报角色或客户端布尔值不能作为该回调的实现。新增工具时应同时登记资源/动作、提供权威查询，并测试未授权与撤权路径。

## 复验

在 `platform/control-plane/governance` 运行 `go test -count=1 ./permission ./internal/server -run 'TestDecide|TestToolDecision'`。需设置专用 `LUMO_TEST_PG_DSN` 才会实际执行 `TestToolDecisionCurrentGrants`；不设置会跳过该项。集成测试覆盖经 HTTP 读取真实项目成员资格、角色过期、用户停用、跨 realm 及 OPA 收窄。在 `platform` 运行 `pnpm exec vitest run dsh-plugins/dual-plugins` 验证宿主行为。
