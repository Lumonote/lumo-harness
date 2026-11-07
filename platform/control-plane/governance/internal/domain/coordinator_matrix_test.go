package domain

import (
	"encoding/json"
	"os"
	"testing"
)

func TestCoordinatorCrossLanguageMatrix(t *testing.T) {
	raw, err := os.ReadFile("../../../../shared/seam-contracts/__tests__/fixtures/coordinator-review-matrix.json")
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct {
		Source string `json:"source"`
		Review []struct {
			Facts   ReviewerFacts   `json:"facts"`
			Verdict ReviewerVerdict `json:"verdict"`
		} `json:"review"`
		Integration []struct {
			Facts   IntegrationGateFacts `json:"facts"`
			Verdict IntegrationVerdict   `json:"verdict"`
		} `json:"integration"`
	}
	if err := json.Unmarshal(raw, &matrix); err != nil {
		t.Fatal(err)
	}
	if matrix.Source != "platform/shared/seam-contracts/__tests__/coordinator-matrix.spec.ts" || len(matrix.Review) != 2164 || len(matrix.Integration) != 4 {
		t.Fatal("missing or truncated cross-language matrix")
	}
	for i, row := range matrix.Review {
		if got := ReviewerEligibility(row.Facts); got != row.Verdict {
			t.Errorf("review row %d: facts=%+v Go=%+v TS=%+v", i, row.Facts, got, row.Verdict)
		}
	}
	for i, row := range matrix.Integration {
		if got := IntegrationGate(row.Facts); got != row.Verdict {
			t.Errorf("integration row %d: Go=%s TS=%s", i, got, row.Verdict)
		}
	}
}
