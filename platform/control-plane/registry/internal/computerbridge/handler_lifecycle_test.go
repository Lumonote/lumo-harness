package computerbridge

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type bridgeRoundTrip func(*http.Request) (*http.Response, error)

func (fn bridgeRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }
func leaseRequest() *http.Request {
	r := httptest.NewRequest("POST", "/lease/"+strings.Repeat("a", 43), strings.NewReader(`{"digest":"sha256:`+strings.Repeat("a", 64)+`","expected_revision":1,"phase":"check"}`))
	r.Header.Set("Authorization", "Bearer local-secret")
	r.Header.Set("Content-Type", "application/json")
	return r
}
func TestBridgeCancellationStopsAuthorityRequestAndDoesNotInventReceipt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{})
	done := make(chan struct{})
	client := &http.Client{Transport: bridgeRoundTrip(func(r *http.Request) (*http.Response, error) {
		close(entered)
		<-r.Context().Done()
		return nil, errors.New("cancelled")
	})}
	recorder := httptest.NewRecorder()
	go func() {
		Handler(ctx, Options{Gateway: "https://device.invalid"}, "local-secret", client).ServeHTTP(recorder, leaseRequest())
		close(done)
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("authority request not started")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancelled bridge request did not stop")
	}
	if recorder.Code != 503 || strings.Contains(recorder.Body.String(), "running") {
		t.Fatalf("unexpected authority receipt %d %s", recorder.Code, recorder.Body.String())
	}
}
func TestBridgeRejectsBrowserOriginAndOversizedBodyBeforeAuthority(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: bridgeRoundTrip(func(*http.Request) (*http.Response, error) { calls++; return nil, errors.New("must not call") })}
	for _, mode := range []string{"origin", "oversized", "invalid-token"} {
		r := leaseRequest()
		if mode == "origin" {
			r.Header.Set("Origin", "https://foreign.invalid")
		}
		if mode == "oversized" {
			r = httptest.NewRequest("POST", r.URL.String(), strings.NewReader(strings.Repeat("x", 8193)))
			r.Header.Set("Authorization", "Bearer local-secret")
			r.Header.Set("Content-Type", "application/json")
		}
		if mode == "invalid-token" {
			r.Header.Set("Authorization", "Bearer wrong")
		}
		w := httptest.NewRecorder()
		Handler(context.Background(), Options{}, "local-secret", client).ServeHTTP(w, r)
		if w.Code < 400 {
			t.Fatalf("%s was accepted", mode)
		}
	}
	if calls != 0 {
		t.Fatal("rejected request reached remote authority")
	}
}
