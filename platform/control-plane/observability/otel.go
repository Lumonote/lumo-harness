package observability

// OTLP setup is deliberately dependency-free and shared by every
// control-plane binary. It exports W3C-linked HTTP spans and the fixed,
// low-cardinality metric set through OTLP/HTTP JSON. Application logs remain
// on stdout/stderr so the Collector can apply deployment-specific receivers
// and redaction policy before exporting them.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultOTelSampleRatio      = 0.10
	defaultMetricCardinalityMax = 128
	defaultMetricExportInterval = 30 * time.Second
	otlpTraceBatchMax           = 256
	otlpPendingTraceMax         = 1024
)

type OTelCostPolicy string

const (
	OTelCostEconomy  OTelCostPolicy = "economy"
	OTelCostBalanced OTelCostPolicy = "balanced"
	OTelCostDetailed OTelCostPolicy = "detailed"
)

// OTelConfig intentionally contains no secret-bearing fields. A Collector URL
// must be explicit; absent configuration keeps the process local-only rather
// than guessing a network destination. HTTP is only permitted by an explicit
// opt-in, intended for an in-cluster mTLS sidecar or local Collector.
type OTelConfig struct {
	CollectorURL           string
	SampleRatio            float64
	MetricCardinalityMax   int
	CostPolicy             OTelCostPolicy
	MetricExportInterval   time.Duration
	AllowInsecureCollector bool
}

func (c OTelConfig) Enabled() bool { return c.CollectorURL != "" }

func OTelConfigFromEnv() (OTelConfig, error) {
	collector := strings.TrimRight(strings.TrimSpace(os.Getenv("LUMO_OTEL_COLLECTOR_URL")), "/")
	anyConfigured := collector != "" || os.Getenv("LUMO_OTEL_SAMPLE_RATIO") != "" || os.Getenv("LUMO_OTEL_METRIC_CARDINALITY_MAX") != "" || os.Getenv("LUMO_OTEL_COST_POLICY") != "" || os.Getenv("LUMO_OTEL_METRIC_EXPORT_INTERVAL") != "" || os.Getenv("LUMO_OTEL_ALLOW_INSECURE") != ""
	if !anyConfigured {
		return OTelConfig{}, nil
	}
	if collector == "" {
		return OTelConfig{}, errors.New("LUMO_OTEL_COLLECTOR_URL is required when OpenTelemetry is configured")
	}
	u, err := url.Parse(collector)
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return OTelConfig{}, errors.New("LUMO_OTEL_COLLECTOR_URL must be an absolute collector base URL without a path, query, or fragment")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return OTelConfig{}, errors.New("LUMO_OTEL_COLLECTOR_URL must use HTTP or HTTPS")
	}
	allowInsecure, err := envBool("LUMO_OTEL_ALLOW_INSECURE", false)
	if err != nil {
		return OTelConfig{}, err
	}
	if u.Scheme == "http" && !allowInsecure {
		return OTelConfig{}, errors.New("HTTP Collector requires LUMO_OTEL_ALLOW_INSECURE=true")
	}
	policy := OTelCostPolicy(strings.ToLower(strings.TrimSpace(os.Getenv("LUMO_OTEL_COST_POLICY"))))
	if policy == "" {
		policy = OTelCostBalanced
	}
	defaultRatio, defaultCardinality, defaultInterval, err := costPolicyDefaults(policy)
	if err != nil {
		return OTelConfig{}, err
	}
	ratio, err := envFloat("LUMO_OTEL_SAMPLE_RATIO", defaultRatio, 0, 1)
	if err != nil {
		return OTelConfig{}, err
	}
	cardinality, err := envInt("LUMO_OTEL_METRIC_CARDINALITY_MAX", defaultCardinality, 1, 10_000)
	if err != nil {
		return OTelConfig{}, err
	}
	interval, err := envDuration("LUMO_OTEL_METRIC_EXPORT_INTERVAL", defaultInterval, 5*time.Second, 10*time.Minute)
	if err != nil {
		return OTelConfig{}, err
	}
	if err := validateCostPolicy(policy, ratio, cardinality, interval); err != nil {
		return OTelConfig{}, err
	}
	return OTelConfig{CollectorURL: collector, SampleRatio: ratio, MetricCardinalityMax: cardinality, CostPolicy: policy, MetricExportInterval: interval, AllowInsecureCollector: allowInsecure}, nil
}

