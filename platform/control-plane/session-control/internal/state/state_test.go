package state

import (
	"strings"
	"testing"
)

// expect 是一个组合的期望结果。三个字段显式写出来，**不从 Apply 反推**——
// 从被测对象反推期望值等于把测试变成「函数没变」的断言，而不是「函数是对的」的断言。
type expect struct {
	next State
	ok   bool
	noop bool
}

// transitionMatrix 是 §8.4.1 那张语义表的完整落点：5 个状态 × 8 条指令 = 40 个组合。
//
// 为什么用 map 而不是 []struct：下面 TestApplyCoversEveryCombination 会断言**每个组合
// 都有条目**。写成切片时，漏掉一行只是少测一个组合，测试照样全绿——本仓库对
// 「静默少测」有明确敌意（见 CI 上 DSN 门控静默跳过那件事），所以把「缺格」变成硬失败。
var transitionMatrix = map[State]map[Command]expect{
	StateRunning: {
		// running 下 pause/stop 作用在 turn 边界；abort 是会话级。
		CmdPause:   {StatePaused, true, false},
		CmdStop:    {StateStopped, true, false},
		CmdAbort:   {StateAborted, true, false},
		CmdReplay:  {StateRunning, true, false},  // 派生重放上下文，不动活状态
		CmdDegrade: {StateRunning, true, false},  // 收窄 scope/限流，不动活状态
		CmdResume:  {StateRunning, false, false}, // 已在运行
		CmdApprove: {StateRunning, false, false}, // 只在 awaiting-approval 可 approve
		CmdReject:  {StateRunning, false, false},
	},
	StatePaused: {
		// paused 再 pause 是**幂等无副作用**：重复点按钮不能把会话推到别处（§8.4.2）。
		CmdPause:   {StatePaused, true, true},
		CmdResume:  {StateRunning, true, false},
		CmdStop:    {StateStopped, true, false},
		CmdAbort:   {StateAborted, true, false},
		CmdReplay:  {StatePaused, true, false},
		CmdDegrade: {StatePaused, true, false},
		CmdApprove: {StatePaused, false, false},
		CmdReject:  {StatePaused, false, false},
	},
	StateAwaitingApproval: {
		// HITL 阻塞态：只有 approve/reject 能解出。其余一律拒绝——否则 turn 边界动作
		// 会与「等审批」叠加，状态无法解释（§8.4.1 的作用点区分）。
		CmdApprove: {StateRunning, true, false},
		CmdReject:  {StateRunning, true, false}, // 拒绝后回退到注入点并继续
		CmdAbort:   {StateAborted, true, false}, // 会话级硬取消可覆盖 HITL 阻塞
		CmdReplay:  {StateAwaitingApproval, true, false},
		CmdPause:   {StateAwaitingApproval, false, false},
		CmdResume:  {StateAwaitingApproval, false, false},
		CmdStop:    {StateAwaitingApproval, false, false},
		CmdDegrade: {StateAwaitingApproval, false, false},
	},
	StateStopped: {
		// stop 之后仍可 abort：先礼貌地 safe stop，随后仍能硬取消。
		CmdStop:    {StateStopped, true, true}, // 幂等
		CmdAbort:   {StateAborted, true, false},
		CmdReplay:  {StateStopped, true, false},
		CmdPause:   {StateStopped, false, false},
		CmdResume:  {StateStopped, false, false},
		CmdApprove: {StateStopped, false, false},
		CmdReject:  {StateStopped, false, false},
		CmdDegrade: {StateStopped, false, false},
	},
	StateAborted: {
		// aborted 是终态：除幂等 abort 与「重放一个已中止会话的场景」外全部拒绝。
		CmdAbort:   {StateAborted, true, true},
		CmdReplay:  {StateAborted, true, false},
		CmdPause:   {StateAborted, false, false},
		CmdResume:  {StateAborted, false, false},
		CmdStop:    {StateAborted, false, false},
		CmdApprove: {StateAborted, false, false},
		CmdReject:  {StateAborted, false, false},
		CmdDegrade: {StateAborted, false, false},
	},
}

