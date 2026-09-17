package observability

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// gaugeSeries 一条手动采集的序列。
//
// labels 是已渲染好的 `{a="b",c="d"}` 片段（无标签时为空串），供 Prometheus
// 文本输出直接拼接；attrs 是原始标签副本，供 OTLP 导出作为 dataPoint 属性。
// 两者都留是因为两条导出路径必须看到同一组维度——只给其中一条加标签，会让
// OTLP 侧出现多个同名且无从区分的 dataPoint，消费者只能合并或覆盖。
type gaugeSeries struct {
	labels string
	attrs  map[string]string
	value  float64
}

type Metrics struct {
	requests      atomic.Uint64
	errors        atomic.Uint64
	inflight      atomic.Int64
	latencySum    atomic.Uint64 // microseconds
	latencyN      atomic.Uint64
	latencyBuck   [7]atomic.Uint64
	droppedGauges atomic.Uint64
	gaugeMu       sync.RWMutex
	// key = name + "\x00" + labels，这样同一个名字下每个标签集是独立序列，
	// 基数预算按「序列」而不是按「名字」扣。
	gauges map[string]gaugeSeries
}

var Default = &Metrics{gauges: make(map[string]gaugeSeries)}

var defaultMetricCardinalityLimit atomic.Int64

func init() { defaultMetricCardinalityLimit.Store(defaultMetricCardinalityMax) }

var metricName = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)

// 标签名走 Prometheus 的 label 语法；标签**值**不在这里校验，因为合法值可以是
// 任意文本（realm、连接器 id），见 escapeLabelValue。
var labelName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// 一条序列上超过这个标签数就拒收。真正的护栏是基数上限，这里只是防止把
// /metrics 响应撑成无法阅读的形状。
const maxLabelsPerSeries = 16

