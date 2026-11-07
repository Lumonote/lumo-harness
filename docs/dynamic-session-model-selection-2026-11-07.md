# 动态会话模型选择

认证会话默认继续使用部署固定的 `provider` 与 `model`。只有在
`LUMO_USER_SESSION_EXECUTION`（或 Helm `dshWeb.userSessionExecution`）显式给出
`modelChoices` 时，页面才显示模型选择器。每个 choice 固定 `id`、展示名称、provider、
model、可选 reasoning effort 和 `billingModel`；`billingModel` 必须对应已经启用且有非负
费率的 `llm_providers` 行。浏览器只能提交 choice ID、策略摘要和观察到的 session 日志序号，
不能提交 provider、模型名、URL、密钥、价格或账单归因身份。

切换请求在 Agent 的原生 `runMaintenance` 空闲阶段串行执行，要求当前登录、项目授权、
owner、执行租约、无活动轮次且 inbox 没有待发送消息。它二次比较日志序号，写入官方
`model/selection` 事件并 flush 后才应答；并发变更返回 409。每个 model turn 在 pre-step
冻结完整 provider/model/reasoning snapshot，重试或同一轮后续 step 不能改变路由。

恢复和 fork 读取会话日志中的原生选择，并重新对照当前部署 allowlist。已撤销的 route
会 fail closed；页面无法用旧会话绕过撤销，需管理员重新批准并新建会话。fork 只继承完整
已完成轮次及其 model selection，不继承浏览器字段或未完成输入。

动态路由通过可信 session owner 的 `modelRoutes` 绑定到计费注册表。每次真实模型调用在
provider 之前读取当前启用费率并冻结 quote；调用结束按真实 input/output usage 和该 quote
写入原有 usage outbox。费率在调用期间变化不会改写本次账单，缺失、停用、非法费率或
未批准 route 都在 provider 调用前拒绝。固定单模型部署保留旧计量行为。

API 入口：`POST /lumo/sessions/models` 查询当前策略和选择，
`POST /lumo/sessions/selectModel` 提交选择。跨节点请求由 owner 节点处理并继续执行租约
与当前登录复核；源节点执行租约失效会终止在途流。
