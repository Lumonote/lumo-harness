package domain

import (
	"strings"
	"testing"
)

func TestValidateRuntimeSource(t *testing.T) {
	valid := SkillVersion{Content: "---\nname: repo-audit\ndescription: Audit a repository\nmodel_invocable: false\nuser_invocable: true\n---\n\nRead tests first.\n"}
	if err := valid.ValidateRuntimeSource("repo-audit"); err != nil {
		t.Fatalf("valid runtime source rejected: %v", err)
	}
	for _, tc := range []struct {
		name    string
		skill   string
		content string
		want    string
	}{
		{name: "invalid catalog name", skill: "Repo Audit", content: valid.Content, want: "kebab"},
		{name: "frontmatter name mismatch", skill: "other", content: valid.Content, want: "match"},
		{name: "missing description", skill: "repo-audit", content: "---\nname: repo-audit\n---\nbody", want: "description"},
		{name: "invalid invocation flag", skill: "repo-audit", content: strings.Replace(valid.Content, "model_invocable: false", "model_invocable: sometimes", 1), want: "model_invocable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := (SkillVersion{Content: tc.content}).ValidateRuntimeSource(tc.skill)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want substring %q", err, tc.want)
			}
		})
	}
}