func costPolicyDefaults(policy OTelCostPolicy) (float64, int, time.Duration, error) {
	switch policy {
	case OTelCostEconomy:
		return defaultOTelSampleRatio, 64, time.Minute, nil
	case OTelCostBalanced, OTelCostDetailed:
		return defaultOTelSampleRatio, defaultMetricCardinalityMax, defaultMetricExportInterval, nil
	default:
		return 0, 0, 0, fmt.Errorf("LUMO_OTEL_COST_POLICY must be economy, balanced, or detailed")
	}
}

func validateCostPolicy(policy OTelCostPolicy, ratio float64, cardinality int, interval time.Duration) error {
	var maxRatio float64
	var maxCardinality int
	var minInterval time.Duration
	switch policy {
	case OTelCostEconomy:
		maxRatio, maxCardinality, minInterval = 0.10, 64, time.Minute
	case OTelCostBalanced:
		maxRatio, maxCardinality, minInterval = 0.25, 512, 30*time.Second
	case OTelCostDetailed:
		maxRatio, maxCardinality, minInterval = 1, 2_000, 10*time.Second
	default:
		return fmt.Errorf("LUMO_OTEL_COST_POLICY must be economy, balanced, or detailed")
	}
	if ratio > maxRatio {
		return fmt.Errorf("LUMO_OTEL_SAMPLE_RATIO exceeds the %s cost policy limit", policy)
	}
	if cardinality > maxCardinality {
		return fmt.Errorf("LUMO_OTEL_METRIC_CARDINALITY_MAX exceeds the %s cost policy limit", policy)
	}
	if interval < minInterval {
		return fmt.Errorf("LUMO_OTEL_METRIC_EXPORT_INTERVAL is shorter than the %s cost policy minimum", policy)
	}
	return nil
}

func envBool(name string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", name)
	}
	return parsed, nil
}

func envInt(name string, fallback, min, max int) (int, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < min || parsed > max {
		return 0, fmt.Errorf("%s must be an integer in [%d,%d]", name, min, max)
	}
	return parsed, nil
}

func envFloat(name string, fallback, min, max float64) (float64, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < min || parsed > max {
		return 0, fmt.Errorf("%s must be a number in [%g,%g]", name, min, max)
	}
	return parsed, nil
}

func envDuration(name string, fallback, min, max time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed < min || parsed > max {
		return 0, fmt.Errorf("%s must be a duration in [%s,%s]", name, min, max)
	}
	return parsed, nil
}

type configuredOTel struct{ exporter *otlpExporter }

var (
	otelMu     sync.Mutex
	activeOTel *configuredOTel
)

// ConfigureOTelFromEnv validates the shared policy and enables a process-wide
// exporter. Binaries call it before accepting traffic and defer its shutdown
// function to flush pending spans and metrics during graceful termination.
func ConfigureOTelFromEnv(_ context.Context, serviceName string) (func(context.Context) error, error) {
	cfg, err := OTelConfigFromEnv()
	if err != nil || !cfg.Enabled() {
		return func(context.Context) error { return err }, err
	}
	return ConfigureOTel(serviceName, cfg)
}

func ConfigureOTel(serviceName string, cfg OTelConfig) (func(context.Context) error, error) {
	if !cfg.Enabled() || strings.TrimSpace(serviceName) == "" {
		return nil, errors.New("an OTLP collector URL and service name are required")
	}
	exporter := newOTLPExporter(strings.TrimSpace(serviceName), cfg)
	otelMu.Lock()
	if activeOTel != nil {
		otelMu.Unlock()
		return nil, errors.New("OpenTelemetry is already configured for this process")
	}
	SetMetricCardinalityLimit(cfg.MetricCardinalityMax)
	active := &configuredOTel{exporter: exporter}
	activeOTel = active
	otelMu.Unlock()
	exporter.Start()
	return func(ctx context.Context) error {
		otelMu.Lock()
		if activeOTel == active {
			activeOTel = nil
		}
		otelMu.Unlock()
		return exporter.Shutdown(ctx)
	}, nil
}

