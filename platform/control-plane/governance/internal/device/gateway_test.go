package device

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
)

func writePEM(t *testing.T, dir, name, blockType string, der []byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeKey(t *testing.T, dir, name string, key *ecdsa.PrivateKey) string {
	t.Helper()
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return writePEM(t, dir, name, "EC PRIVATE KEY", der)
}

func issue(t *testing.T, template, parent *x509.Certificate, parentKey *ecdsa.PrivateKey) (*x509.Certificate, *ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificate(rand.Reader, template, parent, &key.PublicKey, parentKey)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert, key, der
}

// gatewayStore gives the gateway a real schema. The device package had no test
// fixture before this, so the schema dance is repeated rather than shared.
//
// ConnectDevice reopens Scheduler's dispatch outbox, so the device channel
// cannot run against a governance-only schema even though governance's own Init
// never creates those tables. A real deployment shares one database with the
// Scheduler service; here only the columns that reopen touches are needed.
func gatewayStore(t *testing.T) (*store.Store, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN is required for device gateway tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	schema := "lumo_device_" + hex.EncodeToString(suffix[:])
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	s := store.New(pool)
	if err := s.Init(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS scheduler_tasks (
  task_id TEXT NOT NULL, attempt INTEGER NOT NULL, node_id TEXT NOT NULL,
  state TEXT NOT NULL, PRIMARY KEY (task_id, attempt, node_id));
CREATE TABLE IF NOT EXISTS scheduler_dispatch_outbox (
  id BIGSERIAL PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, node_id TEXT NOT NULL,
  delivered_at BIGINT, claimed_by TEXT, claimed_at BIGINT);`); err != nil {
		t.Fatal(err)
	}
	return s, pool
}

// The device channel accepts exactly three inbound message types. This pins the
// routing of task_result -- the only new one -- and the documented consequence
// of sending anything else: the connection is dropped outright. That is why the
// gateway has to be deployed before the devices are rolled, so it is worth a
// test of its own.
func TestDeviceGatewayRoutesTaskResults(t *testing.T) {
	s, pool := gatewayStore(t)
	ctx := context.Background()
	const realm, nodeID = "realm", "device-a"
	if _, err := pool.Exec(ctx, `INSERT INTO governance_users(realm,id,display_name,status) VALUES ($1,'employee','Employee','active')`, realm); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO governance_desktop_nodes
	  (realm,id,cluster_id,owner_user_id,display_name,os,arch,client_version,capacity,status,scheduling_eligible)
	  VALUES ($1,$2,'cluster','employee',$2,'macos','amd64','1.0.0',4,'ONLINE',false)`, realm, nodeID); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "lumo device test ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, BasicConstraintsValid: true,
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}

	_, serverKey, serverDER := issue(t, &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "device gateway"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}, DNSNames: []string{"localhost"},
	}, caCert, caKey)

	deviceCert, deviceKey, deviceDER := issue(t, &x509.Certificate{
		SerialNumber: big.NewInt(3), Subject: pkix.Name{CommonName: "device"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		URIs: []*url.URL{{Scheme: "spiffe", Host: "lumo-device", Path: "/realm/" + realm + "/node/" + nodeID}},
	}, caCert, caKey)

	// Enrolment stores the identity the gateway later re-derives from the
	// certificate itself: the subject public key hash and the serial.
	keyHash := sha256.Sum256(deviceCert.RawSubjectPublicKeyInfo)
	if _, err := pool.Exec(ctx, `INSERT INTO governance_device_connections
	  (realm,node_id,revision,public_key_hash,certificate_serial,certificate_expires)
	  VALUES ($1,$2,1,$3,$4,$5)`, realm, nodeID, hex.EncodeToString(keyHash[:]), deviceCert.SerialNumber.Text(16), deviceCert.NotAfter); err != nil {
		t.Fatal(err)
	}

	g, err := New(Options{
		Store: s, Listen: "127.0.0.1:0", PublicURL: "https://device.example", RegistryURL: "http://registry.example",
		ControlToken:   "internal",
		ServerCertFile: writePEM(t, dir, "server.pem", "CERTIFICATE", serverDER),
		ServerKeyFile:  writeKey(t, dir, "server.key", serverKey),
		IssuerCertFile: writePEM(t, dir, "ca.pem", "CERTIFICATE", caDER),
		IssuerKeyFile:  writeKey(t, dir, "ca.key", caKey),
	})
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /device/connect", g.connect)
	srv := httptest.NewUnstartedServer(mux)
	srv.TLS = g.tls
	srv.StartTLS()
	defer srv.Close()

	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	dialer := websocket.Dialer{TLSClientConfig: &tls.Config{
		MinVersion:   tls.VersionTLS13,
		RootCAs:      roots,
		Certificates: []tls.Certificate{{Certificate: [][]byte{deviceDER}, PrivateKey: deviceKey}},
	}}
	conn, resp, err := dialer.Dial("wss"+strings.TrimPrefix(srv.URL, "https")+"/device/connect", nil)
	if err != nil {
		if resp != nil {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("dial: %v (status %d, body %q)", err, resp.StatusCode, body)
		}
		t.Fatal(err)
	}
	defer conn.Close()
	closed := make(chan error, 1)
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				closed <- err
				return
			}
		}
	}()

	// The command is staged after the lease exists: connecting interrupts every
	// pending command for the node, so one seeded earlier would already be gone.
	lease, err := s.Device(ctx, realm, nodeID)
	if err != nil || lease.ConnectionID == "" {
		t.Fatalf("device lease = %#v, %v", lease, err)
	}
	if _, _, err := s.CreateDelegatedTaskWithRun(ctx, domain.DelegatedTask{
		ID: "task", Realm: realm, Title: "task", Intent: "produce the report",
		RequesterUserID: "employee", AssigneeUserID: "employee", AssigneeWorkerID: "user:employee",
		State: domain.DelegationRunning, BusinessState: domain.BusinessExecuting,
	}, domain.TaskRun{ID: "task-run-1", WorkerID: "user:employee", AssignedNodeID: nodeID, State: domain.DelegationRunning}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO governance_device_commands
	  (id,realm,node_id,actor_id,revision,connection_id,action,state,expires_at,run_id,attempt,session_ref)
	  VALUES ('cmd-1',$1,$2,'device-gateway',$3,$4,'execute_task','completed',now()+interval '5 minutes','task-run-1',1,'task-session')`,
		realm, nodeID, lease.Revision, lease.ConnectionID); err != nil {
		t.Fatal(err)
	}

	payload, err := json.Marshal(map[string]any{
		"task_id": "task", "run_id": "task-run-1", "state": "COMPLETED",
		"session_ref": "task-session", "node_id": nodeID, "summary": "analysis delivered",
	})
	if err != nil {
		t.Fatal(err)
	}
	frame, err := json.Marshal(Message{Type: "task_result", CommandID: "cmd-1", Result: payload})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, frame); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_results WHERE task_id='task'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("task result rows = %d after a task_result frame", n)
		}
		time.Sleep(50 * time.Millisecond)
	}
	task, err := s.GetDelegationTask(ctx, realm, "task")
	if err != nil || task.BusinessState != domain.BusinessVerifying {
		t.Fatalf("task after a device result: %#v, %v", task, err)
	}
	var audit int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_audit
	  WHERE realm=$1 AND task_id='task' AND event='execution_result' AND actor='device:'||$2`, realm, nodeID).Scan(&audit); err != nil || audit != 1 {
		t.Fatalf("device audit rows = %d, %v", audit, err)
	}

	// Anything the gateway does not model still drops the connection.
	unknown, err := json.Marshal(Message{Type: "not_a_message_type"})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, unknown); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("an unknown message type did not close the connection")
	}
}
