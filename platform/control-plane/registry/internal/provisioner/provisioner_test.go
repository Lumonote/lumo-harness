package provisioner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/registry/internal/bundle"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/plan"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestInstallVerifiesDigestAndPublishesState(t *testing.T) {
	raw := []byte(`{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"demo-skill","version":"1.0.0","publisher":"acme","scopes":["kb:query"]}`)
	digest := objstore.Digest(raw)
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/v1/plan" {
			return response(http.StatusOK, `{"root":"demo-skill@1.0.0","items":[{"name":"demo-skill","version":"1.0.0","digest":"`+digest+`"}]}`), nil
		}
		if r.URL.Path == "/v1/blobs/"+digest {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(raw))), Header: make(http.Header)}, nil
		}
		return response(http.StatusNotFound, "{}"), nil
	})}
	dir := t.TempDir()
	i := New("http://registry", dir)
	i.Client = client
	state, err := i.Install(context.Background(), "demo-skill", "1.0.0", plan.Shape{Object: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Installed) != 1 {
		t.Fatalf("installed = %+v", state.Installed)
	}
	installed, err := os.ReadFile(filepath.Join(dir, "demo-skill", "1.0.0", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(installed) != string(raw) {
		t.Fatalf("installed bytes changed: %s", installed)
	}
	if _, err := os.Stat(filepath.Join(dir, installStateFile)); err != nil {
		t.Fatal(err)
	}
}

func TestInstallRejectsDigestMismatch(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/v1/plan" {
			return response(http.StatusOK, `{"root":"demo-skill@1.0.0","items":[{"name":"demo-skill","version":"1.0.0","digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}]}`), nil
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("tampered")), Header: make(http.Header)}, nil
	})}
	i := New("http://registry", t.TempDir())
	i.Client = client
	if _, err := i.Install(context.Background(), "demo-skill", "1.0.0", plan.Shape{}); err == nil || !strings.Contains(err.Error(), "digest 不匹配") {
		t.Fatalf("err = %v", err)
	}
}

func TestInstallStateJSONLZstdRoundTrip(t *testing.T) {
	want := &InstallState{
		Root:        "demo-skill@1.0.0",
		InstalledAt: time.Date(2026, 8, 28, 5, 0, 0, 0, time.UTC),
		Installed:   []Item{{Name: "demo-skill", Version: "1.0.0", Digest: objstore.Digest([]byte("demo")), Path: "/tmp/demo"}},
	}
	raw, err := encodeInstallState(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeInstallState(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.Root != want.Root || !got.InstalledAt.Equal(want.InstalledAt) || len(got.Installed) != 1 || got.Installed[0] != want.Installed[0] {
		t.Fatalf("round trip = %+v", got)
	}
}

func TestReportPublishesOnlyVerifiedInstallationFacts(t *testing.T) {
	var got struct {
		NodeID    string `json:"node_id"`
		State     string `json:"state"`
		Root      string `json:"root"`
		Installed []struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Digest  string `json:"digest"`
		} `json:"installed"`
	}
	i := New("http://registry", t.TempDir())
	i.NodeID = "cluster-a.dsh-0"
	i.ControlPlaneToken = "control-token"
	i.Client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/v1/installations" || r.Method != http.MethodPost {
			return response(http.StatusNotFound, "{}"), nil
		}
		if r.Header.Get("Authorization") != "Bearer control-token" {
			return response(http.StatusUnauthorized, "{}"), nil
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			return nil, err
		}
		return response(http.StatusAccepted, `{}`), nil
	})}
	state := &InstallState{Root: "demo-skill@1.0.0", Installed: []Item{{
		Name: "demo-skill", Version: "1.0.0", Digest: objstore.Digest([]byte("manifest")),
		PayloadDigest: objstore.Digest([]byte("payload")), Path: "/private/node-local/artifacts/demo-skill/1.0.0/manifest.json",
	}}}
	if err := i.Report(context.Background(), "demo-skill", "1.0.0", plan.Shape{Object: true}, state, nil); err != nil {
		t.Fatal(err)
	}
	if got.NodeID != i.NodeID || got.State != "converged" || got.Root != state.Root || len(got.Installed) != 1 {
		t.Fatalf("unexpected report: %+v", got)
	}
	if got.Installed[0].Digest != state.Installed[0].Digest {
		t.Fatalf("digest = %q, want %q", got.Installed[0].Digest, state.Installed[0].Digest)
	}
}