// otlpSpan captures only fixed-cardinality HTTP fields. In particular it
// excludes URL paths, query strings, principals, tenant IDs, and correlation
// values: they are either sensitive or unbounded and belong in governed logs.
type otlpSpan struct {
	exporter  *otlpExporter
	traceID   string
	spanID    string
	parentID  string
	method    string
	startedAt time.Time
	status    atomic.Int64
	once      sync.Once
}

func sampleNewRootTrace() bool {
	otelMu.Lock()
	active := activeOTel
	otelMu.Unlock()
	if active == nil {
		// Preserve pre-OTLP W3C propagation semantics when no exporter is
		// configured. The bit is only a local sampling decision when OTLP is on.
		return true
	}
	return active.exporter.sample()
}

func startHTTPSpan(r *http.Request) *otlpSpan {
	otelMu.Lock()
	active := activeOTel
	otelMu.Unlock()
	if active == nil {
		return nil
	}
	traceID, parentID, parentSampled := traceIDs(Traceparent(r.Context()))
	if traceID == "" || !parentSampled {
		return nil
	}
	return &otlpSpan{exporter: active.exporter, traceID: traceID, spanID: newSpanID(), parentID: parentID, method: r.Method, startedAt: time.Now().UTC()}
}

func traceIDs(traceparent string) (traceID, parentID string, sampled bool) {
	parts := strings.Split(traceparent, "-")
	if len(parts) != 4 {
		return "", "", false
	}
	flags, err := strconv.ParseUint(parts[3], 16, 8)
	if err != nil {
		return "", "", false
	}
	return parts[1], parts[2], flags&1 == 1
}

func newSpanID() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err == nil {
		return hex.EncodeToString(raw[:])
	}
	_, traceparent := newTraceparent()
	_, spanID, _ := traceIDs(traceparent)
	return spanID
}

func (s *otlpSpan) RecordStatus(status int) {
	if s != nil {
		s.status.Store(int64(status))
	}
}

func (s *otlpSpan) End() {
	if s == nil {
		return
	}
	s.once.Do(func() { s.exporter.enqueue(s) })
}

type otlpExporter struct {
	tracesEndpoint  string
	metricsEndpoint string
	client          *http.Client
	service         string
	sampleRatio     float64
	interval        time.Duration
	startedAt       time.Time
	pending         chan *otlpSpan
	stop            chan struct{}
	done            chan struct{}
	stopOnce        sync.Once
	droppedSpans    atomic.Uint64
}

func newOTLPExporter(service string, cfg OTelConfig) *otlpExporter {
	return &otlpExporter{
		tracesEndpoint: cfg.CollectorURL + "/v1/traces", metricsEndpoint: cfg.CollectorURL + "/v1/metrics",
		client: ConfiguredHTTPClient(5 * time.Second), service: service, sampleRatio: cfg.SampleRatio, interval: cfg.MetricExportInterval,
		startedAt: time.Now().UTC(), pending: make(chan *otlpSpan, otlpPendingTraceMax), stop: make(chan struct{}), done: make(chan struct{}),
	}
}

func (e *otlpExporter) sample() bool {
	if e.sampleRatio <= 0 {
		return false
	}
	if e.sampleRatio >= 1 {
		return true
	}
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return false
	}
	value := uint64(raw[0])<<56 | uint64(raw[1])<<48 | uint64(raw[2])<<40 | uint64(raw[3])<<32 | uint64(raw[4])<<24 | uint64(raw[5])<<16 | uint64(raw[6])<<8 | uint64(raw[7])
	return float64(value)/float64(^uint64(0)) < e.sampleRatio
}

func (e *otlpExporter) enqueue(span *otlpSpan) {
	select {
	case e.pending <- span:
	default:
		e.droppedSpans.Add(1)
	}
}

func (e *otlpExporter) Start() {
	go func() {
		defer close(e.done)
		ticker := time.NewTicker(e.interval)
		defer ticker.Stop()
		batch := make([]*otlpSpan, 0, otlpTraceBatchMax)
		flush := func(ctx context.Context) {
			if len(batch) > 0 {
				_ = e.exportTraces(ctx, batch)
				batch = batch[:0]
			}
			_ = e.exportMetrics(ctx)
		}
		for {
			select {
			case span := <-e.pending:
				batch = append(batch, span)
				if len(batch) >= otlpTraceBatchMax {
					flush(context.Background())
				}
			case <-ticker.C:
				flush(context.Background())
			case <-e.stop:
				flush(context.Background())
				return
			}
		}
	}()
}

