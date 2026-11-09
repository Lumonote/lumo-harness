// Package recoveryprovider implements an opt-in frozen PostgreSQL snapshot
// clone. It is not PITR and never replaces, drops or takes over an existing DB.
package recoveryprovider

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	bg "github.com/lumo-harness/platform/governance/internal/breakglass"
)

var identifier = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var opaque = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`)
var ErrRejected = errors.New("recovery provider request rejected")

type Route struct {
	Realm          string `json:"realm"`
	Namespace      string `json:"namespace"`
	TargetID       string `json:"target_id"`
	RecoveryPoint  string `json:"recovery_point"`
	SourceDatabase string `json:"source_database"`
	SourceOID      uint32 `json:"source_oid"`
	SourceMarker   string `json:"source_marker"`
	TargetDatabase string `json:"target_database"`
}
type Config struct {
	ID               string  `json:"id"`
	SystemIdentifier string  `json:"system_identifier"`
	Routes           []Route `json:"routes"`
}

func (c Config) Validate() error {
	if !identifier.MatchString(c.ID) || c.SystemIdentifier == "" || len(c.Routes) == 0 || len(c.Routes) > 64 {
		return ErrRejected
	}
	seen := map[string]bool{}
	logical := map[string]bool{}
	for _, route := range c.Routes {
		target := bg.Target{Operation: bg.Restore, Namespace: route.Namespace, TargetID: route.TargetID, RecoveryPoint: route.RecoveryPoint}
		if route.Realm == "" || len(route.Realm) > 256 || strings.TrimSpace(route.Realm) != route.Realm || target.Validate() != nil || !identifier.MatchString(route.SourceDatabase) || !identifier.MatchString(route.TargetDatabase) || route.SourceDatabase == route.TargetDatabase || route.SourceOID == 0 || !digestPattern.MatchString(route.SourceMarker) || seen[route.TargetDatabase] {
			return ErrRejected
		}
		seen[route.TargetDatabase] = true
		key, _ := json.Marshal([]string{route.Realm, route.Namespace, route.TargetID, route.RecoveryPoint})
		if logical[string(key)] {
			return ErrRejected
		}
		logical[string(key)] = true
	}
	return nil
}

func routeDigest(c Config, route Route) string {
	raw, _ := json.Marshal(struct {
		Version string
		ID      string
		Cluster string
		Route   Route
	}{"frozen-snapshot-clone.v1", c.ID, c.SystemIdentifier, route})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func executionIdentity(execution bg.Execution) string {
	execution.FencingToken = 0
	execution.Mode = ""
	raw, _ := json.Marshal(execution)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// This ledger belongs only to this independently deployed adapter. It must be
// stored outside any source snapshot or clone destination.
const ledgerDDL = `CREATE TABLE IF NOT EXISTS recovery_provider_clones (
 execution_id TEXT PRIMARY KEY,identity_digest TEXT NOT NULL,route_digest TEXT NOT NULL,
 target_database TEXT NOT NULL UNIQUE,fence BIGINT NOT NULL CHECK(fence>0),
 state TEXT NOT NULL CHECK(state IN ('claimed','succeeded')),target_oid OID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),completed_at TIMESTAMPTZ
);`

type Provider struct {
	config Config
	pool   *pgxpool.Pool
	dsn    string
	token  string
	key    []byte
}

func New(ctx context.Context, config Config, dsn, token, receiptKey string) (*Provider, error) {
	if config.Validate() != nil || len(token) < 32 || strings.TrimSpace(token) != token {
		return nil, ErrRejected
	}
	key, err := base64.StdEncoding.DecodeString(receiptKey)
	if err != nil || len(key) < 32 {
		return nil, ErrRejected
	}
	parsed, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, ErrRejected
	}
	for _, route := range config.Routes {
		if parsed.ConnConfig.Database == route.SourceDatabase || parsed.ConnConfig.Database == route.TargetDatabase {
			return nil, ErrRejected
		}
	}
	pool, err := pgxpool.NewWithConfig(ctx, parsed)
	if err != nil {
		return nil, err
	}
	config.Routes = append([]Route(nil), config.Routes...)
	p := &Provider{config: config, pool: pool, dsn: dsn, token: token, key: key}
	if err = p.checkCluster(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	_, err = pool.Exec(ctx, ledgerDDL)
	if err != nil {
		pool.Close()
		return nil, err
	}
	return p, nil
}
func (p *Provider) Close() { p.pool.Close() }

type queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (p *Provider) checkCluster(ctx context.Context, db queryer) error {
	var identity string
	if err := db.QueryRow(ctx, `SELECT system_identifier::text FROM pg_control_system()`).Scan(&identity); err != nil {
		return err
	}
	if identity != p.config.SystemIdentifier {
		return ErrRejected
	}
	return nil
}
func (p *Provider) route(execution bg.Execution) (Route, error) {
	if execution.Version != bg.ProtocolVersion || execution.ProviderID != p.config.ID || execution.Operation != bg.Restore || execution.Target.Validate() != nil || !opaque.MatchString(execution.RequestID) || !opaque.MatchString(execution.ExecutionID) || !digestPattern.MatchString(execution.RequestDigest) || execution.FencingToken < 1 || execution.IdempotencyKey != "lumo-recovery:"+execution.ExecutionID || (execution.Mode != "execute" && execution.Mode != "receipt") {
		return Route{}, ErrRejected
	}
	if _, err := time.Parse(time.RFC3339Nano, execution.ExpiresAt); err != nil {
		return Route{}, ErrRejected
	}
	for _, route := range p.config.Routes {
		if execution.Realm == route.Realm && execution.Namespace == route.Namespace && execution.TargetID == route.TargetID && execution.RecoveryPoint == route.RecoveryPoint {
			return route, nil
		}
	}
	return Route{}, ErrRejected
}
func (p *Provider) receipt(execution bg.Execution, outcome string) (bg.Receipt, error) {
	sum := sha256.Sum256([]byte(execution.ExecutionID))
	receipt := bg.Receipt{Execution: execution, Outcome: outcome, ReceiptID: "clone-" + hex.EncodeToString(sum[:16]), CompletedAt: time.Now().UTC()}
	var err error
	receipt.Signature, err = bg.SignReceipt(receipt, p.key)
	return receipt, err
}

// Handle serializes a target on one PostgreSQL session. A lost connection
// cannot trigger a fresh clone: the durable claim is written before the DDL.
func (p *Provider) Handle(ctx context.Context, execution bg.Execution) (bg.Receipt, error) {
	route, err := p.route(execution)
	if err != nil {
		return bg.Receipt{}, err
	}
	conn, err := p.pool.Acquire(ctx)
	if err != nil {
		return bg.Receipt{}, err
	}
	defer conn.Release()
	var locked bool
	if err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, "lumo-recovery-target:"+route.TargetDatabase).Scan(&locked); err != nil {
		return bg.Receipt{}, err
	}
	if !locked {
		return p.receipt(execution, "pending")
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if _, err := conn.Exec(unlockCtx, `RESET statement_timeout; RESET lock_timeout`); err != nil {
			_ = conn.Conn().Close(unlockCtx)
			return
		}
		var unlocked bool
		if conn.QueryRow(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, "lumo-recovery-target:"+route.TargetDatabase).Scan(&unlocked) != nil || !unlocked {
			_ = conn.Conn().Close(unlockCtx)
		}
	}()
	if err = p.checkCluster(ctx, conn); err != nil {
		return bg.Receipt{}, err
	}
	identity, routeHash := executionIdentity(execution), routeDigest(p.config, route)
	var recordedIdentity, recordedRoute, state string
	var fence int64
	var targetOID *uint32
	err = conn.QueryRow(ctx, `SELECT identity_digest,route_digest,fence,state,target_oid FROM recovery_provider_clones WHERE execution_id=$1`, execution.ExecutionID).Scan(&recordedIdentity, &recordedRoute, &fence, &state, &targetOID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return bg.Receipt{}, err
	}
	if err == nil {
		if recordedIdentity != identity || recordedRoute != routeHash || execution.FencingToken < fence {
			return bg.Receipt{}, ErrRejected
		}
		if _, err = conn.Exec(ctx, `UPDATE recovery_provider_clones SET fence=$2 WHERE execution_id=$1 AND fence<=$2`, execution.ExecutionID, execution.FencingToken); err != nil {
			return bg.Receipt{}, err
		}
		return p.reconcile(ctx, conn, execution, route, identity, targetOID)
	}
	if execution.Mode == "receipt" {
		return p.receipt(execution, "not_found")
	}
	var valid bool
	if err = conn.QueryRow(ctx, `SELECT $1::timestamptz>clock_timestamp()`, execution.ExpiresAt).Scan(&valid); err != nil {
		return bg.Receipt{}, err
	}
	if !valid {
		return p.receipt(execution, "rejected")
	}
	var exists bool
	if err = conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)`, route.TargetDatabase).Scan(&exists); err != nil {
		return bg.Receipt{}, err
	}
	if exists {
		return p.receipt(execution, "pending")
	}
	var sourceOID uint32
	var allowed bool
	var marker string
	if err = conn.QueryRow(ctx, `SELECT oid,datallowconn,COALESCE(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname=$1`, route.SourceDatabase).Scan(&sourceOID, &allowed, &marker); err != nil {
		return bg.Receipt{}, err
	}
	if sourceOID != route.SourceOID || allowed || marker != "lumo-frozen-snapshot:"+route.SourceMarker {
		return bg.Receipt{}, ErrRejected
	}
	// Recheck expiry in the claim INSERT after waiting for the target/source facts.
	command, err := conn.Exec(ctx, `INSERT INTO recovery_provider_clones(execution_id,identity_digest,route_digest,target_database,fence,state) SELECT $1,$2,$3,$4,$5,'claimed' WHERE $6::timestamptz>clock_timestamp() ON CONFLICT DO NOTHING`, execution.ExecutionID, identity, routeHash, route.TargetDatabase, execution.FencingToken, execution.ExpiresAt)
	if err != nil {
		return bg.Receipt{}, err
	}
	if command.RowsAffected() != 1 {
		return p.receipt(execution, "pending")
	}
	// CREATE DATABASE cannot share a transaction with the durable claim. Re-read
	// the frozen source and DB clock after claim (including any trigger waits),
	// then bound DDL lock/execution to the remaining authorized interval.
	var remainingMS int64
	if err = conn.QueryRow(ctx, `SELECT oid,datallowconn,COALESCE(shobj_description(oid,'pg_database'),''),FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz-clock_timestamp()))*1000)::bigint FROM pg_database WHERE datname=$1`, route.SourceDatabase, execution.ExpiresAt).Scan(&sourceOID, &allowed, &marker, &remainingMS); err != nil {
		return p.receipt(execution, "pending")
	}
	if remainingMS < 1 || sourceOID != route.SourceOID || allowed || marker != "lumo-frozen-snapshot:"+route.SourceMarker {
		return p.receipt(execution, "pending")
	}
	if remainingMS > 25000 {
		remainingMS = 25000
	}
	if _, err = conn.Exec(ctx, `SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$1,false)`, strconv.FormatInt(remainingMS, 10)+"ms"); err != nil {
		return p.receipt(execution, "pending")
	}
	// Any error from here is unknown, even if the server may have committed.
	_, err = conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{route.TargetDatabase}.Sanitize()+" WITH TEMPLATE "+pgx.Identifier{route.SourceDatabase}.Sanitize())
	if err != nil {
		return p.receipt(execution, "pending")
	}
	if err = conn.QueryRow(ctx, `SELECT oid,datallowconn,COALESCE(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname=$1`, route.SourceDatabase).Scan(&sourceOID, &allowed, &marker); err != nil || sourceOID != route.SourceOID || allowed || marker != "lumo-frozen-snapshot:"+route.SourceMarker {
		return p.receipt(execution, "pending")
	}
	var oid uint32
	if err = conn.QueryRow(ctx, `SELECT oid FROM pg_database WHERE datname=$1`, route.TargetDatabase).Scan(&oid); err != nil {
		return p.receipt(execution, "pending")
	}
	markerValue := "lumo-frozen-clone:" + identity + ":" + routeHash
	if _, err = conn.Exec(ctx, "COMMENT ON DATABASE "+pgx.Identifier{route.TargetDatabase}.Sanitize()+" IS '"+markerValue+"'"); err != nil {
		return p.receipt(execution, "pending")
	}
	if _, err = conn.Exec(ctx, `UPDATE recovery_provider_clones SET target_oid=$2 WHERE execution_id=$1 AND target_oid IS NULL`, execution.ExecutionID, oid); err != nil {
		return p.receipt(execution, "pending")
	}
	return p.reconcile(ctx, conn, execution, route, identity, &oid)
}

