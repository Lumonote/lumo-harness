package lumo.session_control

import rego.v1

# 共享执行控制（§8.4.2）的授权策略。
#
# 判据只落在「角色是否被授予该指令」上。realm 与非本 realm 会话之间的隔离**不在这里**：
# 策略看不见会话状态行的 realm（那是库里的行），把隔离写成一条规则会得到「看起来在拦、
# 其实拦不住」的策略，而唯一的 realm 边界在服务侧（session-control 的 store.Commit）。
default allow := false

# 角色 → 指令白名单。**闭集**：未列出的角色没有任何指令权限（下面的 allow 因
# `commands[input.role]` undefined 而整条不成立，这正是不该被「查不到就放行」取代的
# fail-closed）。
commands := {
  "operator": {"pause", "resume", "stop", "replay"},
  "approver": {"approve", "reject", "degrade"},
  "admin": {"pause", "resume", "stop", "abort", "approve", "reject", "replay", "degrade"},
  "realm_admin": {"pause", "resume", "stop", "abort", "approve", "reject", "replay", "degrade"},
  "platform_admin": {"pause", "resume", "stop", "abort", "approve", "reject", "replay", "degrade"},
}

# 放行条件：四项**全部**成立。前三项要求主体完整——缺一个就等于是「没有主体」，
# 而没有主体不该有任何控制权。
#
# 这些键名（command / sessionRef / realm / role / actor）是服务侧 Request.Input() 的
# 契约面，由 Go 侧 policy_test 的 TestInputCoversKeysReadByDeployedPolicy 从本文件
# 反抽键来核对：**本文件新增一个键、Go 侧没发它，测试先红**，而不是等到部署后
# 「所有人都没有控制权限」才发现。
#
# 判据写成 `!= ""` 而不是只判存在性：空串在 rego 里是**真值**，所以「键在但为空」
# 与「键不在」必须都能挡住——前者漏过去，一个空 realm 就能拿到控制权。
# 同时挡住「键缺失」（undefined，整条不成立）与「空串」（比较为假）。「键缺失」（undefined，整条不成立）与「空串」（比较为假），
# 所以这里不必再判存在性。
allow if {
  input.realm != ""
  input.actor != ""
  input.sessionRef != ""
  input.command in commands[input.role]
}

# 主体不完整：三项缺一即成立（同名规则多条 body 是**并**语义）。
#
# 为什么要 `not input.X` 与 `input.X == ""` 各写一条：rego 里**空串是真值**（只有
# false 与 undefined 为假），所以 `not ""` 为假——只写 `not input.X` 时，一个空
# realm 会漏到下面那条「角色未被授予该指令」上，把「主体没给全」误报成「权限不足」，
# 而这两种拒绝该找的人完全不同。反过来，只写 `== ""` 则漏掉键缺失。
incomplete_principal if { not input.realm }
incomplete_principal if { not input.actor }
incomplete_principal if { not input.sessionRef }
incomplete_principal if { input.realm == "" }
incomplete_principal if { input.actor == "" }
incomplete_principal if { input.sessionRef == "" }

# 拒绝理由：只在拒绝时定义。放行时 reason 未定义、不出现在 result 里，Go 侧也只在
# 拒绝时才读它。
#
# 写成一条规则加 else 链，而不是两条并列的规则：并列时若两个 body 同时成立，OPA 会报
# complete rule 冲突，整个查询变成错误——那会被 Go 侧归到 policy_unavailable，于是
# 一次普通的权限拒绝表现成「策略引擎坏了」，把排查引向完全错误的方向。
reason := "控制指令缺少完整主体（realm / actor / sessionRef）" if {
  not allow
  incomplete_principal
} else := "角色未被授予该指令（command 不在 commands[role] 内）" if {
  not allow
}
