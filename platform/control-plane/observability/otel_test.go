package observability

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOTelConfigRejectsInsecureAndOverBudgetValues(t *testing.T) {
	t.Setenv("LUMO_OTEL_COLLECTOR_URL", "http://collector.internal:4318")
	if _, err := OTelConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "ALLOW_INSECURE") {
		t.Fatalf("HTTP collector must require explicit opt-in, got %v", err)
	}
	t.Setenv("LUMO_OTEL_ALLOW_INSECURE", "true")
	t.Setenv("LUMO_OTEL_COST_POLICY", "economy")
	t.Setenv("LUMO_OTEL_SAMPLE_RATIO", "0.5")
	if _, err := OTelConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "economy") {
		t.Fatalf("economy policy must constrain sampling, got %v", err)
	}
}

func TestOTelConfigAppliesCostPolicyDefaultsBeforeValidation(t *testing.T) {
	t.Setenv("LUMO_OTEL_COLLECTOR_URL", "https://collector.internal:4318")
	t.Setenv("LUMO_OTEL_COST_POLICY", "economy")
	config, err := OTelConfigFromEnv()
	if err != nil {
		t.Fatalf("economy defaults should be valid without overrides: %v", err)
	}
	if config.SampleRatio != 0.10 || config.MetricCardinalityMax != 64 || config.MetricExportInterval != time.Minute {
		t.Fatalf("unexpected economy defaults: %#v", config)
	}
}

func TestUnsampledOTelRootsDoNotPropagateSampled(t *testing.T) {
	otelMu.Lock()
	previous := activeOTel
	activeOTel = &configuredOTel{exporter: newOTLPExporter("test", OTelConfig{
		CollectorURL: "http://127.0.0.1:1", SampleRatio: 0, MetricCardinalityMax: 8,
		CostPolicy: OTelCostDetailed, MetricExportInterval: time.Minute,
	})}
	otelMu.Unlock()
	t.Cleanup(func() {
		otelMu.Lock()
		activeOTel = previous
		otelMu.Unlock()
	})

	metrics := &Metrics{}
	handler := metrics.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if got := response.Header().Get("traceparent"); !strings.HasSuffix(got, "-00") {
		t.Fatalf("unsampled root must propagate W3C sampled=0, got %q", got)
	}
	if len(activeOTel.exporter.pending) != 0 {
		t.Fatal("unsampled root must not enqueue a trace")
	}
}

func TestTraceIDsAcceptsTheW3CSampledBit(t *testing.T) {
	_, _, sampled := traceIDs("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-05")
	if !sampled {
		t.Fatal("the W3C sampled bit must be interpreted as a bit flag")
	}
}

func TestOTLPExporterBuildsTraceAndLowCardinalityMetrics(t *testing.T) {
	exporter := newOTLPExporter("lumo-observability-test", OTelConfig{
		CollectorURL: "https://collector.example", SampleRatio: 1, MetricCardinalityMax: 8,
		CostPolicy: OTelCostDetailed, MetricExportInterval: 5 * time.Second,
	})
	span := &otlpSpan{
		exporter: exporter, traceID: "4bf92f3577b34da6a3ce929d0e0e4736", spanID: "00f067aa0ba902b8", parentID: "00f067aa0ba902b7",
		method: "POST", startedAt: time.Now().UTC(),
	}
	span.RecordStatus(201)
	traces, err := json.Marshal(exporter.tracePayload([]*otlpSpan{span}))
	if err != nil {
		t.Fatalf("marshal traces: %v", err)
	}
	metrics, err := json.Marshal(exporter.metricsPayload())
	if err != nil {
		t.Fatalf("marshal metrics: %v", err)
	}
	if strings.Contains(string(traces), "private-id") || strings.Contains(string(traces), "do-not-export") {
		t.Fatalf("trace must not export URL path or query: %s", traces)
	}
	var tracePayload map[string]any
	if err := json.Unmarshal(traces, &tracePayload); err != nil {
		t.Fatalf("trace JSON: %v", err)
	}
	if _, ok := tracePayload["resourceSpans"]; !ok {
		t.Fatalf("not an OTLP trace payload: %s", traces)
	}
	if !strings.Contains(string(metrics), "lumo.http.server.request.count") {
		t.Fatalf("missing cumulative request metric: %s", metrics)
	}
}

func TestOTLPMetricsPayloadCarriesGaugeLabelsAsDataPointAttributes(t *testing.T) {
	isolatedDefault(t)
	SetGaugeWithLabels("lumo_scheduler_pending_tasks", 4, map[string]string{"cluster_id": "cn-north"})
	exporter := newOTLPExporter("lumo-observability-test", OTelConfig{
		CollectorURL: "https://collector.example", SampleRatio: 1, MetricCardinalityMax: 8,
		CostPolicy: OTelCostDetailed, MetricExportInterval: 5 * time.Second,
	})
	encoded, err := json.Marshal(exporter.metricsPayload())
	if err != nil {
		t.Fatalf("marshal metrics: %v", err)
	}
	// 两条导出路径必须看到同一组维度：Prometheus 侧是标签，OTLP 侧是 dataPoint
	// 属性。只给一边加标签，另一边就会出现多个同名、无从区分的 dataPoint，
	// 消费者只能合并或覆盖，两条路径就此静默分叉。
	body := string(encoded)
	if !strings.Contains(body, `"asDouble":4,"attributes":[{"key":"cluster_id","value":{"stringValue":"cn-north"}}]`) {
		t.Fatalf("OTLP 侧缺少 dataPoint 属性:\n%s", body)
	}
	if !strings.Contains(body, `"name":"lumo_scheduler_pending_tasks"`) {
		t.Fatalf("带标签的 gauge 未被导出:\n%s", body)
	}
	// 无标签的固定指标不应凭空长出空 attributes 数组。
	if strings.Contains(body, `"name":"lumo.http.server.inflight"`) && strings.Contains(body, `"asDouble":0,"attributes"`) {
		t.Fatalf("无标签指标不应带 attributes: %s", body)
	}
}