// escapeLabelValue 按 Prometheus 文本格式转义标签值：反斜杠、双引号、换行。
// 选择转义而不是拒收——拒收会让一个含引号的连接器 id 静默丢失它的序列，
// 而「这条告警为什么不响」比「响应里多了一个转义字符」难查得多。
func escapeLabelValue(v string) string {
	v = strings.ReplaceAll(v, `\`, `\\`)
	v = strings.ReplaceAll(v, `"`, `\"`)
	return strings.ReplaceAll(v, "\n", `\n`)
}

// renderLabels 渲染标签片段；标签名非法或数量超限时返回 ok=false。
// 名字按字典序排序，保证同一组标签永远得到同一个 key。
func renderLabels(labels map[string]string) (string, bool) {
	if len(labels) == 0 {
		return "", true
	}
	if len(labels) > maxLabelsPerSeries {
		return "", false
	}
	names := make([]string, 0, len(labels))
	for name := range labels {
		if !labelName.MatchString(name) {
			return "", false
		}
		names = append(names, name)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteByte('{')
	for i, name := range names {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(name)
		b.WriteString(`="`)
		b.WriteString(escapeLabelValue(labels[name]))
		b.WriteByte('"')
	}
	b.WriteByte('}')
	return b.String(), true
}

func Middleware(next http.Handler) http.Handler      { return Default.Middleware(next) }
func Handler(w http.ResponseWriter, _ *http.Request) { Default.Write(w) }

// SetMetricCardinalityLimit applies the deployment's hard cap to the global
// manually-recorded gauges.  The cap counts **series**, not names: a name with
// three label sets spends three, because that is what Prometheus actually
// stores and what the scrape payload actually carries.
func SetMetricCardinalityLimit(limit int) {
	if limit > 0 {
		defaultMetricCardinalityLimit.Store(int64(limit))
	}
}

// SetGauge 更新一个无标签的 Prometheus gauge。
func SetGauge(name string, value float64) { SetGaugeWithLabels(name, value, nil) }

// SetGaugeWithLabels 更新一个带标签的 Prometheus gauge，用于需要按维度下钻的
// 指标（例如按 cluster_id 区分的节点与队列状态）。
//
// 名称与标签名只接受合法 Prometheus 标识符，避免把外部输入拼进 /metrics 响应；
// 标签值按文本格式转义（见 escapeLabelValue），不拒收。
//
// **任何**被拒收的序列都计入 lumo_observability_metric_series_dropped_total，
// 无论原因是格式非法还是基数超限。两类拒收在下游看起来完全一样——指标就是
// 不见了，告警就是不会响——所以只对其中一类计数，等于给另一类留了一个静默
// 消失的通道。丢弃数本身就是一条可告警的指标。
func SetGaugeWithLabels(name string, value float64, labels map[string]string) {
	if !metricName.MatchString(name) {
		Default.droppedGauges.Add(1)
		return
	}
	rendered, ok := renderLabels(labels)
	if !ok {
		Default.droppedGauges.Add(1)
		return
	}
	key := name + "\x00" + rendered
	Default.gaugeMu.Lock()
	if Default.gauges == nil {
		Default.gauges = make(map[string]gaugeSeries)
	}
	if _, exists := Default.gauges[key]; !exists && len(Default.gauges) >= int(defaultMetricCardinalityLimit.Load()) {
		Default.droppedGauges.Add(1)
		Default.gaugeMu.Unlock()
		return
	}
	// 复制一份标签：调用方通常复用一个 map 逐个更新多条序列，直接存引用会让
	// 先前写入的序列跟着被改掉。
	Default.gauges[key] = gaugeSeries{labels: rendered, attrs: copyLabels(labels), value: value}
	Default.gaugeMu.Unlock()
}

// copyLabels 复制标签，避免调用方复用同一个 map 时污染已写入的序列。
func copyLabels(labels map[string]string) map[string]string {
	if len(labels) == 0 {
		return nil
	}
	out := make(map[string]string, len(labels))
	for k, v := range labels {
		out[k] = v
	}
	return out
}

// GaugePoint 一条待发布的序列。Labels 为 nil 表示无标签的单条序列。
type GaugePoint struct {
	Labels map[string]string
	Value  float64
}

// ReplaceGauges 用 points **整体替换** name 下的所有序列。
//
// 与 SetGaugeWithLabels 的区别是「整体一致」与「只增不减」：增量写入无法表达
// 一个维度已经消失，于是序列会永远停在最后一次写入的值上——某集群的排队数在
// 队列清空后仍显示 100，对应告警永不解除。凡是指标值来自「对当前状态做一次
// 快照」的地方（按集群/按状态计数、按连接器的熔断状态）都必须用整体替换，
// 抓取才会看到当前完整且自洽的维度集合。
//
// 名字/标签非法或超基数上限的序列被拒收，计入
// lumo_observability_metric_series_dropped_total，与增量写入同一口径。
func ReplaceGauges(name string, points []GaugePoint) {
	if !metricName.MatchString(name) {
		Default.droppedGauges.Add(1)
		return
	}
	type prepared struct {
		key    string
		labels string
		attrs  map[string]string
		value  float64
	}
	// 渲染放在锁外：这一步只碰调用方传进来的数据，不读全局状态。
	batch := make([]prepared, 0, len(points))
	for _, point := range points {
		rendered, ok := renderLabels(point.Labels)
		if !ok {
			Default.droppedGauges.Add(1)
			continue
		}
		batch = append(batch, prepared{
			key: name + "\x00" + rendered, labels: rendered,
			attrs: copyLabels(point.Labels), value: point.Value,
		})
	}
	prefix := name + "\x00"
	Default.gaugeMu.Lock()
	defer Default.gaugeMu.Unlock()
	if Default.gauges == nil {
		Default.gauges = make(map[string]gaugeSeries)
	}
	// 先摘掉该名字下的全部旧序列再写入：这样新集合里重复出现的 (name,labels)
	// 不会把预算扣两次，而消失的维度是真的消失。只按前缀删——别的名字的序列
	// 必须原样保留，否则一次「刷新某集群的排队数」会顺手清掉别人的指标。
	for key := range Default.gauges {
		if strings.HasPrefix(key, prefix) {
			delete(Default.gauges, key)
		}
	}
	for _, point := range batch {
		if _, exists := Default.gauges[point.key]; !exists && len(Default.gauges) >= int(defaultMetricCardinalityLimit.Load()) {
			Default.droppedGauges.Add(1)
			continue
		}
		Default.gauges[point.key] = gaugeSeries{labels: point.labels, attrs: point.attrs, value: point.value}
	}
}

func (m *Metrics) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		_, _, inboundTraceparent := parseTraceparent(r.Header.Get("traceparent"))
		traceID, traceparent, correlationID := traceContextOfWithSampling(r.Header.Get("traceparent"), r.Header.Get("X-Lumo-Correlation-Id"), inboundTraceparent || sampleNewRootTrace())
		w.Header().Set("traceparent", traceparent)
		w.Header().Set("X-Lumo-Correlation-Id", correlationID)
		r.Header.Set("traceparent", traceparent)
		r = r.WithContext(withTraceContext(r.Context(), traceID, traceparent, correlationID))
		span := startHTTPSpan(r)
		defer span.End()
		if origin := os.Getenv("LUMO_CORS_ORIGIN"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Lumo-Correlation-Id, traceparent")
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
		span.RecordStatus(rw.status)
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
	names := make([]string, 0, len(m.gauges))
	byName := make(map[string][]gaugeSeries, len(m.gauges))
	for key, series := range m.gauges {
		name := key
		if i := strings.IndexByte(key, 0); i >= 0 {
			name = key[:i]
		}
		if _, seen := byName[name]; !seen {
			names = append(names, name)
		}
		byName[name] = append(byName[name], series)
	}
	m.gaugeMu.RUnlock()
	// 这里刻意**没有** lumo_service_up。它曾经存在，值恒为字面量 1——任何能读到这
	// 个响应的人都同时得到了「服务是活的」这个结论，所以它不携带任何信息。
	// 它唯一的作用是喂一条 `lumo_service_up == 0` 的告警，而那条告警因此永远不可能
	// 触发：一条看起来存在、实际结构性死掉的规则。
	// 「实例还活着吗」的正确信号是 Prometheus 自己的 up（抓取失败即 0，不依赖被监控
	// 方如实上报自己的死活）。删掉这个指标之后，任何再次引用它的告警都会在
	// platform/deploy/alerts-verify.sh 里因为「没有这个指标」而失败。
	fmt.Fprintf(w, "# TYPE lumo_http_requests_total counter\nlumo_http_requests_total %d\n# TYPE lumo_http_errors_total counter\nlumo_http_errors_total %d\n# TYPE lumo_observability_metric_series_dropped_total counter\nlumo_observability_metric_series_dropped_total %d\n# TYPE lumo_http_inflight gauge\nlumo_http_inflight %d\n# TYPE lumo_http_request_duration_seconds histogram\n", m.requests.Load(), m.errors.Load(), m.droppedGauges.Load(), m.inflight.Load())
	for i, bound := range bounds {
		fmt.Fprintf(w, "lumo_http_request_duration_seconds_bucket{le=\"%s\"} %d\n", bound, m.latencyBuck[i].Load())
	}
	fmt.Fprintf(w, "lumo_http_request_duration_seconds_bucket{le=\"+Inf\"} %d\nlumo_http_request_duration_seconds_sum %.6f\nlumo_http_request_duration_seconds_count %d\n", m.latencyN.Load(), float64(m.latencySum.Load())/1e6, m.latencyN.Load())
	// 每个名字只打一次 TYPE，其下所有序列排在一起；顺序稳定（名字字典序、
	// 序列按标签字典序）。map 迭代顺序随机会让每次抓取的行序都不同，既制造
	// 无意义的 diff，也让「同一序列是否出现过」无法用文本比对确认。
	sort.Strings(names)
	for _, name := range names {
		series := byName[name]
		sort.Slice(series, func(i, j int) bool { return series[i].labels < series[j].labels })
		fmt.Fprintf(w, "# TYPE %s gauge\n", name)
		for _, s := range series {
			fmt.Fprintf(w, "%s%s %g\n", name, s.labels, s.value)
		}
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
