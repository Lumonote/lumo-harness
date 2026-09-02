package server_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/bundle"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/server"
)

func TestPublishEnvelopeRejectsBadBase64(t *testing.T) {
	h := server.New(nil, nil, nil)
	body := `{"manifest_b64":"!!!not base64!!!","sig_b64":"AA=="}`
	req := httptest.NewRequest(http.MethodPost, "/v1/artifacts", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非法 base64 应 400，得到 %d", w.Code)
	}
}

func TestPublishEnvelopeRequiresBothFields(t *testing.T) {
	h := server.New(nil, nil, nil)
	body, _ := json.Marshal(map[string]string{
		"manifest_b64": base64.StdEncoding.EncodeToString([]byte(`{}`)),
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/artifacts", bytes.NewBuffer(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("缺 sig 应 400，得到 %d", w.Code)
	}
}

func TestHealthz(t *testing.T) {
	h := server.New(nil, nil, nil)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("healthz 应 200，得到 %d", w.Code)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	h := server.New(nil, nil, nil)
	for _, tc := range []struct{ method, path string }{
		{http.MethodDelete, "/v1/artifacts"},
		{http.MethodPost, "/v1/artifacts/foo/1.0.0"},
		{http.MethodGet, "/v1/resolve"},
		{http.MethodGet, "/v1/plan"},
		{http.MethodDelete, "/v1/installations"},
		{http.MethodDelete, "/v1/rollouts/stable"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s 应 405，得到 %d", tc.method, tc.path, w.Code)
		}
	}
}

// TestRolloutRejectsInvalidCommandsBeforeStoreAccess keeps the desired-state
// command boundary testable without a live PG Store.
func TestRolloutRejectsInvalidCommandsBeforeStoreAccess(t *testing.T) {
	h := server.New(nil, nil, nil)
	for _, tc := range []struct {
		method string
		path   string
		body   string
		header http.Header
		status int
	}{
		{http.MethodGet, "/v1/rollouts/stable?limit=0", "", nil, http.StatusBadRequest},
		{http.MethodGet, "/v1/rollouts/bad%20channel", "", nil, http.StatusBadRequest},
		{http.MethodPut, "/v1/rollouts/stable/demo-skill", `{"version":"1.0.0","percent":100}`, nil, http.StatusUnauthorized},
		{http.MethodPut, "/v1/rollouts/stable/demo-skill", `{"version":"1.0.0","percent":-1}`, http.Header{"X-Lumo-User": []string{"admin"}, "X-Lumo-Realm": []string{"dev"}, "X-Lumo-Roles": []string{"realm_admin"}}, http.StatusBadRequest},
		{http.MethodPut, "/v1/rollouts/stable/demo-skill", `{"version":"1.0.0","percent":101}`, http.Header{"X-Lumo-User": []string{"admin"}, "X-Lumo-Realm": []string{"dev"}, "X-Lumo-Roles": []string{"realm_admin"}}, http.StatusBadRequest},
		{http.MethodPut, "/v1/rollouts/stable/demo-skill", `{"version":"1.0.0","percent":100,"unexpected":true}`, http.Header{"X-Lumo-User": []string{"admin"}, "X-Lumo-Realm": []string{"dev"}, "X-Lumo-Roles": []string{"realm_admin"}}, http.StatusBadRequest},
	} {
		req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
		for key, values := range tc.header {
			for _, value := range values {
				req.Header.Add(key, value)
			}
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != tc.status {
			t.Fatalf("%s %s 应为 %d，得到 %d: %s", tc.method, tc.path, tc.status, w.Code, w.Body.String())
		}
	}
}

func TestCatalogRejectsInvalidLimitBeforeStoreAccess(t *testing.T) {
	h := server.New(nil, nil, nil)
	for _, path := range []string{"/v1/artifacts?limit=0", "/v1/artifacts?limit=201", "/v1/artifacts?limit=nope"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s 应为 400，得到 %d", path, w.Code)
		}
	}
}

// TestInstallationReportRejectsInvalidRequestBeforeStoreAccess keeps the
// handler's untrusted-input boundary testable without a live PG Store.
func TestInstallationReportRejectsInvalidRequestBeforeStoreAccess(t *testing.T) {
	h := server.New(nil, nil, nil)
	for _, tc := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/v1/installations?limit=0", ""},
		{http.MethodPost, "/v1/installations", `{"node_id":"bad id","state":"converged","root":"demo@1.0.0","installed":[]}`},
		{http.MethodPost, "/v1/installations", `{"node_id":"node-a","state":"converged","root":"demo@1.0.0","installed":[{"name":"demo","version":"1.0.0","digest":"not-a-digest"}]}`},
		{http.MethodPost, "/v1/installations", `{"node_id":"node-a","state":"failed","root":"demo@1.0.0","installed":[{"name":"demo","version":"1.0.0","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}`},
		{http.MethodPost, "/v1/installations", `{"node_id":"node-a","state":"failed","root":"demo@1.0.0","installed":[]}{}`},
	} {
		req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s %s 应为 400，得到 %d: %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}

func TestBlobUploadAcceptsOnlyVerifiedBundles(t *testing.T) {
	payload := []byte("skill")
	raw, parsed, err := bundle.Create(bundle.Header{SchemaVersion: bundle.SchemaVersion, Bundle: "demo-skill", Version: "1.0.0"}, nil, []bundle.Entry{{
		Path: "skills/demo-skill/SKILL.md", Encoding: "utf8", SHA256: objstore.Digest(payload), Data: string(payload),
	}})
	if err != nil {
		t.Fatal(err)
	}
	h := server.New(nil, nil, objstore.NewFileStore(t.TempDir()))
	req := httptest.NewRequest(http.MethodPost, "/v1/blobs", bytes.NewReader(raw))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("上传 bundle 应为 201，得到 %d: %s", w.Code, w.Body.String())
	}
	var body struct {
		Digest string `json:"digest"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Digest != parsed.CompressedDigest {
		t.Fatalf("digest = %q, want %q", body.Digest, parsed.CompressedDigest)
	}
	req = httptest.NewRequest(http.MethodGet, "/v1/blobs/"+body.Digest, nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), raw) {
		t.Fatalf("下载 bundle 失败: code=%d body=%q", w.Code, w.Body.Bytes())
	}

	req = httptest.NewRequest(http.MethodPost, "/v1/blobs", bytes.NewBufferString("not a bundle"))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非法 bundle 应为 400，得到 %d", w.Code)
	}
}

// TestResolveRejectsBadBody 请求体坏掉时不得走到 store（store 为 nil，走到就 panic）。
func TestResolveRejectsBadBody(t *testing.T) {
	h := server.New(nil, nil, nil)
	for _, path := range []string{"/v1/resolve", "/v1/plan"} {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(`{not json`))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s 坏请求体应 400，得到 %d", path, w.Code)
		}
	}
}
