package bot

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lumo-harness/platform/flows/internal/store"
)

type Sink interface {
	EnqueueBotTrigger(context.Context, string, string, string, string, json.RawMessage) (int64, bool, error)
}

type subjectSink interface {
	EnqueueBotSubjectTrigger(context.Context, string, string, string, string, string, json.RawMessage) (int64, bool, error)
}

type Ingress struct {
	sink     Sink
	channels map[string]Channel
	log      *slog.Logger
	now      func() time.Time
}

// WithIngress exposes only this exact route without control-plane bearer auth.
// Every other route retains the supplied protected handler. No configured
// channels means no public ingress at all.
func WithIngress(protected http.Handler, sink Sink, channels []Channel, log *slog.Logger) http.Handler {
	if len(channels) == 0 {
		return protected
	}
	h := &Ingress{sink: sink, channels: map[string]Channel{}, log: log, now: time.Now}
	for _, c := range channels {
		h.channels[c.ID] = c
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/bot/events/{channel}", h.receive)
	mux.Handle("/", protected)
	return mux
}

func respond(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (h *Ingress) receive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		respond(w, 405, map[string]string{"error": "method_not_allowed"})
		return
	}
	c, ok := h.channels[r.PathValue("channel")]
	if !ok {
		respond(w, 404, map[string]string{"error": "unknown_channel"})
		return
	}
	mid, stamp := r.Header.Get("X-Lumo-Bot-Id"), r.Header.Get("X-Lumo-Bot-Timestamp")
	ts, err := strconv.ParseInt(stamp, 10, 64)
	now := h.now().Unix()
	if err != nil || ts < now-300 || ts > now+300 || !messageID.MatchString(mid) {
		respond(w, 401, map[string]string{"error": "invalid_signature"})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			respond(w, 413, map[string]string{"error": "payload_too_large"})
		} else {
			respond(w, 400, map[string]string{"error": "invalid_body"})
		}
		return
	}
	mac := hmac.New(sha256.New, c.secret)
	subject := r.Header.Get("X-Lumo-Bot-Subject")
	version := "v1="
	if c.RequireSubject {
		if !messageID.MatchString(subject) {
			respond(w, 401, map[string]string{"error": "invalid_signature"})
			return
		}
		version = "v2="
		_, _ = mac.Write([]byte(stamp + "\n" + c.ID + "\n" + mid + "\n" + subject + "\n"))
	} else {
		// A legacy channel authenticates no sender. Body fields and an unsigned
		// subject header must never manufacture an execution principal.
		subject = ""
		_, _ = mac.Write([]byte(stamp + "\n" + c.ID + "\n" + mid + "\n"))
	}
	_, _ = mac.Write(body)
	signature := r.Header.Get("X-Lumo-Bot-Signature")
	supplied, err := hex.DecodeString(strings.TrimPrefix(signature, version))
	if !strings.HasPrefix(signature, version) || err != nil || !hmac.Equal(supplied, mac.Sum(nil)) {
		respond(w, 401, map[string]string{"error": "invalid_signature"})
		return
	}
	if !json.Valid(body) {
		respond(w, 400, map[string]string{"error": "json_required"})
		return
	}
	var id int64
	var duplicate bool
	if c.RequireSubject {
		sink, ok := h.sink.(subjectSink)
		if !ok {
			respond(w, 503, map[string]string{"error": "sender_authorization_unavailable"})
			return
		}
		id, duplicate, err = sink.EnqueueBotSubjectTrigger(r.Context(), c.Realm, c.ID, mid, c.Event, subject, body)
	} else {
		id, duplicate, err = h.sink.EnqueueBotTrigger(r.Context(), c.Realm, c.ID, mid, c.Event, body)
	}
	if errors.Is(err, store.ErrBotSenderUnauthorized) {
		respond(w, 403, map[string]string{"error": "sender_not_authorized"})
		return
	}
	if errors.Is(err, store.ErrBotMessageConflict) {
		respond(w, 409, map[string]string{"error": "message_conflict"})
		return
	}
	if err != nil {
		h.log.Error("bot event enqueue failed", "channel", c.ID, "err", err)
		respond(w, 503, map[string]string{"error": "queue_unavailable"})
		return
	}
	// IDs are strings on the wire, avoiding JavaScript integer truncation.
	respond(w, 202, map[string]any{"status": "queued", "trigger_id": strconv.FormatInt(id, 10), "duplicate": duplicate})
}
