package observability

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

type traceContextKey uint8

const (
	traceIDKey traceContextKey = iota
	traceparentKey
	correlationIDKey
)

var fallbackTraceCounter atomic.Uint64

// TraceID returns the W3C trace ID attached by Middleware. It is intentionally
// available to service handlers and outbound adapters without importing an
// OpenTelemetry SDK; deployments may bridge it to a collector later.
func TraceID(ctx context.Context) string {
	value, _ := ctx.Value(traceIDKey).(string)
	return value
}

// Traceparent returns the normalized W3C trace context attached by Middleware.
func Traceparent(ctx context.Context) string {
	value, _ := ctx.Value(traceparentKey).(string)
	return value
}

// CorrelationID returns a safe response/log correlation value. Client-supplied
// values are accepted only in a narrow ASCII form so no request header can be
// reflected into logs or response headers unchecked.
func CorrelationID(ctx context.Context) string {
	value, _ := ctx.Value(correlationIDKey).(string)
	return value
}

func withTraceContext(ctx context.Context, traceID, traceparent, correlationID string) context.Context {
	ctx = context.WithValue(ctx, traceIDKey, traceID)
	ctx = context.WithValue(ctx, traceparentKey, traceparent)
	return context.WithValue(ctx, correlationIDKey, correlationID)
}

func traceContextOf(traceparentHeader, correlationHeader string) (traceID, traceparent, correlationID string) {
	return traceContextOfWithSampling(traceparentHeader, correlationHeader, true)
}

// traceContextOfWithSampling creates a new root trace with the sampling bit
// chosen by the local exporter. Existing upstream context is always preserved:
// a service must not change an upstream sampling decision.
func traceContextOfWithSampling(traceparentHeader, correlationHeader string, sampleRoot bool) (traceID, traceparent, correlationID string) {
	if parsedTraceID, normalized, ok := parseTraceparent(traceparentHeader); ok {
		traceID, traceparent = parsedTraceID, normalized
	} else {
		traceID, traceparent = newTraceparentWithSampling(sampleRoot)
	}
	if validCorrelationID(correlationHeader) {
		correlationID = strings.TrimSpace(correlationHeader)
	} else {
		correlationID = traceID
	}
	return traceID, traceparent, correlationID
}

// parseTraceparent accepts the W3C shape while rejecting reserved versions and
// all-zero IDs. We intentionally preserve the incoming parent/span rather
// than pretending this package creates an OTel child span.
func parseTraceparent(value string) (traceID, normalized string, ok bool) {
	parts := strings.Split(strings.TrimSpace(value), "-")
	if len(parts) != 4 || len(parts[0]) != 2 || len(parts[1]) != 32 || len(parts[2]) != 16 || len(parts[3]) != 2 {
		return "", "", false
	}
	for _, part := range parts {
		if _, err := hex.DecodeString(part); err != nil {
			return "", "", false
		}
	}
	version := strings.ToLower(parts[0])
	traceID = strings.ToLower(parts[1])
	spanID := strings.ToLower(parts[2])
	flags := strings.ToLower(parts[3])
	if version == "ff" || allZero(traceID) || allZero(spanID) {
		return "", "", false
	}
	return traceID, version + "-" + traceID + "-" + spanID + "-" + flags, true
}

func newTraceparent() (traceID, traceparent string) {
	return newTraceparentWithSampling(true)
}

func newTraceparentWithSampling(sampled bool) (traceID, traceparent string) {
	var bytes [24]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		// Entropy loss must not take down a control-plane request. This fallback
		// still creates an opaque, non-zero correlation value; it is not a
		// replacement for cryptographic randomness.
		seed := strconv.FormatInt(time.Now().UnixNano(), 10) + ":" + strconv.FormatUint(fallbackTraceCounter.Add(1), 10)
		sum := sha256.Sum256([]byte(seed))
		copy(bytes[:], sum[:24])
	}
	traceID = hex.EncodeToString(bytes[:16])
	spanID := hex.EncodeToString(bytes[16:])
	flags := "00"
	if sampled {
		flags = "01"
	}
	return traceID, "00-" + traceID + "-" + spanID + "-" + flags
}

func allZero(value string) bool {
	for _, c := range value {
		if c != '0' {
			return false
		}
	}
	return true
}

func validCorrelationID(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' {
			continue
		}
		return false
	}
	return true
}
