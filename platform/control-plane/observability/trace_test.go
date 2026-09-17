package observability

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMiddlewarePropagatesValidTraceparentAndCorrelation(t *testing.T) {
	metrics := &Metrics{}
	const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	handler := metrics.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := TraceID(r.Context()); got != "4bf92f3577b34da6a3ce929d0e0e4736" {
			t.Fatalf("trace id 不应丢失: %q", got)
		}
		if got := Traceparent(r.Context()); got != parent {
			t.Fatalf("traceparent 不应变形: %q", got)
		}
		if got := CorrelationID(r.Context()); got != "order-42" {
			t.Fatalf("correlation id 不应丢失: %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("traceparent", parent)
	req.Header.Set("X-Lumo-Correlation-Id", "order-42")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if got := res.Header().Get("traceparent"); got != parent {
		t.Fatalf("响应应返回 traceparent: %q", got)
	}
	if got := res.Header().Get("X-Lumo-Correlation-Id"); got != "order-42" {
		t.Fatalf("响应应返回 correlation id: %q", got)
	}
}

func TestMiddlewareCreatesSafeTraceForMissingOrInvalidHeaders(t *testing.T) {
	metrics := &Metrics{}
	var seenTrace, seenCorrelation string
	handler := metrics.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenTrace, seenCorrelation = TraceID(r.Context()), CorrelationID(r.Context())
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("traceparent", "not-a-trace")
	req.Header.Set("X-Lumo-Correlation-Id", "untrusted\r\nheader")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if len(seenTrace) != 32 || allZero(seenTrace) || seenCorrelation != seenTrace {
		t.Fatalf("非法输入应生成安全 trace/correlation: trace=%q correlation=%q", seenTrace, seenCorrelation)
	}
	gotParent := res.Header().Get("traceparent")
	if _, normalized, ok := parseTraceparent(gotParent); !ok || normalized != gotParent {
		t.Fatalf("应生成规范 traceparent: %q", gotParent)
	}
	if got := res.Header().Get("X-Lumo-Correlation-Id"); got != seenTrace || strings.ContainsAny(got, "\r\n") {
		t.Fatalf("响应不得反射非法 correlation header: %q", got)
	}
}
