package bot

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/flows/internal/store"
	"github.com/lumo-harness/platform/observability"
)

type fakeSink struct {
	calls                      int
	realm, channel, mid, event string
	payload                    json.RawMessage
	err                        error
	duplicate                  bool
}

type mappedSink struct {
	fakeSink
	subject string
}

func (s *mappedSink) EnqueueBotSubjectTrigger(ctx context.Context, r, c, m, e, subject string, p json.RawMessage) (int64, bool, error) {
	s.subject = subject
	return s.EnqueueBotTrigger(ctx, r, c, m, e, p)
}

func TestSubjectSignatureBindsTrustedHeaderAndIgnoresBodyIdentity(t *testing.T) {
	channels, err := ParseConfig([]byte(`[{"id":"alerts","realm":"r1","event":"bot.message","secret_env":"KEY","require_subject":true}]`), func(string) string { return strings.Repeat("k", 32) })
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, header, signatureSubject, body, version string
		want                                          int
	}{
		{"valid", "external-1", "external-1", `{"sender":"admin","roles":["platform_admin"]}`, "v2=", 202},
		{"missing subject", "", "", `{}`, "v2=", 401},
		{"tampered subject", "external-2", "external-1", `{}`, "v2=", 401},
		{"legacy signature", "external-1", "external-1", `{}`, "v1=", 401},
	} {
		t.Run(test.name, func(t *testing.T) {
			sink := &mappedSink{}
			h := WithIngress(http.NotFoundHandler(), sink, channels, slog.Default())
			stamp := strconv.FormatInt(time.Now().Unix(), 10)
			mac := hmac.New(sha256.New, []byte(strings.Repeat("k", 32)))
			mac.Write([]byte(stamp + "\nalerts\nm1\n" + test.signatureSubject + "\n" + test.body))
			req := httptest.NewRequest("POST", "/v1/bot/events/alerts", strings.NewReader(test.body))
			req.Header.Set("X-Lumo-Bot-Id", "m1")
			req.Header.Set("X-Lumo-Bot-Timestamp", stamp)
			req.Header.Set("X-Lumo-Bot-Subject", test.header)
			req.Header.Set("X-Lumo-Bot-Signature", test.version+hex.EncodeToString(mac.Sum(nil)))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != test.want {
				t.Fatalf("%d: %s", w.Code, w.Body)
			}
			if test.want == 202 && (sink.subject != "external-1" || sink.realm != "r1") {
				t.Fatalf("wrong trusted scope: %+v", sink)
			}
		})
	}
}

