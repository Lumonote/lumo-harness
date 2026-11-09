package recoveryprovider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	bg "github.com/lumo-harness/platform/governance/internal/breakglass"
)

type fixture struct {
	provider *Provider
	admin    *pgxpool.Pool
	config   Config
	dsn      string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN is required for real frozen snapshot clone tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("lumo_clone_%d", time.Now().UnixNano())
	source, ledger, target := name+"_src", name+"_ledger", name+"_target"
	for _, database := range []string{source, ledger} {
		if _, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{database}.Sanitize()+" TEMPLATE template0"); err != nil {
			t.Fatal(err)
		}
	}
	config := Config{ID: "reference", Routes: []Route{{Realm: "realm-a", Namespace: "snapshots", TargetID: "tenant-a/new", RecoveryPoint: "snapshot-1", SourceDatabase: source, SourceMarker: strings.Repeat("a", 64), TargetDatabase: target}}}
	if err = admin.QueryRow(ctx, `SELECT system_identifier::text FROM pg_control_system()`).Scan(&config.SystemIdentifier); err != nil {
		t.Fatal(err)
	}
	if err = admin.QueryRow(ctx, `SELECT oid FROM pg_database WHERE datname=$1`, source).Scan(&config.Routes[0].SourceOID); err != nil {
		t.Fatal(err)
	}
	withDB := func(database string) string {
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		u.Path = "/" + database
		q := u.Query()
		q.Del("search_path")
		u.RawQuery = q.Encode()
		return u.String()
	}
	snapshot, err := pgx.Connect(ctx, withDB(source))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = snapshot.Exec(ctx, `CREATE TABLE snapshot_proof (id INTEGER PRIMARY KEY,value TEXT NOT NULL); INSERT INTO snapshot_proof VALUES(1,'independent snapshot bytes')`); err != nil {
		t.Fatal(err)
	}
	if err = snapshot.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = admin.Exec(ctx, "COMMENT ON DATABASE "+pgx.Identifier{source}.Sanitize()+" IS 'lumo-frozen-snapshot:"+config.Routes[0].SourceMarker+"'"); err != nil {
		t.Fatal(err)
	}
	if _, err = admin.Exec(ctx, "ALTER DATABASE "+pgx.Identifier{source}.Sanitize()+" ALLOW_CONNECTIONS false"); err != nil {
		t.Fatal(err)
	}
	adapter, err := New(ctx, config, withDB(ledger), strings.Repeat("t", 32), base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32))))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		adapter.Close()
		for _, database := range []string{target, source, ledger} {
			if _, err := admin.Exec(context.Background(), "DROP DATABASE IF EXISTS "+pgx.Identifier{database}.Sanitize()); err != nil {
				t.Error(err)
			}
		}
		admin.Close()
	})
	return fixture{adapter, admin, config, withDB(ledger)}
}
func execution() bg.Execution {
	return bg.Execution{Version: bg.ProtocolVersion, ProviderID: "reference", RequestID: "request-1", Realm: "realm-a", Target: bg.Target{Operation: bg.Restore, Namespace: "snapshots", TargetID: "tenant-a/new", RecoveryPoint: "snapshot-1"}, RequestDigest: strings.Repeat("b", 64), ExecutionID: "execution-1", IdempotencyKey: "lumo-recovery:execution-1", FencingToken: 1, Mode: "execute", ExpiresAt: time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)}
}
func exists(t *testing.T, f fixture) bool {
	t.Helper()
	var found bool
	if err := f.admin.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)`, f.config.Routes[0].TargetDatabase).Scan(&found); err != nil {
		t.Fatal(err)
	}
	return found
}

func TestLogicalNamespaceUsesGovernanceTargetContract(t *testing.T) {
	config := Config{ID: "reference", SystemIdentifier: "123", Routes: []Route{{
		Realm: "realm-a", Namespace: "tenant-backups", TargetID: "tenant-a/new", RecoveryPoint: "snapshot-1",
		SourceDatabase: "frozen_source", SourceOID: 1, SourceMarker: strings.Repeat("a", 64), TargetDatabase: "new_target",
	}}}
	if err := config.Validate(); err != nil {
		t.Fatalf("valid Governance namespace was rejected: %v", err)
	}
	config.Routes[0].SourceDatabase = "frozen-source"
	if err := config.Validate(); err == nil {
		t.Fatal("logical namespace support relaxed physical database identifiers")
	}
	config.Routes[0].SourceDatabase = "frozen_source"
	config.Routes[0].Namespace = "../other"
	if err := config.Validate(); err == nil {
		t.Fatal("invalid Governance namespace accepted")
	}
}

func TestFrozenSnapshotCloneAndSignedHTTPReconciliation(t *testing.T) {
	f := newFixture(t)
	server := httptest.NewServer(f.provider.Handler())
	defer server.Close()
	client := bg.ProviderConfig{ID: f.config.ID, Endpoint: server.URL, Token: strings.Repeat("t", 32), ReceiptKey: base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32))), Operations: []bg.Operation{bg.Restore}, Scopes: []bg.TargetScope{{Operation: bg.Restore, Realm: "realm-a", Namespace: "snapshots", Prefix: "tenant-a/"}}}
	e := execution()
	receipt, err := client.Call(context.Background(), e)
	if err != nil || receipt.Outcome != "succeeded" {
		t.Fatalf("%+v %v", receipt, err)
	}
	parsed, _ := pgx.ParseConfig(f.dsn)
	parsed.Database = f.config.Routes[0].TargetDatabase
	target, err := pgx.ConnectConfig(context.Background(), parsed)
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close(context.Background())
	var value string
	if err = target.QueryRow(context.Background(), `SELECT value FROM snapshot_proof WHERE id=1`).Scan(&value); err != nil || value != "independent snapshot bytes" {
		t.Fatalf("snapshot not cloned: %q %v", value, err)
	}
	e.Mode = "receipt"
	e.FencingToken = 2
	receipt, err = client.Call(context.Background(), e)
	if err != nil || receipt.Outcome != "succeeded" {
		t.Fatalf("receipt %+v %v", receipt, err)
	}
	e.FencingToken = 1
	if _, err = f.provider.Handle(context.Background(), e); err == nil {
		t.Fatal("lower fence accepted")
	}
}
func TestReceiptAndExpiredExecutionNeverCreateDatabase(t *testing.T) {
	f := newFixture(t)
	e := execution()
	e.Mode = "receipt"
	receipt, err := f.provider.Handle(context.Background(), e)
	if err != nil || receipt.Outcome != "not_found" || exists(t, f) {
		t.Fatalf("receipt mutated: %+v %v", receipt, err)
	}
	e.Mode = "execute"
	e.ExpiresAt = time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	receipt, err = f.provider.Handle(context.Background(), e)
	if err != nil || receipt.Outcome != "rejected" || exists(t, f) {
		t.Fatalf("expiry mutated: %+v %v", receipt, err)
	}
}
func TestClaimedCrashWindowNeverRetriesDDL(t *testing.T) {
	f := newFixture(t)
	e := execution()
	_, err := f.provider.pool.Exec(context.Background(), `INSERT INTO recovery_provider_clones(execution_id,identity_digest,route_digest,target_database,fence,state) VALUES($1,$2,$3,$4,1,'claimed')`, e.ExecutionID, executionIdentity(e), routeDigest(f.config, f.config.Routes[0]), f.config.Routes[0].TargetDatabase)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"execute", "receipt"} {
		e.Mode = mode
		e.FencingToken++
		receipt, err := f.provider.Handle(context.Background(), e)
		if err != nil || receipt.Outcome != "pending" || exists(t, f) {
			t.Fatalf("claimed window replayed DDL: %+v %v", receipt, err)
		}
	}
}
func TestClaimedDatabaseWithoutExecutionMarkerRemainsUnknown(t *testing.T) {
	f := newFixture(t)
	e := execution()
	route := f.config.Routes[0]
	if _, err := f.provider.pool.Exec(context.Background(), `INSERT INTO recovery_provider_clones(execution_id,identity_digest,route_digest,target_database,fence,state) VALUES($1,$2,$3,$4,1,'claimed')`, e.ExecutionID, executionIdentity(e), routeDigest(f.config, route), route.TargetDatabase); err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(context.Background(), "CREATE DATABASE "+pgx.Identifier{route.TargetDatabase}.Sanitize()+" TEMPLATE "+pgx.Identifier{route.SourceDatabase}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"receipt", "execute"} {
		e.Mode = mode
		e.FencingToken++
		receipt, err := f.provider.Handle(context.Background(), e)
		if err != nil || receipt.Outcome != "pending" {
			t.Fatal("unmarked clone was taken over", receipt, err)
		}
	}
	var marker string
	if err := f.admin.QueryRow(context.Background(), `SELECT COALESCE(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname=$1`, route.TargetDatabase).Scan(&marker); err != nil || strings.HasPrefix(marker, "lumo-frozen-clone:") {
		t.Fatal("reconciliation wrote a success marker", marker, err)
	}
}
func TestExpiryAndSourceChangeDuringDurableClaimNeverStartDDL(t *testing.T) {
	for _, variant := range []string{"expiry", "source-marker", "source-unfrozen"} {
		t.Run(variant, func(t *testing.T) {
			f := newFixture(t)
			e := execution()
			body := ""
			switch variant {
			case "expiry":
				e.ExpiresAt = time.Now().UTC().Add(150 * time.Millisecond).Format(time.RFC3339Nano)
				body = "PERFORM pg_sleep(0.3);"
			case "source-marker":
				body = "EXECUTE 'COMMENT ON DATABASE " + f.config.Routes[0].SourceDatabase + " IS ''changed-source-marker''';"
			case "source-unfrozen":
				body = "EXECUTE 'ALTER DATABASE " + f.config.Routes[0].SourceDatabase + " ALLOW_CONNECTIONS true';"
			}
			if _, err := f.provider.pool.Exec(context.Background(), "CREATE FUNCTION claim_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "+body+" RETURN NEW; END $$; CREATE TRIGGER claim_fixture AFTER INSERT ON recovery_provider_clones FOR EACH ROW EXECUTE FUNCTION claim_fixture()"); err != nil {
				t.Fatal(err)
			}
			receipt, err := f.provider.Handle(context.Background(), e)
			if err != nil || receipt.Outcome != "pending" || exists(t, f) {
				t.Fatalf("post-claim facts ignored: %+v %v", receipt, err)
			}
			var rows int
			if err = f.provider.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM recovery_provider_clones WHERE state='claimed'`).Scan(&rows); err != nil || rows != 1 {
				t.Fatal("lost durable unknown fence", err)
			}
		})
	}
}
func TestExistingUnmarkedTargetIsNeverTakenOver(t *testing.T) {
	f := newFixture(t)
	_, err := f.admin.Exec(context.Background(), "CREATE DATABASE "+pgx.Identifier{f.config.Routes[0].TargetDatabase}.Sanitize()+" TEMPLATE template0")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := f.provider.Handle(context.Background(), execution())
	if err != nil || receipt.Outcome != "pending" {
		t.Fatalf("unmarked target accepted: %+v %v", receipt, err)
	}
	var rows int
	if err = f.provider.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM recovery_provider_clones`).Scan(&rows); err != nil || rows != 0 {
		t.Fatal("existing target was claimed", err)
	}
}
func TestConcurrentExecutionsCannotCloneTheSameTargetTwice(t *testing.T) {
	f := newFixture(t)
	e := execution()
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			request := e
			if index == 1 {
				request.ExecutionID = "execution-2"
				request.IdempotencyKey = "lumo-recovery:execution-2"
			}
			receipt, err := f.provider.Handle(context.Background(), request)
			if err != nil {
				errors <- err
			} else if receipt.Outcome != "succeeded" && receipt.Outcome != "pending" {
				errors <- fmt.Errorf("unexpected %s", receipt.Outcome)
			}
		}(i)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	var rows int
	if err := f.provider.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM recovery_provider_clones`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("concurrent claims: %d %v", rows, err)
	}
}
func TestMappingChangeAndSourceUnfreezeFailClosed(t *testing.T) {
	f := newFixture(t)
	e := execution()
	receipt, err := f.provider.Handle(context.Background(), e)
	if err != nil || receipt.Outcome != "succeeded" {
		t.Fatalf("%+v %v", receipt, err)
	}
	oldMarker := f.provider.config.Routes[0].SourceMarker
	f.provider.config.Routes[0].SourceMarker = strings.Repeat("c", 64)
	e.Mode = "receipt"
	e.FencingToken++
	if _, err = f.provider.Handle(context.Background(), e); err == nil {
		t.Fatal("mapping change reused old execution")
	}
	f.provider.config.Routes[0].SourceMarker = oldMarker
	e = execution()
	e.ExecutionID = "second-execution"
	e.IdempotencyKey = "lumo-recovery:second-execution"
	f.provider.config.Routes[0].TargetDatabase += "_next"
	_, err = f.admin.Exec(context.Background(), "ALTER DATABASE "+pgx.Identifier{f.config.Routes[0].SourceDatabase}.Sanitize()+" ALLOW_CONNECTIONS true")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.provider.Handle(context.Background(), e); err == nil {
		t.Fatal("live source accepted as frozen snapshot")
	}
}
func TestChangedSourceOIDCannotClaimOrCreate(t *testing.T) {
	f := newFixture(t)
	// An unchanged database name and marker cannot replace the configured OID.
	f.provider.config.Routes[0].SourceOID++
	if _, err := f.provider.Handle(context.Background(), execution()); err == nil || exists(t, f) {
		t.Fatal("changed source identity was cloned", err)
	}
	var rows int
	if err := f.provider.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM recovery_provider_clones`).Scan(&rows); err != nil || rows != 0 {
		t.Fatal("changed source identity was claimed", rows, err)
	}
}
func TestChangedTargetOIDRemainsUnknown(t *testing.T) {
	f := newFixture(t)
	e := execution()
	receipt, err := f.provider.Handle(context.Background(), e)
	if err != nil || receipt.Outcome != "succeeded" {
		t.Fatal(receipt, err)
	}
	if _, err = f.provider.pool.Exec(context.Background(), `UPDATE recovery_provider_clones SET target_oid=(target_oid::bigint+1)::oid WHERE execution_id=$1`, e.ExecutionID); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"receipt", "execute"} {
		e.Mode = mode
		e.FencingToken++
		receipt, err = f.provider.Handle(context.Background(), e)
		if err != nil || receipt.Outcome != "pending" {
			t.Fatal("database name and marker overrode different target OID", receipt, err)
		}
	}
}
func TestVaultReadbackIsGETOnlyAndNeverADeletionReceipt(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.Header.Get("X-Vault-Token") != strings.Repeat("v", 32) {
			t.Error("unexpected Vault side effect or identity")
		}
		paths = append(paths, r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"name": "tenant_key", "latest_version": 2, "min_decryption_version": 1, "deletion_allowed": true}})
	}))
	defer server.Close()
	result, err := ReadVaultKey(context.Background(), VaultTarget{Endpoint: server.URL, Mount: "transit", Key: "tenant_key"}, strings.Repeat("v", 32))
	if err != nil || result.Status != "present" || result.LatestVersion != 2 || len(paths) != 1 || paths[0] != "/v1/transit/keys/tenant_key" {
		t.Fatalf("%+v %v", result, err)
	}
	absent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }))
	defer absent.Close()
	result, err = ReadVaultKey(context.Background(), VaultTarget{Endpoint: absent.URL, Mount: "transit", Key: "tenant_key"}, strings.Repeat("v", 32))
	if err != nil || result.Status != "absent" {
		t.Fatal(result, err)
	}
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, server.URL, 307) }))
	defer redirect.Close()
	if _, err = ReadVaultKey(context.Background(), VaultTarget{Endpoint: redirect.URL, Mount: "transit", Key: "tenant_key"}, strings.Repeat("v", 32)); err == nil {
		t.Fatal("Vault redirect accepted")
	}
}
func TestConfigAndProtocolRejectArbitraryTargets(t *testing.T) {
	f := Provider{config: Config{ID: "reference", Routes: []Route{{Realm: "realm-a", Namespace: "snapshots", TargetID: "tenant-a/new", RecoveryPoint: "snapshot-1"}}}}
	for _, change := range []func(*bg.Execution){func(e *bg.Execution) { e.Version = bg.LegacyProtocolVersion }, func(e *bg.Execution) { e.ExpiresAt = "" }, func(e *bg.Execution) { e.Realm = "foreign" }, func(e *bg.Execution) { e.TargetID = "tenant-a/other" }, func(e *bg.Execution) { e.Operation = bg.DestroyKey }, func(e *bg.Execution) { e.FencingToken = 0 }} {
		e := execution()
		change(&e)
		if _, err := f.route(e); err == nil {
			t.Fatal("invalid target accepted", e)
		}
	}
}
func TestConfigRejectsAmbiguousLogicalRoute(t *testing.T) {
	route := Route{Realm: "r", Namespace: "snapshots", TargetID: "tenant-a/new", RecoveryPoint: "point-1", SourceDatabase: "snapshot", SourceOID: 123, SourceMarker: strings.Repeat("a", 64), TargetDatabase: "new_target"}
	config := Config{ID: "reference", SystemIdentifier: "123", Routes: []Route{route}}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	route.TargetDatabase = "other_target"
	config.Routes = append(config.Routes, route)
	if config.Validate() == nil {
		t.Fatal("same logical route selected two physical destinations")
	}
}
