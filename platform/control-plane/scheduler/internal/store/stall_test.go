package store

import (
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// TestActiveStatesMirrorsDomainActive 是这一层最关键的结构守卫。
//
// ActiveStates() 决定「哪些状态会被停滞收割看见」。它与 domain.TaskState.Active()
// 是同一件事的两份写法，编译器不会把它们联系起来：往状态机里加一个活跃态、
// 忘了同步这里，那个状态的任务就永远不会被判定停滞——槽位泄漏，而且**没有任何
// 迹象**，因为收割循环看起来一直在正常跑。所以这里逐个状态对照。
func TestActiveStatesMirrorsDomainActive(t *testing.T) {
	all := []domain.TaskState{
		domain.StatePending, domain.StatePlaced, domain.StateRunning, domain.StateCancelling,
		domain.StateCompleted, domain.StateFailed, domain.StateAborted,
	}
	listed := make(map[string]bool, len(ActiveStates()))
	for _, state := range ActiveStates() {
		listed[state] = true
	}
	if len(ActiveStates()) == 0 {
		t.Fatal("活跃态集合为空——收割循环会看不见任何任务，而它看起来仍在正常跑")
	}
	for _, state := range all {
		want := state.Active()
		got := listed[string(state)]
		if want != got {
			t.Fatalf("状态 %s：domain.Active()=%v，但 ActiveStates() 里%s。"+
				"两侧脱节会让该状态的任务永远不被收割（槽位泄漏）或把不该动的任务收掉",
				state, want, map[bool]string{true: "在", false: "不在"}[got])
		}
	}
	// 反向：集合里不能有 domain 不认识的名字（拼错的状态名在 SQL 里只是选不到行）。
	known := make(map[string]bool, len(all))
	for _, state := range all {
		known[string(state)] = true
	}
	for _, state := range ActiveStates() {
		if !known[state] {
			t.Fatalf("ActiveStates() 里有 domain 不认识的状态 %q——在 SQL 里它只是永远选不到行", state)
		}
	}
}

// TestActiveAndTerminalStatesPartitionTheStateMachine 三组状态必须恰好覆盖状态机：
// PENDING ∪ 活跃 ∪ 终态 = 全部，且两两不相交。
//
// 漏掉一个状态的后果是它在指标上静默消失、在收割里静默不可见；重叠的后果是
// 同一个任务同时被算作「该收割」和「已终结」。
func TestActiveAndTerminalStatesPartitionTheStateMachine(t *testing.T) {
	all := []domain.TaskState{
		domain.StatePending, domain.StatePlaced, domain.StateRunning, domain.StateCancelling,
		domain.StateCompleted, domain.StateFailed, domain.StateAborted,
	}
	seen := map[string]int{}
	for _, state := range append([]string{string(domain.StatePending)}, ActiveStates()...) {
		seen[state]++
	}
	for _, state := range TerminalStates() {
		seen[state]++
	}
	for _, state := range all {
		switch seen[string(state)] {
		case 1:
		case 0:
			t.Fatalf("状态 %s 没有被任何一组覆盖——它会在指标与收割里同时静默消失", state)
		default:
			t.Fatalf("状态 %s 被 %d 组同时覆盖——分组重叠", state, seen[string(state)])
		}
	}
	if len(seen) != len(all) {
		t.Fatalf("分组里出现了 domain 不认识的状态名：%v", seen)
	}
}
