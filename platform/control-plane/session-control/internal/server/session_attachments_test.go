package server

import (
	"context"
	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/session-control/internal/store"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type attachmentFake struct {
	ownerFake
	requests int
	err      error
}

func (f *attachmentFake) SessionAttachments(_ context.Context, ref string, in store.AttachmentRequest) ([]store.AttachmentReceipt, error) {
	f.requests++
	if f.err != nil {
		return nil, f.err
	}
	if ref == "missing" {
		return nil, store.ErrNotFound
	}
	return []store.AttachmentReceipt{}, nil
}
func (f *attachmentFake) SessionAttachmentInventory(_ context.Context, _ string, in store.AttachmentRequest) (store.AttachmentInventory, error) {
	f.requests++
	if f.err != nil {
		return store.AttachmentInventory{}, f.err
	}
	return store.AttachmentInventory{Receipts: []store.AttachmentReceipt{}, Usage: store.AttachmentUsage{ActiveLimit: 100, Accounting: "logical-retained-reference-bytes"}}, nil
}
func TestAttachmentInventoryAPIAndCapacityAreExplicit(t *testing.T) {
	f := &attachmentFake{}
	mux := http.NewServeMux()
	New(Options{Owners: f}).Routes(mux)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/v1/session-attachments/test", strings.NewReader(`{"operation":"inventory","status":"all","limit":50}`)))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"accounting":"logical-retained-reference-bytes"`) || !strings.Contains(w.Body.String(), `"retirement_releases_quota":false`) {
		t.Fatalf("inventory: %d %s", w.Code, w.Body.String())
	}
	f.err = store.ErrAttachmentCapacity
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/v1/session-attachments/test", strings.NewReader(`{"operation":"create"}`)))
	if w.Code != 409 || !strings.Contains(w.Body.String(), `"error":"session_attachment_capacity"`) {
		t.Fatalf("capacity: %d %s", w.Code, w.Body.String())
	}
	f.err = store.ErrExecutionFenced
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/v1/session-attachments/test", strings.NewReader(`{"operation":"inventory"}`)))
	if w.Code != 409 || strings.Contains(w.Body.String(), `"usage"`) {
		t.Fatalf("stale inventory leaked: %d %s", w.Code, w.Body.String())
	}
}
func TestAttachmentAPIRejectsUnrecognizedFieldsAndMultipleBodies(t *testing.T) {
	previous := observability.Default
	observability.Default = &observability.Metrics{}
	t.Cleanup(func() { observability.Default = previous })
	f := &attachmentFake{}
	mux := http.NewServeMux()
	New(Options{Owners: f}).Routes(mux)
	for _, body := range []string{`{"operation":"create","url":"https://private"}`, `{"operation":"create","receipt":{"native_ref":{"path":"/etc/passwd"}}}`, `{} {}`, strings.Repeat("x", 9000)} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("POST", "/v1/session-attachments/test", strings.NewReader(body)))
		if w.Code != 400 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
	}
	if f.requests != 0 {
		t.Fatal("invalid request reached persistence")
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/v1/session-attachments/test", strings.NewReader(`{"operation":"list"}`)))
	if w.Code != 200 || f.requests != 1 {
		t.Fatalf("%d", w.Code)
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/v1/session-attachments/test", nil))
	if w.Code != 405 {
		t.Fatalf("%d", w.Code)
	}
	metrics := httptest.NewRecorder()
	observability.Default.Write(metrics)
	for _, want := range []string{
		`lumo_business_requests_total{operation="session_attachment",outcome="invalid"} 4`,
		`lumo_business_requests_total{operation="session_attachment",outcome="success"} 1`,
	} {
		if !strings.Contains(metrics.Body.String(), want) {
			t.Fatalf("missing attachment metric %q: %s", want, metrics.Body)
		}
	}
}