func (p *Provider) reconcile(ctx context.Context, conn *pgxpool.Conn, execution bg.Execution, route Route, identity string, expectedOID *uint32) (bg.Receipt, error) {
	var oid uint32
	var marker string
	var allowed bool
	err := conn.QueryRow(ctx, `SELECT oid,datallowconn,COALESCE(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname=$1`, route.TargetDatabase).Scan(&oid, &allowed, &marker)
	if err != nil {
		return p.receipt(execution, "pending")
	}
	// No marker or a changed OID remains unknown. Receipt mode never creates it.
	if marker != "lumo-frozen-clone:"+identity+":"+routeDigest(p.config, route) || !allowed || expectedOID != nil && oid != *expectedOID {
		return p.receipt(execution, "pending")
	}
	config, err := pgx.ParseConfig(p.dsn)
	if err != nil {
		return bg.Receipt{}, err
	}
	config.Database = route.TargetDatabase
	target, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return p.receipt(execution, "pending")
	}
	defer target.Close(context.Background())
	var database string
	if err = target.QueryRow(ctx, `SELECT current_database()`).Scan(&database); err != nil || database != route.TargetDatabase {
		return p.receipt(execution, "pending")
	}
	if _, err = conn.Exec(ctx, `UPDATE recovery_provider_clones SET state='succeeded',target_oid=$2,completed_at=COALESCE(completed_at,clock_timestamp()) WHERE execution_id=$1`, execution.ExecutionID, oid); err != nil {
		return p.receipt(execution, "pending")
	}
	return p.receipt(execution, "succeeded")
}

func (p *Provider) Handler() http.Handler {
	mux := http.NewServeMux()
	for _, mode := range []string{"execute", "receipt"} {
		mode := mode
		mux.HandleFunc("POST /"+mode, func(w http.ResponseWriter, r *http.Request) {
			if !hmac.Equal([]byte(r.Header.Get("Authorization")), []byte("Bearer "+p.token)) {
				http.Error(w, "denied", http.StatusUnauthorized)
				return
			}
			raw, err := io.ReadAll(io.LimitReader(r.Body, (32<<10)+1))
			if err != nil || len(raw) > 32<<10 {
				http.Error(w, "invalid", 400)
				return
			}
			var execution bg.Execution
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&execution) != nil || decoder.Decode(new(any)) != io.EOF || execution.Mode != mode || r.Header.Get("Idempotency-Key") != execution.IdempotencyKey {
				http.Error(w, "invalid", 400)
				return
			}
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 30*time.Second)
			defer cancel()
			receipt, err := p.Handle(ctx, execution)
			if err != nil {
				http.Error(w, "unavailable or rejected", 503)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(receipt)
		})
	}
	return mux
}
