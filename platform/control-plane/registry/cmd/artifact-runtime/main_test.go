package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/registry/internal/artifactruntime"
	"github.com/lumo-harness/platform/registry/internal/bundle"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/plan"
	"github.com/lumo-harness/platform/registry/internal/provisioner"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestRuntimeControllerLifecycle(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("local process adapter uses POSIX signals")
	}
	script := []byte("#!/bin/sh\necho controller-ready\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n")
	payload, _, err := bundle.Create(bundle.Header{SchemaVersion: bundle.SchemaVersion, Bundle: "runtime-demo", Version: "1.0.0"}, nil, []bundle.Entry{
		{Path: "bin/run", Encoding: "utf8", SHA256: objstore.Digest(script), Data: string(script)},
	})
	if err != nil {
		t.Fatal(err)
	}
	payloadDigest := objstore.Digest(payload)
	manifestRaw := []byte(fmt.Sprintf(`{"apiVersion":"lumo.artifact/v1","kind":"Component","name":"runtime-demo","version":"1.0.0","publisher":"acme","scopes":["kb:query"],"payload_digest":"%s","runtime":{"type":"process","entrypoint":"bin/run"}}`, payloadDigest))
	manifestDigest := objstore.Digest(manifestRaw)
	installer := provisioner.New("http://registry", t.TempDir())
	installer.Client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch request.URL.Path {
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
	if _, err := installer.Install(context.Background(), "runtime-demo", "1.0.0", plan.Shape{}); err != nil {
		t.Fatal(err)
	}
	controller := &runtimeController{installer: installer, supervisor: artifactruntime.NewSupervisor(time.Second)}
	handler := controller.routes()

	if response := call(handler, http.MethodPost, "/v1/runtimes/runtime-demo/1.0.0/start"); response.Code != http.StatusOK {
		t.Fatalf("start: %d %s", response.Code, response.Body.String())
	}
	deadline := time.Now().Add(time.Second)
	for {
		response := call(handler, http.MethodGet, "/v1/runtimes/runtime-demo/1.0.0/logs")
		if response.Code == http.StatusOK && strings.Contains(response.Body.String(), "controller-ready") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("runtime logs not ready: %d %s", response.Code, response.Body.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if response := call(handler, http.MethodGet, "/v1/runtimes/runtime-demo/1.0.0/health"); response.Code != http.StatusOK {
		t.Fatalf("health while running: %d %s", response.Code, response.Body.String())
	}
	if response := call(handler, http.MethodPost, "/v1/runtimes/runtime-demo/1.0.0/stop"); response.Code != http.StatusOK {
		t.Fatalf("stop: %d %s", response.Code, response.Body.String())
	}
	if response := call(handler, http.MethodGet, "/v1/runtimes/runtime-demo/1.0.0/health"); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("health after stop: %d %s", response.Code, response.Body.String())
	}
	if response := call(handler, http.MethodDelete, "/v1/runtimes/runtime-demo/1.0.0"); response.Code != http.StatusOK {
		t.Fatalf("uninstall: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(installer.InstallDir, "install-state.jsonl.zst")); !os.IsNotExist(err) {
		t.Fatalf("install state should be removed, err=%v", err)
	}
}

func call(handler http.Handler, method, path string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(method, path, nil))
	return response
}

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}
