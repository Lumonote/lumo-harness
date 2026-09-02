package governedskills

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/bundle"
	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/objstore"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (fn roundTrip) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func source(name, version, content string) Source {
	return Source{SkillID: "skill-" + name, Name: name, Version: version, Digest: objstore.Digest([]byte(content)), Content: content}
}

func TestBuildProducesVerifiedBundleForPublishedSkills(t *testing.T) {
	review := "---\nname: review\ndescription: Review a change\nmodel_invocable: false\n---\n\nRead the diff.\n"
	audit := "---\nname: audit\ndescription: Audit a repository\n---\n\nRun the tests.\n"
	result, err := Build(Snapshot{Realm: "dev", Skills: []Source{source("review", "2.0.0", review), source("audit", "1.3.0", audit)}}, BuildConfig{
		ArtifactName: "governed-skills-dev", ArtifactVersion: "0.0.7", Publisher: "release-ci", Scopes: []string{"skills:use"},
	})
	if err != nil {
		t.Fatal(err)
	}
	parsedManifest, err := manifest.Parse(result.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	if parsedManifest.Kind != manifest.KindSkill || parsedManifest.PayloadDigest != objstore.Digest(result.Bundle) {
		t.Fatalf("manifest does not bind generated skill bundle: %+v", parsedManifest)
	}
	parsedBundle, err := bundle.Decode(result.Bundle)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := parsedBundle.Header.Bundle+"@"+parsedBundle.Header.Version, "governed-skills-dev@0.0.7"; got != want {
		t.Fatalf("bundle identity = %s, want %s", got, want)
	}
	if len(parsedBundle.Entries) != 3 || parsedBundle.Entries[1].Path != "skills/audit/SKILL.md" || parsedBundle.Entries[2].Path != "skills/review/SKILL.md" {
		t.Fatalf("unexpected deterministic entries: %+v", parsedBundle.Entries)
	}
}

func TestBuildCanReleaseAnEmptySnapshotToWithdrawLocalSkills(t *testing.T) {
	result, err := Build(Snapshot{Realm: "dev", Skills: []Source{}}, BuildConfig{
		ArtifactName: "governed-skills-dev", ArtifactVersion: "0.0.8", Publisher: "release-ci", Scopes: []string{"skills:use"},
	})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := bundle.Decode(result.Bundle)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Entries) != 1 || parsed.Entries[0].Path != "metadata/governed-skill-snapshot.json" {
		t.Fatalf("empty snapshot must retain only metadata: %+v", parsed.Entries)
	}
}

func TestBuildRejectsTamperedGovernanceSource(t *testing.T) {
	content := "---\nname: review\ndescription: Review a change\n---\nbody"
	tampered := source("review", "1.0.0", content)
	tampered.Content = content + " changed"
	_, err := Build(Snapshot{Realm: "dev", Skills: []Source{tampered}}, BuildConfig{
		ArtifactName: "governed-skills-dev", ArtifactVersion: "0.0.1", Publisher: "release-ci", Scopes: []string{"skills:use"},
	})
	if err == nil || !strings.Contains(err.Error(), "digest mismatch") {
		t.Fatalf("error = %v, want digest mismatch", err)
	}
}

func TestFetchBindsIdentityAndRealm(t *testing.T) {
	content := "---\nname: review\ndescription: Review a change\n---\nbody"
	want := Snapshot{Realm: "dev", Skills: []Source{source("review", "1.0.0", content)}}
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: roundTrip(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != "https://governance.test/v1/skills/runtime-snapshot" || request.Header.Get("Authorization") != "Bearer control-token" || request.Header.Get("X-Lumo-User") != "release-bot" || request.Header.Get("X-Lumo-Realm") != "dev" || request.Header.Get("X-Lumo-Roles") != "realm_admin" {
			t.Fatalf("unexpected Governance request: %s headers=%v", request.URL, request.Header)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
	})}
	got, err := Fetch(context.Background(), FetchConfig{GovernanceURL: "https://governance.test", Token: "control-token", Realm: "dev", UserID: "release-bot", Roles: "realm_admin", Client: client})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Skills) != 1 || got.Skills[0] != want.Skills[0] {
		t.Fatalf("snapshot = %+v, want %+v", got, want)
	}
}
