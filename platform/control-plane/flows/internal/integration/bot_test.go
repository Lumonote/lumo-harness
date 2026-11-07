package integration_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lumo-harness/platform/flows/internal/bot"
	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/engine"
	"github.com/lumo-harness/platform/flows/internal/store"
	"github.com/lumo-harness/platform/flows/internal/trigger"
)

func TestBotConcurrentDeliveryAndRestart(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	const count = 24
	ids := make(chan int64, count)
	errs := make(chan error, count)
	fresh := make(chan bool, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, dup, err := st.EnqueueBotTrigger(ctx, "r1", "c1", "m1", "bot.message", json.RawMessage(`{"text":"hello"}`))
			ids <- id
			errs <- err
			fresh <- !dup
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	close(fresh)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var first int64
	for id := range ids {
		if first == 0 {
			first = id
		}
		if id != first {
			t.Fatalf("different trigger %d != %d", id, first)
		}
	}
	freshCount := 0
	for f := range fresh {
		if f {
			freshCount++
		}
	}
	if freshCount != 1 {
		t.Fatalf("fresh=%d", freshCount)
	}
	var queued, receipts int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM flow_trigger_outbox`).Scan(&queued)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM flow_bot_receipts`).Scan(&receipts)
	if queued != 1 || receipts != 1 {
		t.Fatalf("outbox=%d receipts=%d", queued, receipts)
	}
	restarted := store.New(pool)
	if err := restarted.Init(ctx); err != nil {
		t.Fatal(err)
	}
	id, dup, err := restarted.EnqueueBotTrigger(ctx, "r1", "c1", "m1", "bot.message", json.RawMessage(`{"text":"hello"}`))
	if err != nil || !dup || id != first {
		t.Fatalf("restart replay: id=%d dup=%v err=%v", id, dup, err)
	}
	for _, tc := range []struct{ event, payload string }{{"bot.other", `{"text":"hello"}`}, {"bot.message", `{"text":"edited"}`}} {
		if _, _, err := st.EnqueueBotTrigger(ctx, "r1", "c1", "m1", tc.event, json.RawMessage(tc.payload)); !errors.Is(err, store.ErrBotMessageConflict) {
			t.Fatalf("expected conflict: %v", err)
		}
	}
	claimed, err := st.ClaimTriggers(ctx, "bot-worker", 100)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: %d %v", len(claimed), err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(claimed[0].Payload, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["channel"] != "c1" || envelope["message_id"] != "m1" || envelope["data"].(map[string]any)["text"] != "hello" {
		t.Fatalf("envelope: %+v", envelope)
	}
	// Identical external IDs are independent in each channel and realm.
	for _, scope := range [][2]string{{"r1", "c2"}, {"r2", "c1"}} {
		if _, dup, err := st.EnqueueBotTrigger(ctx, scope[0], scope[1], "m1", "bot.message", json.RawMessage(`{}`)); err != nil || dup {
			t.Fatalf("scope %+v: %v %v", scope, dup, err)
		}
	}
}

func TestBotReceiptFailureRollsBackOutbox(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `CREATE FUNCTION reject_bot_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced receipt failure'; END $$;
 CREATE TRIGGER fail_receipt BEFORE INSERT ON flow_bot_receipts FOR EACH ROW EXECUTE FUNCTION reject_bot_receipt();`)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.EnqueueBotTrigger(ctx, "r", "c", "m", "bot.message", json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected failed receipt")
	}
	for _, table := range []string{"flow_trigger_outbox", "flow_bot_receipts"} {
		var n int
		if err := pool.QueryRow(ctx, fmt.Sprintf("SELECT count(*) FROM %s", table)).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s: %d %v", table, n, err)
		}
	}
	if _, err := pool.Exec(ctx, `DROP TRIGGER fail_receipt ON flow_bot_receipts`); err != nil {
		t.Fatal(err)
	}
	if _, dup, err := st.EnqueueBotTrigger(ctx, "r", "c", "m", "bot.message", json.RawMessage(`{}`)); err != nil || dup {
		t.Fatalf("retry after repair: dup=%v err=%v", dup, err)
	}
}

