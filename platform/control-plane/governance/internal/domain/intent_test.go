package domain

import (
	"strings"
	"testing"
)

func TestIntentKeepsRootAndInheritedConstraints(t *testing.T) {
	root, err := NormalizeIntent("root objective", &IntentContract{Constraints: []string{" keep data in realm ", "keep data in realm"}, RootObjective: "forged", Depth: 7})
	if err != nil {
		t.Fatal(err)
	}
	if root.RootObjective != "root objective" || root.Depth != 0 || len(root.Constraints) != 1 {
		t.Fatalf("root = %#v", root)
	}
	child, err := NormalizeIntent("deliver analysis", &IntentContract{ParentTaskID: "root", Constraints: []string{"read only"}, AcceptanceCriteria: []string{"two cited findings"}})
	if err != nil {
		t.Fatal(err)
	}
	child, err = InheritIntent(child, root)
	if err != nil {
		t.Fatal(err)
	}
	grandchild, err := InheritIntent(IntentContract{Objective: "gather sources", ParentTaskID: "child"}, child)
	if err != nil {
		t.Fatal(err)
	}
	if grandchild.Depth != 2 || grandchild.RootObjective != root.Objective || len(grandchild.Constraints) != 2 {
		t.Fatalf("grandchild = %#v", grandchild)
	}
	grandchild.Constraints[0] = "mutated"
	if root.Constraints[0] != "keep data in realm" || child.Constraints[0] != root.Constraints[0] {
		t.Fatal("inheritance aliases ancestor constraints")
	}
	if !AnalyzeIntent(child).ReadyForReview || AnalyzeIntent(root).ReadyForReview {
		t.Fatal("review readiness must depend on explicit acceptance criteria")
	}
}

func TestIntentRejectsInvalidAndExcessiveDelegation(t *testing.T) {
	for _, input := range []*IntentContract{
		{Objective: " "}, {Objective: strings.Repeat("x", 8001)},
		{Objective: "ok", Constraints: []string{" "}},
		{Objective: "ok", AcceptanceCriteria: make([]string, 33)},
	} {
		if _, err := NormalizeIntent("", input); err == nil {
			t.Fatalf("accepted %#v", input)
		}
	}
	if _, err := InheritIntent(IntentContract{}, IntentContract{Depth: 8}); err == nil {
		t.Fatal("unbounded delegation")
	}
}

func TestTaskResultRequiresTerminalStateAndEvidence(t *testing.T) {
	valid := TaskResult{TaskID: "task", RunID: "run", State: DelegationCompleted, SessionRef: "session", Summary: "Completed analysis"}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*TaskResult){
		func(r *TaskResult) { r.State = DelegationRunning },
		func(r *TaskResult) { r.SessionRef = "" },
		func(r *TaskResult) { r.Summary = "" },
		func(r *TaskResult) { r.Output = []byte(`{broken`) },
	} {
		bad := valid
		mutate(&bad)
		if err := bad.Validate(); err == nil {
			t.Fatalf("accepted %#v", bad)
		}
	}
}