func (e *otlpExporter) Shutdown(ctx context.Context) error {
	e.stopOnce.Do(func() { close(e.stop) })
	select {
	case <-e.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (e *otlpExporter) post(ctx context.Context, endpoint string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := e.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("OTLP export returned %s", response.Status)
	}
	return nil
}

func (e *otlpExporter) resource() map[string]any {
	return map[string]any{"attributes": []any{otlpStringAttribute("service.name", e.service)}}
}

func otlpStringAttribute(key, value string) map[string]any {
	return map[string]any{"key": key, "value": map[string]any{"stringValue": value}}
}

func (e *otlpExporter) exportTraces(ctx context.Context, spans []*otlpSpan) error {
	return e.post(ctx, e.tracesEndpoint, e.tracePayload(spans))
}

func (e *otlpExporter) tracePayload(spans []*otlpSpan) map[string]any {
	values := make([]any, 0, len(spans))
	for _, span := range spans {
		traceBytes, _ := hex.DecodeString(span.traceID)
		spanBytes, _ := hex.DecodeString(span.spanID)
		parentBytes, _ := hex.DecodeString(span.parentID)
		endedAt := time.Now().UTC()
		values = append(values, map[string]any{
			"traceId": base64.StdEncoding.EncodeToString(traceBytes), "spanId": base64.StdEncoding.EncodeToString(spanBytes), "parentSpanId": base64.StdEncoding.EncodeToString(parentBytes),
			"name": span.method, "kind": "SPAN_KIND_SERVER", "startTimeUnixNano": strconv.FormatInt(span.startedAt.UnixNano(), 10), "endTimeUnixNano": strconv.FormatInt(endedAt.UnixNano(), 10),
			"attributes": []any{otlpStringAttribute("http.request.method", span.method), map[string]any{"key": "http.response.status_code", "value": map[string]any{"intValue": strconv.FormatInt(span.status.Load(), 10)}}},
		})
	}
	return map[string]any{"resourceSpans": []any{map[string]any{"resource": e.resource(), "scopeSpans": []any{map[string]any{"scope": map[string]any{"name": "github.com/lumo-harness/observability"}, "spans": values}}}}}
}

func (e *otlpExporter) exportMetrics(ctx context.Context) error {
	return e.post(ctx, e.metricsEndpoint, e.metricsPayload())
}

func (e *otlpExporter) metricsPayload() map[string]any {
	pointTime := strconv.FormatInt(time.Now().UTC().UnixNano(), 10)
	startTime := strconv.FormatInt(e.startedAt.UnixNano(), 10)
	counter := func(name string, value uint64) map[string]any {
		return map[string]any{"name": name, "unit": "1", "sum": map[string]any{"aggregationTemporality": 2, "isMonotonic": true, "dataPoints": []any{map[string]any{"startTimeUnixNano": startTime, "timeUnixNano": pointTime, "asInt": strconv.FormatUint(value, 10)}}}}
	}
	gauge := func(name string, value float64) map[string]any {
		return map[string]any{"name": name, "gauge": map[string]any{"dataPoints": []any{map[string]any{"timeUnixNano": pointTime, "asDouble": value}}}}
	}
	metrics := []any{
		counter("lumo.http.server.request.count", Default.requests.Load()), counter("lumo.http.server.error.count", Default.errors.Load()),
		counter("lumo.observability.metric_series_dropped.count", Default.droppedGauges.Load()), counter("lumo.observability.trace_dropped.count", e.droppedSpans.Load()),
		gauge("lumo.http.server.inflight", float64(Default.inflight.Load())),
	}
	Default.gaugeMu.RLock()
	for name, value := range Default.gauges {
		metrics = append(metrics, gauge(name, value))
	}
	Default.gaugeMu.RUnlock()
	return map[string]any{"resourceMetrics": []any{map[string]any{"resource": e.resource(), "scopeMetrics": []any{map[string]any{"scope": map[string]any{"name": "github.com/lumo-harness/observability"}, "metrics": metrics}}}}}
}
