package observability

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

type Metrics struct {
	requests    atomic.Uint64
	errors      atomic.Uint64
	inflight    atomic.Int64
	latencySum  atomic.Uint64 // microseconds
	latencyN    atomic.Uint64
	latencyBuck [7]atomic.Uint64
	gaugeMu     sync.RWMutex
	gauges      map[string]float64
}

var Default = &Metrics{gauges: make(map[string]float64)}

var metricName = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)

func Middleware(next http.Handler) http.Handler      { return Default.Middleware(next) }
func Handler(w http.ResponseWriter, _ *http.Request) { Default.Write(w) }

// SetGauge 更新一个由服务主动采集的 Prometheus gauge。名称只接受合法的
// Prometheus metric name，避免把外部输入拼入 /metrics 响应。
func SetGauge(name string, value float64) {
	if !metricName.MatchString(name) {
		return
	}
	Default.gaugeMu.Lock()
	if Default.gauges == nil {
		Default.gauges = make(map[string]float64)
	}
	Default.gauges[name] = value
	Default.gaugeMu.Unlock()
}

func (m *Metrics) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		if origin := os.Getenv("LUMO_CORS_ORIGIN"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Lumo-Correlation-Id")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		m.requests.Add(1)
		m.inflight.Add(1)
		defer m.inflight.Add(-1)
		rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r)
		if rw.status >= http.StatusInternalServerError {
			m.errors.Add(1)
		}
		elapsed := time.Since(started)
		m.latencySum.Add(uint64(elapsed / time.Microsecond))
		m.latencyN.Add(1)
		for i, bound := range [...]time.Duration{5 * time.Millisecond, 10 * time.Millisecond, 25 * time.Millisecond, 50 * time.Millisecond, 100 * time.Millisecond, 250 * time.Millisecond, time.Second} {
			if elapsed <= bound {
				m.latencyBuck[i].Add(1)
			}
		}
	})
}

func (m *Metrics) Write(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	bounds := [...]string{"0.005", "0.01", "0.025", "0.05", "0.1", "0.25", "1"}
	m.gaugeMu.RLock()
	gauges := make(map[string]float64, len(m.gauges))
	for name, value := range m.gauges {
		gauges[name] = value
	}
	m.gaugeMu.RUnlock()
	fmt.Fprintf(w, "# TYPE lumo_service_up gauge\nlumo_service_up 1\n# TYPE lumo_http_requests_total counter\nlumo_http_requests_total %d\n# TYPE lumo_http_errors_total counter\nlumo_http_errors_total %d\n# TYPE lumo_http_inflight gauge\nlumo_http_inflight %d\n# TYPE lumo_http_request_duration_seconds histogram\n", m.requests.Load(), m.errors.Load(), m.inflight.Load())
	for i, bound := range bounds {
		fmt.Fprintf(w, "lumo_http_request_duration_seconds_bucket{le=\"%s\"} %d\n", bound, m.latencyBuck[i].Load())
	}
	fmt.Fprintf(w, "lumo_http_request_duration_seconds_bucket{le=\"+Inf\"} %d\nlumo_http_request_duration_seconds_sum %.6f\nlumo_http_request_duration_seconds_count %d\n", m.latencyN.Load(), float64(m.latencySum.Load())/1e6, m.latencyN.Load())
	for name, value := range gauges {
		fmt.Fprintf(w, "# TYPE %s gauge\n%s %g\n", name, name, value)
	}
}

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (w *responseWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(body []byte) (int, error) { return w.ResponseWriter.Write(body) }

func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *responseWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("underlying writer does not support hijacking")
	}
	return hijacker.Hijack()
}

func (w *responseWriter) ReadFrom(src io.Reader) (int64, error) {
	if reader, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		return reader.ReadFrom(src)
	}
	return io.Copy(w.ResponseWriter, src)
}
