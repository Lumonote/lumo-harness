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
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s 应 405，得到 %d", tc.method, tc.path, w.Code)
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
