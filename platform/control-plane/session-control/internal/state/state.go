// Package state 是共享执行控制的状态机（§8.4.1 / §8.4.3）。
//
// 它是整个 session-control 服务的「单一事实源」：写入路径（控制器录取一条指令）
// 与只读投影面（console 判定某指令此时是否可用）都必须调用这里的同一个纯函数
// Apply，不允许各写一份判断逻辑——两份一旦漂移，UI 上「可点」的按钮提交后却被
// 状态机拒绝，是最难查的一类不一致。
//
// 设计上刻意做成纯函数、零依赖：输入当前状态 + 指令，输出目标状态 + 是否合法 +
// 可读原因。没有时间、没有锁、没有 IO，方便表驱动测试把「每个状态 × 每个指令」
// 一次性钉死。
package state

import "fmt"

// State 是会话在控制面视角下的执行状态。§8.4.3 列出 running/paused/awaiting-approval/
// aborted，这里补上 stopped（§8.4.1 的 safe stop 终态之一）。五个状态构成闭合集合。
type State string

const (
	StateRunning          State = "running"
	StatePaused           State = "paused"
	StateAwaitingApproval State = "awaiting-approval"
	StateStopped          State = "stopped"
	StateAborted          State = "aborted"
)

// Command 是 §8.4.1 的控制指令。三类作用点：
//   - turn 边界（作用于当前 turn）：pause / resume / stop
//   - 会话级（作用于整个 session）：abort / replay / degrade
//   - HITL 注入点：approve / reject
//
// 类型上不强行再拆子类型，但 Apply 的矩阵里作用点决定了「哪些状态能接收」——
// 这是 §8.4.1 反复强调的「pause/stop 是 turn 边界、abort 是会话语义，作用点不同」。
type Command string

const (
	CmdPause   Command = "pause"
	CmdResume  Command = "resume"
	CmdStop    Command = "stop"
	CmdAbort   Command = "abort"
	CmdApprove Command = "approve"
	CmdReject  Command = "reject"
	CmdReplay  Command = "replay"
	CmdDegrade Command = "degrade"
)

// AllStates / AllCommands 供测试与 console 枚举穷举，避免漏测某个组合。
var (
	AllStates = []State{
		StateRunning, StatePaused, StateAwaitingApproval, StateStopped, StateAborted,
	}
	AllCommands = []Command{
		CmdPause, CmdResume, CmdStop, CmdAbort, CmdApprove, CmdReject, CmdReplay, CmdDegrade,
	}
)

// Outcome 一次 Apply 的结果。
type Outcome struct {
	Next State
	OK   bool
	// NoOp 表示「合法，但不会改变任何东西」（终态的重复指令、挂起态重复 pause）。
	// 单独一个字段而不是塞进 Reason：Reason 的语义是「为什么被拒」，而这两件事在
	// 控制台上要显示成不同的东西——「已停止」和「点了没副作用」不是同一种反馈，
	// 混进一个字段后，UI 只能显示一句话，运维也读不出「这次点击生效了吗」。
	NoOp   bool
	Reason string // OK=false 时给出「为什么被拒」（写进审计 / 错误响应）
}

// Apply 纯函数：给定当前状态与指令，返回目标状态、是否合法、可读原因。
//
// 跃迁矩阵的取舍（务必与 §8.4.1 的作用点区分对齐）：
//   - pause/resume/stop 只作用于「turn 边界」：彼此及与 running/paused 之间转换；
//     stop 之后再 abort 允许——abort 是更强的会话级动作，可覆盖已 safe-stop 的会话。
//   - abort 是会话级硬取消：从任何非 aborted 状态都能进 aborted，且 aborted 对自身幂等
//     （重复 abort 不会把已中止的会话再「中止一次」）。
//   - awaiting-approval 是 HITL 阻塞态，只能由 approve/reject 解出（回到 running），
//     期间不接受 pause/resume/stop/degrade——避免两种控制语义叠加把状态搅乱。
//   - replay/degrade 不改变执行状态（replay 派生一个重放上下文；degrade 收窄 scope/限流），
//     因此 Apply 返回原状态；replay 从任何状态都允许，degrade 只允许在 running/paused
//     （会话还「活」着、且没在等 HITL 决议时收窄才有意义）。
func Apply(s State, c Command) Outcome {
	switch s {
	case StateRunning:
		return runningTransitions(c)
	case StatePaused:
		return pausedTransitions(c)
	case StateAwaitingApproval:
		return awaitingTransitions(c)
	case StateStopped:
		return stoppedTransitions(c)
	case StateAborted:
		return abortedTransitions(c)
	}
	return Outcome{Next: s, OK: false, Reason: fmt.Sprintf("未知状态 %q", s)}
}

