package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func repoSnapshot() RepositorySnapshot {
	return RepositorySnapshot{Repository: "org/repo", BaseCommit: strings.Repeat("a", 40), BaseBranch: "main", Files: []RepositoryFile{{Path: "src/report.ts", Text: "old\n"}, {Path: "README.md", Text: "retained\n"}}}
}
func TestRepositoryManifestEnumeratesAuthorityBeforeAfterAndExactPatch(t *testing.T) {
	s := repoSnapshot()
	r := TaskResult{TaskID: "task", RunID: "run", Summary: "change", Output: json.RawMessage(`[{"type":"text","text":"done"}]`), RepositoryFiles: []RepositoryFile{{Path: "README.md", Text: "retained\n"}, {Path: "src/report.ts", Text: "new\n"}}}
	m, files, err := BuildRepositoryManifest(r, s)
	if err != nil || m.Scope != ClosedRepositoryOutputProfile || len(files) != 1 || m.Repository == nil {
		t.Fatalf("manifest %+v %v", m, err)
	}
	var change RepositoryChange
	if err = json.Unmarshal([]byte(files[0].Text), &change); err != nil {
		t.Fatal(err)
	}
	if change.Before != "old\n" || change.After != "new\n" || change.Patch != "--- a/src/report.ts\n+++ b/src/report.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n" || change.BeforeSHA256 == change.AfterSHA256 {
		t.Fatalf("unbound change %+v", change)
	}
	r.RepositoryFiles = r.RepositoryFiles[:1]
	if _, _, err = BuildRepositoryManifest(r, s); err == nil {
		t.Fatal("omitted approved file accepted")
	}
}
func TestRepositoryScopeRejectsUnsafePathsSourcesAndUnchangedSets(t *testing.T) {
	for _, path := range []string{"../escape", ".git/config", "safe/.git/hooks/run", "safe/hooks/run", "src//file", "src/../file", "link\\file", "/absolute", "src/node_modules/package"} {
		if RepositoryPathAllowed(path) {
			t.Fatalf("unsafe path accepted %q", path)
		}
	}
	s := repoSnapshot()
	s.Files[0].Text = strings.Repeat("x", MaxRepositoryFileBytes+1)
	if s.Validate() == nil {
		t.Fatal("oversize accepted")
	}
	s = repoSnapshot()
	s.Files[0].Text = "invalid\x00"
	if s.Validate() == nil {
		t.Fatal("binary text accepted")
	}
	s = repoSnapshot()
	r := TaskResult{TaskID: "task", RunID: "run", Summary: "unchanged", Output: json.RawMessage(`[{"type":"text","text":"done"}]`), RepositoryFiles: s.Files}
	if _, _, err := BuildRepositoryManifest(r, s); err == nil {
		t.Fatal("no-op repository change accepted")
	}
}
