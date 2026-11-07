package integration_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/flows/internal/bot"
	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/store"
)

func TestBotSignedSubjectDurableScopeAndReplay(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE TABLE governance_users(realm TEXT,id TEXT,status TEXT,PRIMARY KEY(realm,id));
		CREATE TABLE governance_bot_subjects(realm TEXT,channel TEXT,subject TEXT,user_id TEXT,status TEXT,revision BIGINT,PRIMARY KEY(realm,channel,subject));
		CREATE TABLE governance_bot_grants(realm TEXT,channel TEXT,subject TEXT,subject_user_id TEXT,subject_revision BIGINT,team_id TEXT,project_id TEXT,agent_id TEXT,capability TEXT,status TEXT,revision BIGINT);
		INSERT INTO governance_users VALUES ('r1','mapped-user','active'),('r1','replacement','active');
		INSERT INTO governance_bot_subjects VALUES ('r1','alerts','external-user','mapped-user','active',3);
		INSERT INTO governance_bot_grants VALUES ('r1','alerts','external-user','mapped-user',3,'team','p1','agent','delegation.create','active',7);`); err != nil {
		t.Fatal(err)
	}
	channels, err := bot.ParseConfig([]byte(`[{"id":"alerts","realm":"r1","event":"bot.message","secret_env":"KEY","require_subject":true}]`), func(string) string { return strings.Repeat("k", 32) })
	if err != nil {
		t.Fatal(err)
	}
	newHandler := func() http.Handler {
		return bot.WithIngress(http.NotFoundHandler(), store.New(pool), channels, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}
	body := `{"sender":"platform-admin","user_id":"forged","roles":["platform_admin"],"bot_scope":{"user_id":"forged","binding_revision":99}}`
	request := func(handler http.Handler, subject, id string) *httptest.ResponseRecorder {
		stamp := strconv.FormatInt(time.Now().Unix(), 10)
		mac := hmac.New(sha256.New, []byte(strings.Repeat("k", 32)))
		_, _ = mac.Write([]byte(stamp + "\nalerts\n" + id + "\n" + subject + "\n" + body))
		r := httptest.NewRequest(http.MethodPost, "/v1/bot/events/alerts", strings.NewReader(body))
		r.Header.Set("X-Lumo-Bot-Id", id)
		r.Header.Set("X-Lumo-Bot-Subject", subject)
		r.Header.Set("X-Lumo-Bot-Timestamp", stamp)
		r.Header.Set("X-Lumo-Bot-Signature", "v2="+hex.EncodeToString(mac.Sum(nil)))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	var wg sync.WaitGroup
	ids := make(chan string, 16)
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := request(newHandler(), "external-user", "message1")
			if w.Code != 202 {
				t.Errorf("delivery: %d %s", w.Code, w.Body)
				return
			}
			var receipt struct {
				ID string `json:"trigger_id"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &receipt); err != nil {
				t.Error(err)
				return
			}
			ids <- receipt.ID
		}()
	}
	wg.Wait()
	close(ids)
	var id string
	for got := range ids {
		if id == "" {
			id = got
		}
		if got != id {
			t.Fatalf("different receipt %s != %s", got, id)
		}
	}
	if id == "" {
		t.Fatal("no accepted delivery")
	}
	for _, table := range []string{"flow_bot_receipts", "flow_trigger_outbox"} {
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil || n != 1 {
			t.Fatalf("%s count=%d err=%v", table, n, err)
		}
	}
	assertScope := func(raw []byte) {
		t.Helper()
		var scope domain.BotScope
		if err := json.Unmarshal(raw, &scope); err != nil || scope.Channel != "alerts" || scope.Subject != "external-user" || scope.UserID != "mapped-user" || scope.BindingRevision != 3 || scope.MessageID != "message1" || len(scope.Grants) != 1 || scope.Grants[0].Revision != 7 || scope.Grants[0].TeamID != "team" || scope.Grants[0].AgentID != "agent" {
			t.Fatalf("wrong trusted scope: %s err=%v", raw, err)
		}
	}
	claimed, err := st.ClaimTriggers(ctx, "first-worker", 100)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: %d %v", len(claimed), err)
	}
	assertScope(claimed[0].BotScope)
	// An administrator may rebind a sender while a delivery is queued. A
	// duplicate or explicit replay must retain the original mapped principal.
	if _, err := pool.Exec(ctx, `UPDATE governance_bot_subjects SET user_id='replacement',revision=4;
		UPDATE governance_bot_grants SET subject_user_id='replacement',subject_revision=4,revision=8`); err != nil {
		t.Fatal(err)
	}
	w := request(newHandler(), "external-user", "message1")
	if w.Code != 202 || !strings.Contains(w.Body.String(), `"duplicate":true`) || !strings.Contains(w.Body.String(), `"trigger_id":"`+id+`"`) {
		t.Fatalf("restart retry: %d %s", w.Code, w.Body)
	}
	f, err := st.CreateFlow(ctx, "subject-flow", "p1", "r1", "Bot task", "author", def(t, "echo"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Review(ctx, f.ID, "reviewer", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.StartTriggerRun(ctx, claimed[0].ID, "automation", f.ID, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE flow_runs SET status='failed',error='interrupted' WHERE trigger_id=$1`, claimed[0].ID); err != nil {
		t.Fatal(err)
	}
	var runID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM flow_runs WHERE trigger_id=$1`, claimed[0].ID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	replay, err := store.New(pool).EnqueueReplay(ctx, f.ID, "r1", runID)
	if err != nil {
		t.Fatal(err)
	}
	var replayScope []byte
	if err := pool.QueryRow(ctx, `SELECT bot_scope FROM flow_trigger_outbox WHERE id=$1`, replay.TriggerID).Scan(&replayScope); err != nil {
		t.Fatal(err)
	}
	assertScope(replayScope)
	second, err := st.EnqueueReplay(ctx, f.ID, "r1", runID)
	if err != nil || !second.AlreadyQueued || second.TriggerID != replay.TriggerID {
		t.Fatalf("replay retry: %+v %v", second, err)
	}
	// A revoked mapping cannot enqueue a fresh delivery, even with a valid
	// channel signature and forged administrator fields in the JSON body.
	if _, err := pool.Exec(ctx, `UPDATE governance_bot_subjects SET status='revoked'`); err != nil {
		t.Fatal(err)
	}
	w = request(newHandler(), "external-user", "message2")
	if w.Code != 403 {
		t.Fatalf("revoked sender: %d %s", w.Code, w.Body)
	}
	w = request(newHandler(), "unknown-user", "message3")
	if w.Code != 403 {
		t.Fatalf("unmapped sender: %d %s", w.Code, w.Body)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM flow_trigger_outbox`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("unauthorized enqueue count=%d err=%v", count, err)
	}
}

func TestBotUpgradeMarksLegacyDeliveriesAndReplays(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	id, _, err := st.EnqueueBotTrigger(ctx, "r1", "legacy", "message1", "bot.message", json.RawMessage(`{"sender":"forged-admin"}`))
	if err != nil {
		t.Fatal(err)
	}
	f, err := st.CreateFlow(ctx, "legacy-bot-flow", "p1", "r1", "Legacy Bot", "author", def(t, "echo"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.StartTriggerRun(ctx, uint64(id), "automation", f.ID, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE flow_runs SET status='failed',error='interrupted' WHERE trigger_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	var runID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM flow_runs WHERE trigger_id=$1`, id).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	replay, err := st.EnqueueReplay(ctx, f.ID, "r1", runID)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate the pre-scope schema's existing queued deliveries and replays.
	if _, err := pool.Exec(ctx, `UPDATE flow_trigger_outbox SET bot_scope=NULL`); err != nil {
		t.Fatal(err)
	}
	if err := store.New(pool).Init(ctx); err != nil {
		t.Fatal(err)
	}
	for _, triggerID := range []uint64{uint64(id), replay.TriggerID} {
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT bot_scope FROM flow_trigger_outbox WHERE id=$1`, triggerID).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var scope domain.BotScope
		if err := json.Unmarshal(raw, &scope); err != nil || scope.Channel != "legacy" || scope.MessageID != "message1" || scope.Subject != "" || scope.UserID != "" || len(scope.Grants) != 0 {
			t.Fatalf("legacy trigger %d escaped Bot boundary: %s %v", triggerID, raw, err)
		}
	}
}