func runningTransitions(c Command) Outcome {
	switch c {
	case CmdPause:
		return Outcome{Next: StatePaused, OK: true}
	case CmdStop:
		return Outcome{Next: StateStopped, OK: true}
	case CmdAbort:
		return Outcome{Next: StateAborted, OK: true}
	case CmdReplay:
		return Outcome{Next: StateRunning, OK: true} // 重放派生上下文，不动活状态
	case CmdDegrade:
		return Outcome{Next: StateRunning, OK: true} // 收窄 scope/限流，不动活状态
	case CmdResume:
		return Outcome{Next: StateRunning, OK: false, Reason: "会话正在运行，无需 resume"}
	case CmdApprove:
		return Outcome{Next: StateRunning, OK: false, Reason: "仅在 awaiting-approval 状态可 approve"}
	case CmdReject:
		return Outcome{Next: StateRunning, OK: false, Reason: "仅在 awaiting-approval 状态可 reject"}
	}
	return Outcome{Next: StateRunning, OK: false, Reason: fmt.Sprintf("running 不支持指令 %q", c)}
}

func pausedTransitions(c Command) Outcome {
	switch c {
	case CmdPause:
		// 幂等：已挂起的会话再 pause 不应报错，也不应改变任何东西——避免「重复点按钮」
		// 把会话从 paused 推到别处。这是 §8.4.2「一次申请一次生效」在状态层的同款约束。
		return Outcome{Next: StatePaused, OK: true, NoOp: true}
	case CmdResume:
		return Outcome{Next: StateRunning, OK: true}
	case CmdStop:
		return Outcome{Next: StateStopped, OK: true} // 把挂起的会话安全停掉，终态之一
	case CmdAbort:
		return Outcome{Next: StateAborted, OK: true}
	case CmdReplay:
		return Outcome{Next: StatePaused, OK: true}
	case CmdDegrade:
		return Outcome{Next: StatePaused, OK: true}
	case CmdApprove:
		return Outcome{Next: StatePaused, OK: false, Reason: "仅在 awaiting-approval 状态可 approve"}
	case CmdReject:
		return Outcome{Next: StatePaused, OK: false, Reason: "仅在 awaiting-approval 状态可 reject"}
	}
	return Outcome{Next: StatePaused, OK: false, Reason: fmt.Sprintf("paused 不支持指令 %q", c)}
}

func awaitingTransitions(c Command) Outcome {
	switch c {
	case CmdApprove:
		// 审批通过：从注入点继续，回到 running。
		return Outcome{Next: StateRunning, OK: true}
	case CmdReject:
		// 拒绝：回退到注入点后继续（§8.4.1），会话恢复 running。
		return Outcome{Next: StateRunning, OK: true}
	case CmdAbort:
		return Outcome{Next: StateAborted, OK: true} // 会话级硬取消可覆盖 HITL 阻塞
	case CmdReplay:
		return Outcome{Next: StateAwaitingApproval, OK: true}
	// 以下在 HITL 阻塞态一律拒绝：必须先把注入点用 approve/reject 解出，
	// 否则 turn 边界动作会与「等审批」叠加，状态无法解释。
	case CmdPause:
		return Outcome{Next: StateAwaitingApproval, OK: false, Reason: "awaiting-approval 是 HITL 阻塞态，先 approve/reject"}
	case CmdResume:
		return Outcome{Next: StateAwaitingApproval, OK: false, Reason: "awaiting-approval 是 HITL 阻塞态，先 approve/reject"}
	case CmdStop:
		return Outcome{Next: StateAwaitingApproval, OK: false, Reason: "awaiting-approval 期间不接受 stop，先 approve/reject"}
	case CmdDegrade:
		return Outcome{Next: StateAwaitingApproval, OK: false, Reason: "等待 HITL 决议，先 approve/reject"}
	}
	return Outcome{Next: StateAwaitingApproval, OK: false, Reason: fmt.Sprintf("awaiting-approval 不支持指令 %q", c)}
}

