package publisher

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/bundle"
	"github.com/lumo-harness/platform/registry/internal/objstore"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func TestPublishUploadsVerifiedBundleThenSignedManifest(t *testing.T) {
	payload := []byte("# demo\n")
	bundleRaw, _, err := bundle.Create(
		bundle.Header{SchemaVersion: bundle.SchemaVersion, Bundle: "artifact-demo", Version: "1.0.0"}, nil,
		[]bundle.Entry{{Path: "skills/demo/SKILL.md", Encoding: "utf8", SHA256: objstore.Digest(payload), Data: string(payload)}},
	)
	if err != nil {
		t.Fatal(err)
	}
	manifestRaw, _ := json.Marshal(map[string]any{
		"apiVersion": "lumo.artifact/v1", "kind": "Skill", "name": "artifact-demo", "version": "1.0.0",
		"publisher": "ci", "scopes": []string{"data:read"}, "payload_digest": objstore.Digest(bundleRaw),
	})
	paths := []string{}
	client, err := NewClient("https://registry.example/base", "control-token", &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		paths = append(paths, req.URL.Path)
		if req.Header.Get("Authorization") != "Bearer control-token" {
			t.Fatalf("Authorization = %q", req.Header.Get("Authorization"))
		}
		body := `{"name":"artifact-demo"}`
		if strings.HasSuffix(req.URL.Path, "/v1/blobs") {
			raw, _ := io.ReadAll(req.Body)
			if objstore.Digest(raw) != objstore.Digest(bundleRaw) {
				t.Fatal("uploaded bundle changed")
			}
			body = `{"digest":"` + objstore.Digest(bundleRaw) + `"}`
		}
		return &http.Response{StatusCode: http.StatusCreated, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})})
	if err != nil {
		t.Fatal(err)
	}

	result, err := client.Publish(context.Background(), manifestRaw, make([]byte, 64), bundleRaw)
	if err != nil {
		t.Fatal(err)
	}
	if string(result) != `{"name":"artifact-demo"}` {
		t.Fatalf("result = %s", result)
	}
	want := []string{"/base/v1/blobs", "/base/v1/artifacts"}
	if strings.Join(paths, ",") != strings.Join(want, ",") {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
}

func TestPublishRejectsPayloadMismatchBeforeNetwork(t *testing.T) {
	manifestRaw := []byte(`{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"artifact-demo","version":"1.0.0","publisher":"ci","scopes":["data:read"],"payload_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}`)
	client, err := NewClient("https://registry.example", "control-token", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("network must not be called")
		return nil, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Publish(context.Background(), manifestRaw, make([]byte, 64), []byte("not-a-bundle")); err == nil {
		t.Fatal("expected invalid bundle error")
	}
}