func (s *fakeSink) EnqueueBotTrigger(_ context.Context, r, c, m, e string, p json.RawMessage) (int64, bool, error) {
	s.calls++
	s.realm = r
	s.channel = c
	s.mid = m
	s.event = e
	s.payload = p
	return 42, s.duplicate, s.err
}
func signed(t *testing.T, method, path, mid, stamp, body, secret string) *http.Request {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(stamp + "\nalerts\n" + mid + "\n" + body))
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("X-Lumo-Bot-Id", mid)
	req.Header.Set("X-Lumo-Bot-Timestamp", stamp)
	req.Header.Set("X-Lumo-Bot-Signature", "v1="+hex.EncodeToString(mac.Sum(nil)))
	return req
}
func handler(t *testing.T, sink Sink) http.Handler {
	t.Helper()
	channels, err := ParseConfig([]byte(`[{"id":"alerts","realm":"r1","event":"bot.message","secret_env":"BOT_KEY"}]`), func(string) string { return strings.Repeat("k", 32) })
	if err != nil {
		t.Fatal(err)
	}
	protected := observability.RequireControlPlaneToken("control-token")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	return WithIngress(protected, sink, channels, slog.New(slog.NewTextHandler(io.Discard, nil)))
}
func TestIngressSignatureAndIsolation(t *testing.T) {
	for _, tc := range []struct {
		name, method, path, mid, body, secret string
		offset                                int64
		status                                int
	}{
		{"valid", "POST", "/v1/bot/events/alerts", "m1", `{"text":"hello","realm":"evil","roles":["platform_admin"]}`, strings.Repeat("k", 32), 0, 202},
		{"wrong key", "POST", "/v1/bot/events/alerts", "m1", `{}`, strings.Repeat("z", 32), 0, 401},
		{"expired", "POST", "/v1/bot/events/alerts", "m1", `{}`, strings.Repeat("k", 32), -360, 401},
		{"future", "POST", "/v1/bot/events/alerts", "m1", `{}`, strings.Repeat("k", 32), 360, 401},
		{"unknown", "POST", "/v1/bot/events/other", "m1", `{}`, strings.Repeat("k", 32), 0, 404},
		{"invalid id", "POST", "/v1/bot/events/alerts", "bad\nid", `{}`, strings.Repeat("k", 32), 0, 401},
		{"invalid json", "POST", "/v1/bot/events/alerts", "m1", `invalid`, strings.Repeat("k", 32), 0, 400},
		{"method", "GET", "/v1/bot/events/alerts", "m1", `{}`, strings.Repeat("k", 32), 0, 405},
		{"control api stays protected", "POST", "/v1/events/bot.message", "m1", `{}`, strings.Repeat("k", 32), 0, 401},
		{"lookalike route stays protected", "POST", "/v1/bot/events/alerts/extra", "m1", `{}`, strings.Repeat("k", 32), 0, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sink := &fakeSink{}
			h := handler(t, sink)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, signed(t, tc.method, tc.path, tc.mid, strconv.FormatInt(time.Now().Unix()+tc.offset, 10), tc.body, tc.secret))
			if w.Code != tc.status {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			if tc.status == 202 {
				if sink.calls != 1 || sink.realm != "r1" || sink.channel != "alerts" || sink.event != "bot.message" {
					t.Fatalf("wrong trusted binding: %+v", sink)
				}
				if !strings.Contains(w.Body.String(), `"trigger_id":"42"`) {
					t.Fatal(w.Body.String())
				}
			} else if sink.calls != 0 {
				t.Fatal("unauthorized request reached queue")
			}
		})
	}
}
func TestIngressTamperDuplicateAndFailures(t *testing.T) {
	sink := &fakeSink{}
	h := handler(t, sink)
	for _, field := range []string{"body", "id", "timestamp", "channel"} {
		req := signed(t, "POST", "/v1/bot/events/alerts", "m1", strconv.FormatInt(time.Now().Unix(), 10), `{}`, strings.Repeat("k", 32))
		switch field {
		case "body":
			req.Body = io.NopCloser(strings.NewReader(`{"edit":true}`))
		case "id":
			req.Header.Set("X-Lumo-Bot-Id", "m2")
		case "timestamp":
			req.Header.Set("X-Lumo-Bot-Timestamp", strconv.FormatInt(time.Now().Unix()+1, 10))
		case "channel":
			req.URL.Path = "/v1/bot/events/nope"
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 401 && w.Code != 404 {
			t.Fatalf("tampered %s accepted: %d", field, w.Code)
		}
	}
	for _, tc := range []struct {
		err    error
		dup    bool
		status int
	}{{nil, true, 202}, {store.ErrBotMessageConflict, false, 409}, {errors.New("offline"), false, 503}} {
		sink.err = tc.err
		sink.duplicate = tc.dup
		w := httptest.NewRecorder()
		h.ServeHTTP(w, signed(t, "POST", "/v1/bot/events/alerts", "m1", strconv.FormatInt(time.Now().Unix(), 10), `{}`, strings.Repeat("k", 32)))
		if w.Code != tc.status {
			t.Fatalf("status %d", w.Code)
		}
		if tc.dup && !strings.Contains(w.Body.String(), `"duplicate":true`) {
			t.Fatal(w.Body.String())
		}
	}
}
func TestIngressBoundedBodyAndDisabled(t *testing.T) {
	sink := &fakeSink{}
	h := handler(t, sink)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, signed(t, "POST", "/v1/bot/events/alerts", "m1", strconv.FormatInt(time.Now().Unix(), 10), string(bytes.Repeat([]byte("x"), (1<<20)+1)), strings.Repeat("k", 32)))
	if w.Code != 413 || sink.calls != 0 {
		t.Fatalf("oversize: %d", w.Code)
	}
	called := false
	protected := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(401) })
	WithIngress(protected, sink, nil, slog.Default()).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/bot/events/alerts", nil))
	if !called {
		t.Fatal("disabled ingress bypassed auth")
	}
}
func TestConfigFailsClosed(t *testing.T) {
	for _, input := range []string{`bad`, `{} extra`, `[{"id":"a","realm":"r","event":"*","secret_env":"S"}]`, `[{"id":"a","realm":"r","event":"b","secret_env":"S","secret":"leak"}]`, `[{"id":"a","realm":"r","event":"b","secret_env":"S"},{"id":"a","realm":"r","event":"b","secret_env":"S"}]`, `[{"id":"a","realm":" ","event":"b","secret_env":"S"}]`} {
		if _, err := ParseConfig([]byte(input), func(string) string { return strings.Repeat("k", 32) }); err == nil {
			t.Fatalf("accepted %s", input)
		}
	}
	if _, err := ParseConfig([]byte(`[{"id":"a","realm":"r","event":"e","secret_env":"S"}]`), func(string) string { return "short" }); err == nil {
		t.Fatal("short key accepted")
	}
}
