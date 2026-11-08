package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const ClosedRepositoryOutputProfile = "platform-closed-repository-v1"
const MaxRepositoryFiles = 8
const MaxRepositoryFileBytes = 3072

type RepositoryFile struct {
	Path string `json:"path"`
	Text string `json:"text"`
}
type RepositorySnapshot struct {
	Repository string           `json:"repository"`
	BaseCommit string           `json:"base_commit"`
	BaseBranch string           `json:"base_branch"`
	Files      []RepositoryFile `json:"files"`
}
type RepositoryIdentity struct {
	Repository     string `json:"repository"`
	BaseCommit     string `json:"base_commit"`
	BaseBranch     string `json:"base_branch"`
	SnapshotDigest string `json:"snapshot_digest"`
}
type RepositoryChange struct {
	Path         string `json:"path"`
	BeforeSHA256 string `json:"before_sha256"`
	AfterSHA256  string `json:"after_sha256"`
	Before       string `json:"before"`
	After        string `json:"after"`
	Patch        string `json:"patch"`
}

var repositoryPath = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$`)
var repositoryName = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
var commitHash = regexp.MustCompile(`^[a-f0-9]{40}$`)

func RepositoryPathAllowed(path string) bool {
	if !repositoryPath.MatchString(path) || strings.Contains(path, "//") {
		return false
	}
	for _, p := range strings.Split(path, "/") {
		if p == "" || p == "." || p == ".." || strings.HasPrefix(p, ".") || strings.EqualFold(p, "hooks") || strings.EqualFold(p, "node_modules") {
			return false
		}
	}
	return true
}
func ValidateRepositoryFiles(files []RepositoryFile) error {
	if len(files) < 1 || len(files) > MaxRepositoryFiles {
		return fmt.Errorf("repository snapshot requires 1..8 approved files")
	}
	seen := map[string]bool{}
	for _, file := range files {
		path := strings.ToLower(file.Path)
		if !RepositoryPathAllowed(file.Path) || seen[path] || !utf8.ValidString(file.Text) || len(file.Text) > MaxRepositoryFileBytes {
			return fmt.Errorf("repository file path, identity or byte bound is invalid")
		}
		for _, r := range file.Text {
			if r < 32 && r != '\n' && r != '\r' && r != '\t' || r == 127 {
				return fmt.Errorf("repository files require plain UTF-8 text")
			}
		}
		seen[path] = true
	}
	return nil
}
func (s RepositorySnapshot) Validate() error {
	if !repositoryName.MatchString(s.Repository) || !commitHash.MatchString(s.BaseCommit) || !repositoryPath.MatchString(s.BaseBranch) || strings.Contains(s.BaseBranch, "..") || strings.HasPrefix(s.BaseBranch, "-") {
		return fmt.Errorf("repository snapshot requires an approved repository, branch and exact base commit")
	}
	return ValidateRepositoryFiles(s.Files)
}
func RepositorySnapshotDigest(s RepositorySnapshot) (string, error) {
	if err := s.Validate(); err != nil {
		return "", err
	}
	files := append([]RepositoryFile(nil), s.Files...)
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	s.Files = files
	raw, _ := json.Marshal(s)
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:]), nil
}
func repoSHA(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func repoLines(s, prefix string) string {
	if s == "" {
		return ""
	}
	parts := strings.SplitAfter(s, "\n")
	out := ""
	for _, line := range parts {
		if line == "" {
			continue
		}
		out += prefix + line
		if !strings.HasSuffix(line, "\n") {
			out += "\n\\ No newline at end of file\n"
		}
	}
	return out
}
func RepositoryPatch(path, before, after string) string {
	count := func(s string) int {
		if s == "" {
			return 0
		}
		return strings.Count(s, "\n") + boolInt(!strings.HasSuffix(s, "\n"))
	}
	start := func(s string) int {
		if s == "" {
			return 0
		}
		return 1
	}
	return fmt.Sprintf("--- a/%s\n+++ b/%s\n@@ -%d,%d +%d,%d @@\n", path, path, start(before), count(before), start(after), count(after)) + repoLines(before, "-") + repoLines(after, "+")
}
func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// All paths and before bytes come from the frozen service-owned snapshot. The
// runtime supplies its complete final file set; it cannot choose the diff list.
func BuildRepositoryManifest(result TaskResult, snapshot RepositorySnapshot) (RunOutputManifest, []RunTextFile, error) {
	manifest, _, err := BuildRunOutputManifest(result)
	if err != nil {
		return manifest, nil, err
	}
	digest, err := RepositorySnapshotDigest(snapshot)
	if err != nil {
		return manifest, nil, err
	}
	if err = ValidateRepositoryFiles(result.RepositoryFiles); err != nil {
		return manifest, nil, err
	}
	if len(result.RepositoryFiles) != len(snapshot.Files) {
		return manifest, nil, fmt.Errorf("complete approved repository file set required")
	}
	after := map[string]string{}
	for _, file := range result.RepositoryFiles {
		after[file.Path] = file.Text
	}
	base := append([]RepositoryFile(nil), snapshot.Files...)
	sort.Slice(base, func(i, j int) bool { return base[i].Path < base[j].Path })
	generated := []RunTextFile{}
	for _, file := range base {
		text, ok := after[file.Path]
		if !ok {
			return manifest, nil, fmt.Errorf("approved repository path missing")
		}
		if text == file.Text {
			continue
		}
		change := RepositoryChange{Path: file.Path, BeforeSHA256: repoSHA(file.Text), AfterSHA256: repoSHA(text), Before: file.Text, After: text, Patch: RepositoryPatch(file.Path, file.Text, text)}
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err = enc.Encode(change); err != nil {
			return manifest, nil, err
		}
		generated = append(generated, RunTextFile{Name: fmt.Sprintf("repo-change-%04d.json", len(generated)+1), MediaType: "application/json", Text: buf.String()})
	}
	if err = ValidateRunTextFiles(generated); err != nil {
		return manifest, nil, err
	}
	copy := result
	copy.Files = generated
	manifest, _, err = BuildRunTextFilesManifest(copy)
	manifest.Scope = ClosedRepositoryOutputProfile
	manifest.Repository = &RepositoryIdentity{Repository: snapshot.Repository, BaseCommit: snapshot.BaseCommit, BaseBranch: snapshot.BaseBranch, SnapshotDigest: digest}
	return manifest, generated, err
}