// Real HTTP -> signed ingress -> PG -> outbox worker -> published automation ->
// engine -> run ledger. Retried HTTP delivery must not execute the operator twice.
func TestBotHTTPToPublishedAutomation(t *testing.T) {
	st, pool := newScheduleStore(t)
	ctx := context.Background()
	f, err := st.CreateFlow(ctx, "bot-flow", "p1", "r1", "Bot echo", "author1", def(t, "echo"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Review(ctx, f.ID, "reviewer", true, ""); err != nil {
		t.Fatal(err)
	}
	seedAutomation(t, pool, "bot-auto", "webhook", "bot.message", f.ID, true)
	channels, err := bot.ParseConfig([]byte(`[{"id":"alerts","realm":"r1","event":"bot.message","secret_env":"KEY"}]`), func(string) string { return strings.Repeat("k", 32) })
	if err != nil {
		t.Fatal(err)
	}
	protected := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(401) })
	srv := httptest.NewServer(bot.WithIngress(protected, st, channels, slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer srv.Close()
	send := func() string {
		t.Helper()
		stamp := strconv.FormatInt(time.Now().Unix(), 10)
		body := `{"text":"hello"}`
		mac := hmac.New(sha256.New, []byte(strings.Repeat("k", 32)))
		_, _ = mac.Write([]byte(stamp + "\nalerts\nm1\n" + body))
		req, _ := http.NewRequest("POST", srv.URL+"/v1/bot/events/alerts", strings.NewReader(body))
		req.Header.Set("X-Lumo-Bot-Id", "m1")
		req.Header.Set("X-Lumo-Bot-Timestamp", stamp)
		req.Header.Set("X-Lumo-Bot-Signature", "v1="+hex.EncodeToString(mac.Sum(nil)))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		if res.StatusCode != 202 {
			t.Fatalf("ingress %d: %s", res.StatusCode, b)
		}
		var receipt struct {
			ID string `json:"trigger_id"`
		}
		if err := json.Unmarshal(b, &receipt); err != nil {
			t.Fatal(err)
		}
		return receipt.ID
	}
	id := send()
	var calls atomic.Int32
	e := engine.New()
	e.Register("echo", func(_ context.Context, input any) (any, error) { calls.Add(1); return input, nil })
	bus := trigger.New()
	bus.Subscribe("*", func(ctx context.Context, event trigger.Event) error {
		bindings, err := st.PrepareTriggerBindings(ctx, event.ID, event.Realm)
		if err != nil {
			return err
		}
		if len(bindings) != 1 {
			return fmt.Errorf("expected one binding, got %d", len(bindings))
		}
		b := bindings[0]
		raw, _, err := st.GetVersion(ctx, b.FlowID, b.FlowVersion)
		if err != nil {
			return err
		}
		var definition domain.Definition
		if err := json.Unmarshal(raw, &definition); err != nil {
			return err
		}
		started, err := st.StartTriggerRun(ctx, event.ID, b.AutomationID, b.FlowID, b.FlowVersion)
		if err != nil || !started {
			return err
		}
		result, err := e.Run(ctx, &definition, event.Payload)
		if err != nil {
			return err
		}
		output, err := json.Marshal(result)
		if err != nil {
			return err
		}
		return st.FinishTriggerRun(ctx, event.ID, b.AutomationID, "succeeded", output, nil)
	})
	worker := trigger.NewWorker(st, bus, "bot-e2e")
	worker.SetTiming(10*time.Millisecond, time.Second, 1)
	failures := make(chan error, 16)
	worker.SetErrorHandler(func(err error) {
		select {
		case failures <- err:
		default:
		}
	})
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); worker.Run(runCtx) }()
	defer func() { cancel(); <-done }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var delivered bool
		if err := pool.QueryRow(ctx, `SELECT delivered_at IS NOT NULL FROM flow_trigger_outbox WHERE id=$1`, id).Scan(&delivered); err != nil {
			t.Fatal(err)
		}
		if delivered {
			break
		}
		select {
		case err := <-failures:
			t.Fatal(err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("outbox delivery timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if second := send(); second != id {
		t.Fatalf("retry created another trigger %s != %s", second, id)
	}
	if calls.Load() != 1 {
		t.Fatalf("operator calls=%d", calls.Load())
	}
	var status string
	var output []byte
	if err := pool.QueryRow(ctx, `SELECT status,output FROM flow_runs WHERE trigger_id=$1`, id).Scan(&status, &output); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" || !strings.Contains(string(output), `"message_id": "m1"`) {
		t.Fatalf("run: %s %s", status, output)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM flow_trigger_outbox`); n != 1 {
		t.Fatalf("outbox=%d", n)
	}
}
