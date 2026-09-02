# 授权判定契约

## 规则

所有服务端授权均归一为：

```text
PolicyDecision(actor, resource, action, context)
```

资源属于一个 Realm，且可选地绑定 Project 与 Space。有效权限取最小交集：

```text
Realm action grant ∩ Project membership ∩ Space grant
```

任一边界拒绝或暂时无法确认，即拒绝。项目角色或 Space 授权不能提升 Realm
动作权限；这条规则也适用于 Agent 与服务账号。

## 当前落地

Governance 提供：

- `GET /v1/effective-permissions`：返回当前调用者在可选
  `project_id`、`space_id` 资源上下文中的全部受支持动作及其决策。
- `POST /v1/permission-explain`：接收 `{ action, resource }`，返回具体的
  allow/deny 原因和命中的策略。

目前支持 `task:delegate` 与 `task:execution:update`。Realm 动作由受信任的
网关注入角色映射决定；有 `project_id` 时，非 Realm 管理员必须是项目成员。

Space 的权威授权源尚未接入 Governance。因此任何带 `space_id` 的请求都会以
`Space 授权状态未知` 明确拒绝，直到协作/知识服务暴露可验证的 Space grant
查询接口。禁止把这种未知状态退化为允许。

## 后续接入要求

协作与知识服务接入时必须只传递经过服务端验证的 Space grant，不接受客户端
携带的布尔授权。Agent 下授还需在相同决策中增加：父权限子集、最大深度、预算、
时长、连接器范围与数据驻留域；其中任一限制超过父任务上下文即拒绝并写审计。
