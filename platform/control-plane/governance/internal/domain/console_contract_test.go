package domain

import (
	"encoding/json"
	"testing"
)

// 运维面的「意图契约 / 子任务进度 / 执行证据」三块面板是按字段名读 JSON 的。
// 消费方：platform/dsh-plugins/lumo-ui/src/client/cluster-panels.tsx 里的
// TaskIntentFacts / TaskCollaborationFacts / TaskResultFacts。
//
// Go 与 TypeScript 之间没有编译期约束：改掉一个 json tag，这里照样编译通过，
// 面板不会报错，只是把值读成 undefined 然后显示「未记录」。这个测试把那条
// 口头契约钉成断言。
//
// 它防的是**无意改名**，不防「有意改协议」—— 真要改协议，就同步改面板再改这里。
func TestConsolePanelsReadTheKeysTheseStructsEmit(t *testing.T) {
	progress := CollaborationProgress{
		Task: DelegatedTask{
			ID: "task-1", Realm: "realm-1", Title: "复核合同", Intent: "复核华东客户合同",
			RequesterUserID: "user-boss", AssigneeUserID: "user-employee", AssigneeWorkerID: "user:user-employee",
			AssigneeName: "张工",
			RequiredTags: []string{"华东"}, InferredTags: []string{"客户"},
			RequiredSkills: []string{"合同复核"}, InferredSkills: []string{"合同"}, SelectedSkills: []string{"合同复核"},
			State: DelegationRunning, BusinessState: BusinessAssigned, ConfidenceBand: "AUTO",
			MatchScore: 87, Rationale: []string{"标签命中 华东"},
			IntentContract: &IntentContract{
				ParentTaskID: "task-0", Objective: "复核合同", Constraints: []string{"不得外发"},
				AcceptanceCriteria: []string{"标出高风险条款"}, RootObjective: "合规交付", Depth: 1,
			},
			Schedule: json.RawMessage(`{"queue":"delegated","residency":"cn-east"}`),
		},
		Children: []ChildTaskProgress{{
			Task: DelegatedTask{ID: "task-2", Realm: "realm-1", Title: "子任务", Intent: "拆解", State: DelegationCompleted},
			Run: &TaskRun{
				ID: "run-1", Realm: "realm-1", TaskID: "task-2", Attempt: 1,
				WorkerID: "user:user-employee", AssignedNodeID: "device-a", State: DelegationCompleted,
			},
			Result: &TaskResult{
				TaskID: "task-2", RunID: "run-1", State: DelegationCompleted, SessionRef: "session-1",
				NodeID: "device-a", Summary: "已完成", Output: json.RawMessage(`{"risk":0}`),
			},
		}},
		Summary: CollaborationSummary{Total: 1, Accepted: 1},
		HasMore: false,
	}

	top := objectOf(t, progress)
	requireKeys(t, "CollaborationProgress", top, "task", "children", "summary", "has_more")

	task := objectOf(t, top["task"])
	requireKeys(t, "collaboration.task", task,
		"id", "title", "intent", "state", "business_state", "match_score", "confidence_band",
		"assignee_name", "assignee_worker_id", "required_tags", "inferred_tags",
		"required_skills", "inferred_skills", "selected_skills", "rationale",
		"intent_contract", "schedule")
	requireKeys(t, "collaboration.task.intent_contract", objectOf(t, task["intent_contract"]),
		"objective", "constraints", "acceptance_criteria", "root_objective", "depth", "parent_task_id")

	// schedule 是原始 JSON 快照。它一旦变成被序列化过的字符串，面板的
	// 「调度约束快照」就会渲染成一整块带转义的引号文本，而不是可读的 JSON。
	if _, ok := task["schedule"].(map[string]any); !ok {
		t.Errorf("collaboration.task.schedule must stay raw JSON, got %#v", task["schedule"])
	}

	requireKeys(t, "collaboration.summary", objectOf(t, top["summary"]),
		"total", "active", "awaiting_review", "accepted", "needs_attention", "unresolved")

	children, ok := top["children"].([]any)
	if !ok || len(children) != 1 {
		t.Fatalf("collaboration.children must be a one-element array, got %#v", top["children"])
	}
	child := objectOf(t, children[0])
	requireKeys(t, "collaboration.children[0]", child, "task", "run", "result")
	requireKeys(t, "collaboration.children[0].run", objectOf(t, child["run"]), "id", "attempt", "state")
	requireKeys(t, "collaboration.children[0].result", objectOf(t, child["result"]),
		"run_id", "state", "session_ref", "node_id", "summary", "output", "created_at")
}

// objectOf 走一遍真实的编码路径再取键，避免测试自己维护一份字段名清单。
func objectOf(t *testing.T, value any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %T: %v", value, err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal %T: %v", value, err)
	}
	return decoded
}

func requireKeys(t *testing.T, label string, object map[string]any, keys ...string) {
	t.Helper()
	for _, key := range keys {
		if _, ok := object[key]; !ok {
			t.Errorf("%s is missing JSON key %q; the console panel reads it by name", label, key)
		}
	}
}