// TestApplyCoversEveryCombination 先做计数守卫：40 个组合一个都不能少。
//
// 这条单独写在前面的理由很实际：下面那个测试是「遍历矩阵断言 Apply」，如果矩阵本身
// 少了几格，它会**安静地**通过——测的是「矩阵里的都对」，不是「该测的都测了」。
func TestApplyCoversEveryCombination(t *testing.T) {
	want := len(AllStates) * len(AllCommands)
	got := 0
	for _, s := range AllStates {
		row, ok := transitionMatrix[s]
		if !ok {
			t.Fatalf("状态 %q 在矩阵里没有整行——它的所有指令都没被测到", s)
		}
		for _, c := range AllCommands {
			if _, ok := row[c]; !ok {
				t.Fatalf("组合 (%s, %s) 在矩阵里缺格", s, c)
			}
			got++
		}
	}
	if got != want {
		t.Fatalf("矩阵覆盖 %d 个组合，期望 %d（状态数 %d × 指令数 %d）",
			got, want, len(AllStates), len(AllCommands))
	}
	// 反向：矩阵里也不许有多余的格子（状态/指令被删掉后残留的陈旧条目）。
	for s, row := range transitionMatrix {
		if !contains(AllStates, s) {
			t.Fatalf("矩阵里有未知状态 %q", s)
		}
		for c := range row {
			if !containsCommand(AllCommands, c) {
				t.Fatalf("矩阵 (%s, %s) 里的指令不在 AllCommands 中", s, c)
			}
		}
	}
}

// TestApplyMatchesSpecifiedMatrix 逐个断言 40 个组合。
func TestApplyMatchesSpecifiedMatrix(t *testing.T) {
	for _, s := range AllStates {
		for _, c := range AllCommands {
			t.Run(string(s)+"/"+string(c), func(t *testing.T) {
				want := transitionMatrix[s][c]
				got := Apply(s, c)
				if got.Next != want.next || got.OK != want.ok || got.NoOp != want.noop {
					t.Fatalf("Apply(%s, %s) = {next:%s ok:%v noop:%v}，期望 {next:%s ok:%v noop:%v}",
						s, c, got.Next, got.OK, got.NoOp, want.next, want.ok, want.noop)
				}
				// 被拒时必须给出可读原因：审计与错误响应都要靠它，空原因等于
				// 「操作失败了但没人知道为什么」。
				if !got.OK && strings.TrimSpace(got.Reason) == "" {
					t.Fatalf("Apply(%s, %s) 被拒但没有给出原因", s, c)
				}
				// 放行时 Reason 必须是空的：NoOp 已经单独表达「没有副作用」，
				// 再往 Reason 里塞句子会让「Reason 非空 = 被拒」这条判据失效。
				if got.OK && got.Reason != "" {
					t.Fatalf("Apply(%s, %s) 放行却带原因 %q（Reason 只用于拒绝）", s, c, got.Reason)
				}
			})
		}
	}
}

// TestApplyRejectsUnknownStateAndCommand 未知输入必须被拒，不能落到某个缺省分支上。
//
// 这一条防的是「新增了一个状态但忘了在 switch 里加分支」：Go 的 switch 会安静地穿过，
// 返回值恰好长得像一次正常跃迁。typo 一个状态名就会命中这里。
func TestApplyRejectsUnknownStateAndCommand(t *testing.T) {
	unknownState := Apply(State("paused "), CmdPause) // 尾随空格：最常见的复制粘贴 typo
	if unknownState.OK {
		t.Fatalf("未知状态不应放行，实际 %+v", unknownState)
	}
	if unknownState.Next != State("paused ") {
		t.Fatalf("未知状态被拒时应保持原状态，实际变成了 %q", unknownState.Next)
	}
	if !strings.Contains(unknownState.Reason, "paused ") {
		t.Fatalf("拒绝原因应点名未知状态，实际 %q", unknownState.Reason)
	}

	unknownCommand := Apply(StateRunning, Command("PAUSE"))
	if unknownCommand.OK {
		t.Fatalf("未知指令不应放行（大小写敏感：PAUSE ≠ pause），实际 %+v", unknownCommand)
	}
	if unknownCommand.Next != StateRunning {
		t.Fatalf("未知指令被拒时应保持原状态，实际 %q", unknownCommand.Next)
	}
}

// TestApplyIsDeterministic 同一输入反复调用必须给同一结果。
//
// 状态机是纯函数，所以这条本该显然成立——但「显然」正是它值得钉住的原因：一旦有人
// 为了性能把某处结果缓存进包级变量、或引入了时间/随机，这里会先红。
func TestApplyIsDeterministic(t *testing.T) {
	for _, s := range AllStates {
		for _, c := range AllCommands {
			first := Apply(s, c)
			for i := 0; i < 5; i++ {
				if again := Apply(s, c); again != first {
					t.Fatalf("Apply(%s, %s) 不稳定：第 %d 次返回 %+v，首次 %+v", s, c, i+2, again, first)
				}
			}
		}
	}
}