func TestReportFailureDoesNotExposeRawReconcileError(t *testing.T) {
	var body []byte
	i := New("http://registry", t.TempDir())
	i.NodeID = "cluster-a.dsh-0"
	i.Client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/v1/installations" {
			return response(http.StatusNotFound, "{}"), nil
		}
		var err error
		body, err = io.ReadAll(r.Body)
		if err != nil {
			return nil, err
		}
		return response(http.StatusAccepted, `{}`), nil
	})}
	rawErr := errors.New("download https://internal.example/private-node-token failed")
	if err := i.Report(context.Background(), "demo-skill", "1.0.0", plan.Shape{Object: true}, nil, rawErr); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), rawErr.Error()) || strings.Contains(string(body), "private-node-token") {
		t.Fatalf("failure report leaked raw reconciler error: %s", body)
	}
	var got struct {
		State     string `json:"state"`
		Installed []any  `json:"installed"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.State != "failed" || len(got.Installed) != 0 {
		t.Fatalf("failure report = %+v", got)
	}
}

func TestResolveRolloutUsesAuthenticatedDesiredVersionOnlyAsAPlanHint(t *testing.T) {
	i := New("http://registry", t.TempDir())
	i.ControlPlaneToken = "control-token"
	i.Client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/rollouts/stable/demo-skill" {
			return response(http.StatusNotFound, "{}"), nil
		}
		if r.Header.Get("Authorization") != "Bearer control-token" {
			return response(http.StatusUnauthorized, "{}"), nil
		}
		return response(http.StatusOK, `{"rollout":{"channel":"stable","name":"demo-skill","version":"1.2.0","percent":100},"source":"desired_state"}`), nil
	})}
	version, err := i.ResolveRollout(context.Background(), "stable", "demo-skill")
	if err != nil {
		t.Fatal(err)
	}
	if version != "1.2.0" {
		t.Fatalf("version = %q, want 1.2.0", version)
	}
}

func TestResolveRolloutRejectsPartialTarget(t *testing.T) {
	i := New("http://registry", t.TempDir())
	i.Client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return response(http.StatusOK, `{"rollout":{"name":"demo-skill","version":"1.2.0","percent":50}}`), nil
	})}
	if _, err := i.ResolveRollout(context.Background(), "stable", "demo-skill"); err == nil || !strings.Contains(err.Error(), "PROVISIONER_NODE_ID") {
		t.Fatalf("partial rollout err = %v", err)
	}
}

func TestResolveRolloutUsesServerSelectedCanaryVersionForThisNode(t *testing.T) {
	i := New("http://registry", t.TempDir())
	i.NodeID = "cluster-a.dsh-3"
	i.Client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if got := r.URL.Query().Get("node_id"); got != i.NodeID {
			t.Fatalf("node_id query = %q, want %q", got, i.NodeID)
		}
		return response(http.StatusOK, `{"rollout":{"name":"demo-skill","version":"1.2.0","previous_version":"1.1.0","percent":25},"selection":{"node_id":"cluster-a.dsh-3","version":"1.1.0","cohort":"holdback"}}`), nil
	})}
	version, err := i.ResolveRollout(context.Background(), "stable", "demo-skill")
	if err != nil {
		t.Fatal(err)
	}
	if version != "1.1.0" {
		t.Fatalf("selected version = %q, want holdback 1.1.0", version)
	}
}

func TestReconcileRepairsMissingOrTamperedManifest(t *testing.T) {
	raw := []byte(`{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"demo-skill","version":"1.0.0","publisher":"acme","scopes":["kb:query"]}`)
	digest := objstore.Digest(raw)
	blobRequests := 0
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/v1/plan" {
			return response(http.StatusOK, `{"root":"demo-skill@1.0.0","items":[{"name":"demo-skill","version":"1.0.0","digest":"`+digest+`"}]}`), nil
		}
		if r.URL.Path == "/v1/blobs/"+digest {
			blobRequests++
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(raw))), Header: make(http.Header)}, nil
		}
		return response(http.StatusNotFound, "{}"), nil
	})}

	i := New("http://registry", t.TempDir())
	i.Client = client
	state, changed, err := i.Reconcile(context.Background(), "demo-skill", "1.0.0", plan.Shape{Object: true})
	if err != nil || !changed || state == nil {
		t.Fatalf("first reconcile = state:%+v changed:%v err:%v", state, changed, err)
	}
	if blobRequests != 1 {
		t.Fatalf("first reconcile blob requests = %d, want 1", blobRequests)
	}

	state, changed, err = i.Reconcile(context.Background(), "demo-skill", "1.0.0", plan.Shape{Object: true})
	if err != nil || changed || state == nil {
		t.Fatalf("second reconcile = state:%+v changed:%v err:%v", state, changed, err)
	}
	if blobRequests != 1 {
		t.Fatalf("converged reconcile redownloaded blob: %d", blobRequests)
	}

	if err := os.WriteFile(filepath.Join(i.InstallDir, "demo-skill", "1.0.0", "manifest.json"), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, changed, err = i.Reconcile(context.Background(), "demo-skill", "1.0.0", plan.Shape{Object: true})
	if err != nil || !changed {
		t.Fatalf("tampered reconcile = changed:%v err:%v", changed, err)
	}
	if blobRequests != 2 {
		t.Fatalf("repair blob requests = %d, want 2", blobRequests)
	}
}

func TestInstallMaterializesSignedPayloadAndSkillSnapshot(t *testing.T) {
	skill := []byte("---\nname: demo-skill\ndescription: Demo skill\nwhen_to_use: Run a demo\nmodel_invocable: false\n---\n\nUse the demo.\n")
	asset := []byte("example")
	payload, _, err := bundle.Create(bundle.Header{SchemaVersion: bundle.SchemaVersion, Bundle: "demo-skill", Version: "1.0.0"}, nil, []bundle.Entry{
		{Path: "skills/demo-skill/SKILL.md", Encoding: "utf8", SHA256: objstore.Digest(skill), Data: string(skill)},
		{Path: "skills/demo-skill/example.txt", Encoding: "utf8", SHA256: objstore.Digest(asset), Data: string(asset)},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifestRaw := []byte(fmt.Sprintf(`{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"demo-skill","version":"1.0.0","publisher":"acme","scopes":["kb:query"],"payload_digest":"%s"}`, objstore.Digest(payload)))
	manifestDigest := objstore.Digest(manifestRaw)
	payloadDigest := objstore.Digest(payload)
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer control-token" {
			return response(http.StatusUnauthorized, "{}"), nil
		}
		switch r.URL.Path {
		case "/v1/plan":
			return response(http.StatusOK, `{"root":"demo-skill@1.0.0","items":[{"name":"demo-skill","version":"1.0.0","digest":"`+manifestDigest+`"}]}`), nil
		case "/v1/blobs/" + manifestDigest:
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(manifestRaw))), Header: make(http.Header)}, nil
		case "/v1/blobs/" + payloadDigest:
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(payload))), Header: make(http.Header)}, nil
		default:
			return response(http.StatusNotFound, "{}"), nil
		}
	})}
	i := New("http://registry", t.TempDir())
	i.Client = client
	i.ControlPlaneToken = "control-token"
	if _, err := i.Install(context.Background(), "demo-skill", "1.0.0", plan.Shape{Object: true}); err != nil {
		t.Fatal(err)
	}
	installed, err := os.ReadFile(filepath.Join(i.InstallDir, "skills", "demo-skill", "SKILL.md"))
	if err != nil || string(installed) != string(skill) {
		t.Fatalf("技能未物化: bytes=%q err=%v", installed, err)
	}
	var snapshot []skillSnapshotEntry
	rawSnapshot, err := os.ReadFile(filepath.Join(i.InstallDir, "skill-snapshot.json"))
	if err != nil || json.Unmarshal(rawSnapshot, &snapshot) != nil {
		t.Fatalf("技能快照不可读: %q err=%v", rawSnapshot, err)
	}
	if len(snapshot) != 1 || snapshot[0].Name != "demo-skill" || snapshot[0].Description != "Demo skill" || snapshot[0].ModelInvocable == nil || *snapshot[0].ModelInvocable {
		t.Fatalf("技能快照不正确: %+v", snapshot)
	}
	if err := os.WriteFile(filepath.Join(i.InstallDir, "skills", "demo-skill", "SKILL.md"), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := i.Reconcile(context.Background(), "demo-skill", "1.0.0", plan.Shape{Object: true}); err != nil || !changed {
		t.Fatalf("篡改技能后的 reconcile = changed:%v err:%v", changed, err)
	}
}

func TestRuntimeSpecRequiresVerifiedSignedComponentPayload(t *testing.T) {
	script := []byte("#!/bin/sh\necho runtime-ready\n")
	payload, _, err := bundle.Create(bundle.Header{SchemaVersion: bundle.SchemaVersion, Bundle: "runtime-demo", Version: "1.0.0"}, nil, []bundle.Entry{
		{Path: "bin/run", Encoding: "utf8", SHA256: objstore.Digest(script), Data: string(script)},
	})
	if err != nil {
		t.Fatal(err)
	}
	payloadDigest := objstore.Digest(payload)
	manifestRaw := []byte(fmt.Sprintf(`{"apiVersion":"lumo.artifact/v1","kind":"Component","name":"runtime-demo","version":"1.0.0","publisher":"acme","scopes":["kb:query"],"payload_digest":"%s","runtime":{"type":"process","entrypoint":"bin/run","args":["--safe"]}}`, payloadDigest))
	manifestDigest := objstore.Digest(manifestRaw)
	i := New("http://registry", t.TempDir())
	i.Client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/v1/plan":
			return response(http.StatusOK, `{"root":"runtime-demo@1.0.0","items":[{"name":"runtime-demo","version":"1.0.0","digest":"`+manifestDigest+`"}]}`), nil
		case "/v1/blobs/" + manifestDigest:
			return response(http.StatusOK, string(manifestRaw)), nil
		case "/v1/blobs/" + payloadDigest:
			return response(http.StatusOK, string(payload)), nil
		default:
			return response(http.StatusNotFound, "{}"), nil
		}
	})}
	if _, err := i.Install(context.Background(), "runtime-demo", "1.0.0", plan.Shape{}); err != nil {
		t.Fatal(err)
	}
	spec, err := i.RuntimeSpec("runtime-demo", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if spec.ID != "runtime-demo@1.0.0" || spec.Dir != filepath.Join(i.InstallDir, "runtime-demo", "1.0.0", "payload") || len(spec.Args) != 1 || spec.Args[0] != "--safe" {
		t.Fatalf("runtime spec = %+v", spec)
	}
	if err := os.WriteFile(filepath.Join(spec.Dir, "bin", "run"), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := i.RuntimeSpec("runtime-demo", "1.0.0"); err == nil || !strings.Contains(err.Error(), "完整性") {
		t.Fatalf("tampered runtime spec err = %v", err)
	}
}

func TestRuntimeSpecRequiresEntrypointFromSignedPayload(t *testing.T) {
	script := []byte("#!/bin/sh\necho verified\n")
	payload, _, err := bundle.Create(bundle.Header{SchemaVersion: bundle.SchemaVersion, Bundle: "runtime-entrypoint", Version: "1.0.0"}, nil, []bundle.Entry{
		{Path: "bin/verified", Encoding: "utf8", SHA256: objstore.Digest(script), Data: string(script)},
	})
	if err != nil {
		t.Fatal(err)
	}
	payloadDigest := objstore.Digest(payload)
	// The manifest is itself valid and signed, but cannot nominate a file that
	// the payload did not include. A later local write must not make it runnable.
	manifestRaw := []byte(fmt.Sprintf(`{"apiVersion":"lumo.artifact/v1","kind":"Component","name":"runtime-entrypoint","version":"1.0.0","publisher":"acme","scopes":["kb:query"],"payload_digest":"%s","runtime":{"type":"process","entrypoint":"bin/not-in-bundle"}}`, payloadDigest))
	manifestDigest := objstore.Digest(manifestRaw)
	i := New("http://registry", t.TempDir())
	i.Client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/v1/plan":
			return response(http.StatusOK, `{"root":"runtime-entrypoint@1.0.0","items":[{"name":"runtime-entrypoint","version":"1.0.0","digest":"`+manifestDigest+`"}]}`), nil
		case "/v1/blobs/" + manifestDigest:
			return response(http.StatusOK, string(manifestRaw)), nil
		case "/v1/blobs/" + payloadDigest:
			return response(http.StatusOK, string(payload)), nil
		default:
			return response(http.StatusNotFound, "{}"), nil
		}
	})}
	if _, err := i.Install(context.Background(), "runtime-entrypoint", "1.0.0", plan.Shape{}); err != nil {
		t.Fatal(err)
	}
	entrypoint := filepath.Join(i.InstallDir, "runtime-entrypoint", "1.0.0", "payload", "bin", "not-in-bundle")
	if err := os.WriteFile(entrypoint, []byte("#!/bin/sh\necho injected\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := i.RuntimeSpec("runtime-entrypoint", "1.0.0"); err == nil || !strings.Contains(err.Error(), "verified payload entry") {
		t.Fatalf("unsigned runtime entrypoint error = %v", err)
	}
}

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}
