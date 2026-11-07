package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBusinessAlertSelectorsUseClosedVocabulary(t *testing.T) {
	emitted := map[string]bool{"lumo_business_requests_total": true}
	for _, tc := range []struct {
		name, labels string
		valid        bool
	}{
		{"exact", `operation="connector_invoke",outcome="unknown"`, true},
		{"finite-regex", `operation=~"session_execution_node|session_execution_lease",outcome="fenced"`, true},
		{"review", `operation="review_file_read",outcome=~"unavailable|not_found|conflict"`, true},
		{"misspelled-operation", `operation="connector_execute",outcome="unknown"`, false},
		{"misspelled-outcome", `operation="connector_invoke",outcome="unkown"`, false},
		{"wildcard", `operation=~".*",outcome="unknown"`, false},
		{"private-label", `operation="connector_invoke",realm="secret"`, false},
		{"empty-alternative", `operation="connector_invoke",outcome=~"unknown|"`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			problems := checkReferences([]expression{{where: tc.name, text: "lumo_business_requests_total{" + tc.labels + "}"}}, emitted, nil)
			if (len(problems) == 0) != tc.valid {
				t.Fatalf("valid=%v problems=%v", tc.valid, problems)
			}
		})
	}
}

func TestMetricWriterScannerFindsAtomicBusinessWrites(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "platform/control-plane/observability")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	source := `package observability
func wrapper(name string) { AddGaugeWithLabels(name, 1, nil) }
func actual() { AddGaugeWithLabels("lumo_business_requests_total", 1, nil) }
// AddGaugeWithLabels("lumo_comment_only", 1, nil)
`
	if err := os.WriteFile(filepath.Join(dir, "metrics.go"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	emitted, problems := loadEmitted(root)
	if len(problems) != 0 || !emitted["lumo_business_requests_total"] || emitted["lumo_comment_only"] || len(emitted) != 1 {
		t.Fatalf("incorrect writer scan: %v %v", emitted, problems)
	}
}

func TestBusinessAlertsArePresentAndCannotBeReplayed(t *testing.T) {
	root, err := resolveRoot("")
	if err != nil {
		t.Fatal(err)
	}
	if err := run(root, "", ""); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "platform/deploy/prometheus-alerts.yml")
	rules, _, problems := loadRules("test", path)
	if len(problems) != 0 {
		t.Fatal(problems)
	}
	present := map[string]bool{}
	for _, r := range rules {
		present[r.name] = true
	}
	for _, name := range []string{"LumoSessionExecutionFenced", "LumoReviewFileUnavailable", "LumoOwnedConnectorOutcomeUnknown"} {
		if !present[name] {
			t.Fatalf("missing %s", name)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), "不可自动重试或重置为可执行") {
		t.Fatal("unknown outcome runbook lost its no-replay instruction")
	}
}
