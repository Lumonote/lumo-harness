package domain

import (
	"fmt"
	"strings"
)

// IntentContract preserves the superior's objective separately from execution
// details. Structured input is explicit; raw prose is never claimed to be an
// LLM-verified plan. A descendant can add constraints but cannot remove inherited
// ones. Depth and root objective are server-authored provenance.
type IntentContract struct {
	ParentTaskID       string   `json:"parent_task_id,omitempty"`
	Objective          string   `json:"objective"`
	Constraints        []string `json:"constraints"`
	AcceptanceCriteria []string `json:"acceptance_criteria"`
	RootObjective      string   `json:"root_objective"`
	Depth              int      `json:"depth"`
}

func NormalizeIntent(raw string, input *IntentContract) (IntentContract, error) {
	contract := IntentContract{Objective: strings.TrimSpace(raw)}
	if input != nil {
		contract = *input
		contract.Objective = strings.TrimSpace(input.Objective)
		if contract.Objective == "" {
			contract.Objective = strings.TrimSpace(raw)
		}
		contract.ParentTaskID = strings.TrimSpace(input.ParentTaskID)
	}
	if contract.Objective == "" || len([]rune(contract.Objective)) > 8000 || len(contract.ParentTaskID) > 160 {
		return IntentContract{}, fmt.Errorf("objective must contain 1-8000 characters; parent task id is limited to 160 bytes")
	}
	for _, values := range [][]string{contract.Constraints, contract.AcceptanceCriteria} {
		if len(values) > 32 {
			return IntentContract{}, fmt.Errorf("at most 32 constraints or acceptance criteria are allowed")
		}
		for _, value := range values {
			if strings.TrimSpace(value) == "" || len([]rune(value)) > 2000 {
				return IntentContract{}, fmt.Errorf("constraints and acceptance criteria must contain 1-2000 characters")
			}
		}
	}
	contract.Constraints = normalizedIntentItems(contract.Constraints)
	contract.AcceptanceCriteria = normalizedIntentItems(contract.AcceptanceCriteria)
	contract.RootObjective, contract.Depth = contract.Objective, 0
	return contract, nil
}

func normalizedIntentItems(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range uniqueFold(values) {
		out = append(out, strings.TrimSpace(value))
	}
	return out
}

func InheritIntent(child IntentContract, parent IntentContract) (IntentContract, error) {
	if parent.Depth >= 8 {
		return IntentContract{}, fmt.Errorf("delegation depth exceeds 8")
	}
	child.Constraints = normalizedIntentItems(append(append([]string{}, parent.Constraints...), child.Constraints...))
	if len(child.Constraints) > 32 {
		return IntentContract{}, fmt.Errorf("inherited constraints exceed 32")
	}
	child.Depth, child.RootObjective = parent.Depth+1, parent.RootObjective
	if child.RootObjective == "" {
		child.RootObjective = parent.Objective
	}
	return child, nil
}

// Analysis signals incomplete briefing without inventing requirements from
// keywords. Existing unstructured requests remain accepted for compatibility.
type IntentAnalysis struct {
	Method         string         `json:"method"`
	Contract       IntentContract `json:"contract"`
	Clarification  []string       `json:"clarification"`
	ReadyForReview bool           `json:"ready_for_review"`
}

func AnalyzeIntent(contract IntentContract) IntentAnalysis {
	result := IntentAnalysis{Method: "explicit-contract-and-governed-keywords", Contract: contract, Clarification: []string{}}
	if len(contract.AcceptanceCriteria) == 0 {
		result.Clarification = append(result.Clarification, "请明确交付物和可核验的验收标准")
	}
	result.ReadyForReview = len(contract.AcceptanceCriteria) > 0
	return result
}