// TestAvailableCommandsAgreesWithApply 钉住「console 与写入路径同源」。
//
// 这是本服务里最值钱的一条约束：console 说「可点」而提交后被状态机拒绝，是运维最
// 无法自行诊断的一类不一致（重试也没用，因为两边都"没错"）。所以它必须由**同一个
// 纯函数**产出，而不是各写一份判断。这条测试是那个设计决定的守卫。
func TestAvailableCommandsAgreesWithApply(t *testing.T) {
	for _, s := range AllStates {
		available := AvailableCommands(s)
		if len(available) != len(AllCommands) {
			t.Fatalf("状态 %s：可用性列表 %d 条，期望 %d 条（少了指令就没法穷举展示）",
				s, len(available), len(AllCommands))
		}
		seen := make(map[Command]bool, len(available))
		for _, item := range available {
			if seen[item.Command] {
				t.Fatalf("状态 %s：指令 %s 在可用性列表里出现了两次", s, item.Command)
			}
			seen[item.Command] = true

			outcome := Apply(s, item.Command)
			if item.Available != outcome.OK {
				t.Fatalf("状态 %s 指令 %s：console 说 available=%v，Apply 说 ok=%v（两处判定漂移）",
					s, item.Command, item.Available, outcome.OK)
			}
			if item.NoOp != outcome.NoOp {
				t.Fatalf("状态 %s 指令 %s：console 说 noop=%v，Apply 说 noop=%v",
					s, item.Command, item.NoOp, outcome.NoOp)
			}
			if item.Available {
				want := "ok"
				if item.NoOp {
					want = "no-op"
				}
				if item.Reason != want {
					t.Fatalf("状态 %s 指令 %s：可用时原因应为 %q，实际 %q", s, item.Command, want, item.Reason)
				}
			} else if strings.TrimSpace(item.Reason) == "" || item.Reason == "ok" || item.Reason == "no-op" {
				t.Fatalf("状态 %s 指令 %s：不可用时必须给出具体原因，实际 %q", s, item.Command, item.Reason)
			}
		}
		if len(seen) != len(AllCommands) {
			t.Fatalf("状态 %s：可用性列表漏了指令（只覆盖 %d 条）", s, len(seen))
		}
	}
}

// TestStoppedOnlyEscalatesByAbortAndAbortedIsAbsorbing 钉住两个终态各自的**准确**性质。
//
// 这一条最初写成「stopped 与 aborted 都是终态、任何指令都不能改变状态」，然后被自己的
// 测试推翻了：§8.4.1 明写「stop 之后再 abort」——先礼貌地 safe stop，随后仍可硬取消。
// 所以 stopped 不是严格终态，而是「执行已终止、但更强的会话级动作仍可升级」：
//
//   - stopped：放行的只允许产生两种结果——留在 stopped（幂等 stop / replay），
//     或升到 aborted（且只允许由 abort 触发）。
//   - aborted：真终态（absorbing），任何指令都不许把它推到别的状态。
//
// 写成性质而不是逐格断言，是为了让「将来新增一条指令」时这里能自己说话：矩阵会给
// 「缺格」报错，而这条会指出「终态被打破了」，两者指向的问题不同。
func TestStoppedOnlyEscalatesByAbortAndAbortedIsAbsorbing(t *testing.T) {
	for _, c := range AllCommands {
		got := Apply(StateStopped, c)
		if !got.OK {
			continue
		}
		switch {
		case got.Next == StateStopped:
			if c != CmdStop && c != CmdReplay {
				t.Fatalf("stopped 上 %s 被放行且留在原状态，但它既不是幂等 stop 也不是 replay", c)
			}
		case got.Next == StateAborted && c == CmdAbort:
			// 唯一允许的升级路径。
		default:
			t.Fatalf("stopped 上 %s 产生了非法结果：next=%s", c, got.Next)
		}
	}

	// aborted 的吸收性：连被拒的指令也必须保持原状态（否则「终态」只是文案）。
	for _, c := range AllCommands {
		got := Apply(StateAborted, c)
		if got.Next != StateAborted {
			t.Fatalf("aborted 是终态，但 %s 把它推到了 %s", c, got.Next)
		}
		if !got.OK {
			continue
		}
		// 放行的只允许是幂等 abort（NoOp）与 replay。
		if !got.NoOp && c != CmdReplay {
			t.Fatalf("aborted 上 %s 被放行且非幂等——终态被打破了", c)
		}
	}
}

func contains(states []State, want State) bool {
	for _, s := range states {
		if s == want {
			return true
		}
	}
	return false
}

func containsCommand(commands []Command, want Command) bool {
	for _, c := range commands {
		if c == want {
			return true
		}
	}
	return false
}