func stoppedTransitions(c Command) Outcome {
	switch c {
	case CmdStop:
		return Outcome{Next: StateStopped, OK: true, NoOp: true} // 幂等
	case CmdAbort:
		// abort 是更强的会话级动作，可覆盖安全停止——这是 §8.4.1「stop 之后再 abort」
		// 的语义落点：先礼貌地 safe stop，随后仍可硬取消。
		return Outcome{Next: StateAborted, OK: true}
	case CmdReplay:
		return Outcome{Next: StateStopped, OK: true}
	case CmdPause:
		return Outcome{Next: StateStopped, OK: false, Reason: "已 safe stop，无需 pause"}
	case CmdResume:
		return Outcome{Next: StateStopped, OK: false, Reason: "已停止，恢复请走 replay/recreate"}
	case CmdApprove:
		return Outcome{Next: StateStopped, OK: false, Reason: "已停止，无 HITL 待决议"}
	case CmdReject:
		return Outcome{Next: StateStopped, OK: false, Reason: "已停止，无 HITL 待决议"}
	case CmdDegrade:
		return Outcome{Next: StateStopped, OK: false, Reason: "已停止，无需 degrade"}
	}
	return Outcome{Next: StateStopped, OK: false, Reason: fmt.Sprintf("stopped 不支持指令 %q", c)}
}

func abortedTransitions(c Command) Outcome {
	switch c {
	case CmdAbort:
		return Outcome{Next: StateAborted, OK: true, NoOp: true} // 幂等：终态
	case CmdReplay:
		return Outcome{Next: StateAborted, OK: true} // 重放一个已中止会话的场景仍可构造
	// aborted 是终态：任何会改变执行的控制都被拒，避免「已中止的会话又被操作」的不一致。
	case CmdPause:
		return Outcome{Next: StateAborted, OK: false, Reason: "会话已 aborted（终态）"}
	case CmdResume:
		return Outcome{Next: StateAborted, OK: false, Reason: "会话已 aborted（终态）"}
	case CmdStop:
		return Outcome{Next: StateAborted, OK: false, Reason: "会话已 aborted（终态）"}
	case CmdApprove:
		return Outcome{Next: StateAborted, OK: false, Reason: "会话已 aborted（终态）"}
	case CmdReject:
		return Outcome{Next: StateAborted, OK: false, Reason: "会话已 aborted（终态）"}
	case CmdDegrade:
		return Outcome{Next: StateAborted, OK: false, Reason: "会话已 aborted（终态）"}
	}
	return Outcome{Next: StateAborted, OK: false, Reason: fmt.Sprintf("aborted 不支持指令 %q", c)}
}

// Available 是 console 投影面里「某指令此时是否可用」的单项。
//
// 带 json tag：这个类型会**原样进 HTTP 响应**。没有 tag 时 encoding/json 用 Go 字段名
// （首字母大写），控制台按 "command" 取出来全是 nil，而 Go 侧测试看不见这件事——
// 断言结构体字段和断言 JSON 键是两回事。
type Available struct {
	Command   Command `json:"command"`
	Available bool    `json:"available"`
	// NoOp 为 true 时该指令可用但没有效果（终态重复指令等）。控制台据此把按钮渲染成
	// 「可点但无变化」，而不是让运维以为点下去会发生什么。
	NoOp   bool   `json:"no_op"`
	Reason string `json:"reason"` // 不可用时是原因；可用时是 "ok" / "no-op"
}

// AvailableCommands 返回当前状态下每个指令的可用性与原因。
// 它直接复用 Apply——console 与写入路径因此不可能漂移。
func AvailableCommands(s State) []Available {
	out := make([]Available, 0, len(AllCommands))
	for _, c := range AllCommands {
		o := Apply(s, c)
		reason := o.Reason
		if o.OK && reason == "" {
			reason = "ok"
			if o.NoOp {
				reason = "no-op"
			}
		}
		out = append(out, Available{Command: c, Available: o.OK, NoOp: o.NoOp, Reason: reason})
	}
	return out
}
