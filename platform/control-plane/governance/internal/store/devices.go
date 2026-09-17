package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

const deviceDDL = `
CREATE TABLE IF NOT EXISTS governance_device_connections (
 realm TEXT NOT NULL, node_id TEXT NOT NULL,
 revision BIGINT NOT NULL DEFAULT 0, policy JSONB NOT NULL DEFAULT '{}'::jsonb,
 enrollment_hash TEXT NOT NULL DEFAULT '', enrollment_expires TIMESTAMPTZ,
 public_key_hash TEXT NOT NULL DEFAULT '', certificate_serial TEXT NOT NULL DEFAULT '', certificate_expires TIMESTAMPTZ,
 connection_id TEXT NOT NULL DEFAULT '', connection_expires TIMESTAMPTZ,
 applied_revision BIGINT NOT NULL DEFAULT 0, installed JSONB NOT NULL DEFAULT '[]'::jsonb,
 report_error TEXT NOT NULL DEFAULT '', last_report_at TIMESTAMPTZ,
 PRIMARY KEY(realm,node_id), FOREIGN KEY(realm,node_id) REFERENCES governance_desktop_nodes(realm,id)
);
CREATE TABLE IF NOT EXISTS governance_device_commands (
 id TEXT PRIMARY KEY, realm TEXT NOT NULL, node_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 revision BIGINT NOT NULL, connection_id TEXT NOT NULL, action TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued', body JSONB NOT NULL DEFAULT '{}'::jsonb,
 result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(realm,node_id) REFERENCES governance_desktop_nodes(realm,id)
);
CREATE INDEX IF NOT EXISTS governance_device_commands_pending ON governance_device_commands(realm,node_id,created_at);
ALTER TABLE governance_device_connections ADD COLUMN IF NOT EXISTS certificate_pem TEXT NOT NULL DEFAULT '';
ALTER TABLE governance_device_connections ADD COLUMN IF NOT EXISTS previous_certificate_serial TEXT NOT NULL DEFAULT '';
ALTER TABLE governance_device_connections ADD COLUMN IF NOT EXISTS renewal_replay_expires TIMESTAMPTZ;
ALTER TABLE governance_device_commands ADD COLUMN IF NOT EXISTS run_id TEXT NOT NULL DEFAULT '';
ALTER TABLE governance_device_commands ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE governance_device_commands ADD COLUMN IF NOT EXISTS session_ref TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS governance_device_commands_active_run
 ON governance_device_commands(realm,run_id)
 WHERE action='execute_task' AND run_id<>'' AND state IN ('queued','delivered');
-- Cancellation is dispatched by a repeating loop, so "one live cancel per run" has
-- to be an invariant rather than a check the loop remembers to make. Same shape as
-- the stop above: the moment the row leaves (queued, delivered) -- accepted,
-- rejected, or interrupted by a reconnect -- a fresh cancel becomes possible again.
CREATE UNIQUE INDEX IF NOT EXISTS governance_device_commands_active_cancel
 ON governance_device_commands(realm,run_id)
 WHERE action='cancel_task' AND run_id<>'' AND state IN ('queued','delivered');
`

type DeviceArtifact struct {
	Name          string `json:"name"`
	Version       string `json:"version"`
	Digest        string `json:"digest"`
	PayloadDigest string `json:"payload_digest,omitempty"`
}

type DevicePolicy struct {
	Root          string           `json:"root"`
	Name          string           `json:"name"`
	Version       string           `json:"version"`
	ClientVersion string           `json:"client_version"`
	Artifacts     []DeviceArtifact `json:"artifacts"`
	Scopes        []string         `json:"scopes"`
	Shape         map[string]bool  `json:"shape"`
	Plan          json.RawMessage  `json:"plan"`
}

type DeviceConnection struct {
	Realm                string           `json:"realm"`
	NodeID               string           `json:"node_id"`
	Owner                string           `json:"owner_user_id"`
	OS                   string           `json:"os"`
	Arch                 string           `json:"arch"`
	Status               string           `json:"status"`
	Revision             int64            `json:"revision"`
	Policy               DevicePolicy     `json:"policy"`
	PublicKeyHash        string           `json:"public_key_hash,omitempty"`
	CertificateSerial    string           `json:"certificate_serial,omitempty"`
	CertificateExpires   *time.Time       `json:"certificate_expires,omitempty"`
	CertificatePEM       string           `json:"-"`
	PreviousSerial       string           `json:"-"`
	RenewalReplayExpires *time.Time       `json:"-"`
	ConnectionID         string           `json:"-"`
	ConnectionExpires    *time.Time       `json:"connection_expires,omitempty"`
	AppliedRevision      int64            `json:"applied_revision"`
	Installed            []DeviceArtifact `json:"installed"`
	ReportError          string           `json:"report_error,omitempty"`
	LastReportAt         *time.Time       `json:"last_report_at,omitempty"`
}

type DeviceCommand struct {
	ID        string          `json:"id"`
	Action    string          `json:"action"`
	State     string          `json:"state"`
	Revision  int64           `json:"revision"`
	Body      json.RawMessage `json:"body"`
	Result    json.RawMessage `json:"result,omitempty"`
	ExpiresAt time.Time       `json:"expires_at"`
	CreatedAt time.Time       `json:"created_at"`
}

func deviceRandom() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b), err
}
func deviceHash(value string) string {
	h := sha256.Sum256([]byte(value))
	return hex.EncodeToString(h[:])
}

func (s *Store) InitDevices(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, deviceDDL)
	return err
}

func (s *Store) deviceLock(ctx context.Context, realm, id string) (pgx.Tx, DeviceConnection, error) {
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return nil, DeviceConnection{}, err
	}
	fail := func(err error) (pgx.Tx, DeviceConnection, error) {
		_ = tx.Rollback(ctx)
		return nil, DeviceConnection{}, err
	}
	d := DeviceConnection{Realm: realm, NodeID: id}
	err = tx.QueryRow(ctx, `SELECT n.owner_user_id,n.status,n.os,n.arch FROM governance_desktop_nodes n JOIN governance_users u ON u.realm=n.realm AND u.id=n.owner_user_id
 WHERE n.realm=$1 AND n.id=$2 AND u.status='active' FOR UPDATE OF n`, realm, id).Scan(&d.Owner, &d.Status, &d.OS, &d.Arch)
	if errors.Is(err, pgx.ErrNoRows) {
		return fail(ErrNotFound)
	}
	if err != nil {
		return fail(err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO governance_device_connections(realm,node_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, realm, id)
	if err != nil {
		return fail(err)
	}
	var policy, installed []byte
	err = tx.QueryRow(ctx, `SELECT revision,policy,public_key_hash,certificate_serial,certificate_expires,connection_id,connection_expires,applied_revision,installed,report_error,last_report_at,certificate_pem,previous_certificate_serial,renewal_replay_expires
 FROM governance_device_connections WHERE realm=$1 AND node_id=$2 FOR UPDATE`, realm, id).Scan(&d.Revision, &policy, &d.PublicKeyHash, &d.CertificateSerial, &d.CertificateExpires, &d.ConnectionID, &d.ConnectionExpires, &d.AppliedRevision, &installed, &d.ReportError, &d.LastReportAt, &d.CertificatePEM, &d.PreviousSerial, &d.RenewalReplayExpires)
	if err != nil {
		return fail(err)
	}
	if json.Unmarshal(policy, &d.Policy) != nil || json.Unmarshal(installed, &d.Installed) != nil {
		return fail(ErrBadRequest)
	}
	return tx, d, nil
}

func (s *Store) Device(ctx context.Context, realm, id string) (DeviceConnection, error) {
	tx, d, err := s.deviceLock(ctx, realm, id)
	if err != nil {
		return d, err
	}
	defer tx.Rollback(ctx)
	return d, tx.Commit(ctx)
}

func (s *Store) SetDevicePolicy(ctx context.Context, realm, id, actor string, expected int64, policy DevicePolicy) (DeviceConnection, error) {
	tx, d, err := s.deviceLock(ctx, realm, id)
	if err != nil {
		return d, err
	}
	defer tx.Rollback(ctx)
	if d.Status == "REVOKED" {
		return d, ErrForbidden
	}
	if d.Revision != expected {
		return d, ErrConflict
	}
	raw, err := json.Marshal(policy)
	if err != nil {
		return d, err
	}
	_, err = tx.Exec(ctx, `UPDATE governance_device_connections SET revision=revision+1,policy=$3,applied_revision=0,enrollment_hash='',enrollment_expires=NULL,report_error='policy_changed',connection_id='',connection_expires=NULL WHERE realm=$1 AND node_id=$2`, realm, id, raw)
	if err != nil {
		return d, err
	}
	_, err = tx.Exec(ctx, `UPDATE governance_desktop_nodes SET scheduling_eligible=false WHERE realm=$1 AND id=$2`, realm, id)
	if err != nil {
		return d, err
	}
	if err = interruptDeviceCommands(ctx, tx, realm, id, ""); err != nil {
		return d, err
	}
	if err = recordUserAdminEvent(ctx, tx, realm, d.Owner, "node_updated", actor, map[string]any{"node_id": id, "action": "device_policy", "revision": expected + 1}); err != nil {
		return d, err
	}
	d.Policy, d.Revision = policy, expected+1
	d.AppliedRevision, d.ReportError, d.ConnectionID, d.ConnectionExpires = 0, "policy_changed", "", nil
	return d, tx.Commit(ctx)
}

func (s *Store) IssueDeviceEnrollment(ctx context.Context, realm, id, actor string) (string, error) {
	token, err := deviceRandom()
	if err != nil {
		return "", err
	}
	tx, d, err := s.deviceLock(ctx, realm, id)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if d.Status != "PENDING_ACTIVATION" || d.Revision < 1 || len(d.Policy.Artifacts) == 0 {
		return "", ErrForbidden
	}
	_, err = tx.Exec(ctx, `UPDATE governance_device_connections SET enrollment_hash=$3,enrollment_expires=now()+interval '5 minutes' WHERE realm=$1 AND node_id=$2`, realm, id, deviceHash(token))
	if err != nil {
		return "", err
	}
	if err = recordUserAdminEvent(ctx, tx, realm, d.Owner, "node_updated", actor, map[string]any{"node_id": id, "action": "enrollment_issued"}); err != nil {
		return "", err
	}
	return token, tx.Commit(ctx)
}

func (s *Store) EnrollDevice(ctx context.Context, realm, id, code, keyHash, serial string, expiry time.Time) error {
	tx, d, err := s.deviceLock(ctx, realm, id)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if d.Status != "PENDING_ACTIVATION" || d.Revision < 1 {
		return ErrForbidden
	}
	var matches bool
	err = tx.QueryRow(ctx, `SELECT enrollment_hash=$3 AND enrollment_expires>now() FROM governance_device_connections WHERE realm=$1 AND node_id=$2`, realm, id, deviceHash(code)).Scan(&matches)
	if err != nil {
		return ErrForbidden
	}
	if !matches {
		return ErrForbidden
	}
	_, err = tx.Exec(ctx, `UPDATE governance_device_connections SET enrollment_hash='',enrollment_expires=NULL,public_key_hash=$3,certificate_serial=$4,certificate_expires=$5,
 connection_id='',connection_expires=NULL,applied_revision=0,report_error='',certificate_pem='',previous_certificate_serial='',renewal_replay_expires=NULL WHERE realm=$1 AND node_id=$2`, realm, id, keyHash, serial, expiry)
	if err != nil {
		return err
	}
	if err = recordUserAdminEvent(ctx, tx, realm, d.Owner, "node_updated", d.Owner, map[string]any{"node_id": id, "action": "device_enrolled", "certificate_serial": serial}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func deviceAuthenticated(d DeviceConnection, keyHash, serial string) bool {
	return d.Status != "REVOKED" && d.PublicKeyHash == keyHash && d.CertificateSerial == serial && d.CertificateExpires != nil && d.CertificateExpires.After(time.Now())
}

func (s *Store) AuthenticateDevice(ctx context.Context, realm, id, keyHash, serial string) (DeviceConnection, error) {
	d, err := s.Device(ctx, realm, id)
	if err != nil {
		return d, err
	}
	if !deviceAuthenticated(d, keyHash, serial) {
		return d, ErrForbidden
	}
	return d, nil
}

func deviceRenewalReplay(d DeviceConnection, keyHash, serial string) bool {
	return d.Status != "REVOKED" && d.PublicKeyHash == keyHash && d.PreviousSerial == serial &&
		d.RenewalReplayExpires != nil && d.RenewalReplayExpires.After(time.Now()) &&
		d.CertificatePEM != "" && d.CertificateExpires != nil && d.CertificateExpires.After(time.Now())
}

func (s *Store) AuthenticateDeviceRenewal(ctx context.Context, realm, id, keyHash, serial string) (DeviceConnection, error) {
	d, err := s.Device(ctx, realm, id)
	if err != nil {
		return d, err
	}
	if !deviceAuthenticated(d, keyHash, serial) && !deviceRenewalReplay(d, keyHash, serial) {
		return d, ErrForbidden
	}
	return d, nil
}

func (s *Store) RotateDeviceCertificate(ctx context.Context, realm, id, keyHash, oldSerial, newSerial, certificate string, expiry time.Time) (DeviceConnection, error) {
	tx, d, err := s.deviceLock(ctx, realm, id)
	if err != nil {
		return d, err
	}
	defer tx.Rollback(ctx)
	// A lost renewal response can be replayed briefly with the old certificate.
	// That certificate is never accepted on the command or artifact endpoints.
	if deviceRenewalReplay(d, keyHash, oldSerial) {
		return d, tx.Commit(ctx)
	}
	if !deviceAuthenticated(d, keyHash, oldSerial) {
		return d, ErrForbidden
	}
	_, err = tx.Exec(ctx, `UPDATE governance_device_connections SET previous_certificate_serial=certificate_serial,renewal_replay_expires=LEAST(certificate_expires,now()+interval '5 minutes'),certificate_serial=$3,certificate_expires=$4,certificate_pem=$5,connection_id='',connection_expires=NULL,applied_revision=0 WHERE realm=$1 AND node_id=$2`, realm, id, newSerial, expiry, certificate)
	if err != nil {
		return d, err
	}
	if err = recordUserAdminEvent(ctx, tx, realm, d.Owner, "node_updated", d.Owner, map[string]any{"node_id": id, "action": "certificate_rotated", "certificate_serial": newSerial}); err != nil {
		return d, err
	}
	d.CertificateSerial, d.CertificatePEM, d.CertificateExpires = newSerial, certificate, &expiry
	return d, tx.Commit(ctx)
}

func (s *Store) ConnectDevice(ctx context.Context, realm, id, keyHash, serial string) (string, error) {
	connection, err := deviceRandom()
	if err != nil {
		return "", err
	}
	tx, d, err := s.deviceLock(ctx, realm, id)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if !deviceAuthenticated(d, keyHash, serial) {
		return "", ErrForbidden
	}
	_, err = tx.Exec(ctx, `UPDATE governance_device_connections SET connection_id=$3,connection_expires=now()+interval '30 seconds',applied_revision=0 WHERE realm=$1 AND node_id=$2`, realm, id, connection)
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `UPDATE governance_desktop_nodes SET scheduling_eligible=false WHERE realm=$1 AND id=$2`, realm, id)
	if err != nil {
		return "", err
	}
	// A reconnect fences the old lease. Execution assignments are reopened by
	// the gateway dispatcher; management commands remain explicitly at-most-once.
	if err = interruptDeviceCommands(ctx, tx, realm, id, ""); err != nil {
		return "", err
	}
	return connection, tx.Commit(ctx)
}

func artifactsMatch(expected, actual []DeviceArtifact) bool {
	if len(expected) == 0 || len(expected) != len(actual) {
		return false
	}
	seen := map[string]DeviceArtifact{}
	for _, item := range actual {
		key := item.Name + "\x00" + item.Version
		if _, ok := seen[key]; ok {
			return false
		}
		seen[key] = item
	}
	for _, item := range expected {
		got, ok := seen[item.Name+"\x00"+item.Version]
		if !ok || got.Digest != item.Digest || got.PayloadDigest != item.PayloadDigest {
			return false
		}
	}
	return true
}

func (s *Store) DeviceHeartbeat(ctx context.Context, realm, id, keyHash, serial, connection string, revision int64, installed []DeviceArtifact, reportError, clientVersion, osName, arch string) (DeviceConnection, error) {
	tx, d, err := s.deviceLock(ctx, realm, id)
	if err != nil {
		return d, err
	}
	defer tx.Rollback(ctx)
	if !deviceAuthenticated(d, keyHash, serial) || d.ConnectionID != connection || d.ConnectionExpires == nil || !d.ConnectionExpires.After(time.Now()) {
		return d, ErrForbidden
	}
	if clientVersion != d.Policy.ClientVersion || osName != d.OS || arch != d.Arch {
		reportError = "reconcile_required"
	}
	converged := revision == d.Revision && reportError == "" && artifactsMatch(d.Policy.Artifacts, installed)
	if !converged && reportError == "" {
		reportError = "reconcile_required"
	}
	if reportError != "" && reportError != "reconcile_required" && reportError != "install_failed" {
		return d, ErrBadRequest
	}
	if !converged {
		revision = 0
		installed = []DeviceArtifact{}
	}
	raw, err := json.Marshal(installed)
	if err != nil {
		return d, err
	}
	_, err = tx.Exec(ctx, `UPDATE governance_device_connections SET connection_expires=now()+interval '30 seconds',applied_revision=$4,installed=$5,report_error=$6,last_report_at=now()
 WHERE realm=$1 AND node_id=$2 AND connection_id=$3`, realm, id, connection, revision, raw, reportError)
	if err != nil {
		return d, err
	}
	// A converged mTLS channel makes the employee's node eligible for task
	// delivery only. The desktop command still requires a durable local accept;
	// this does not grant an Agent runtime or a control-plane credential.
	_, err = tx.Exec(ctx, `UPDATE governance_desktop_nodes SET last_seen_at=now(),
 scheduling_eligible=CASE WHEN status IN ('DRAINING','REVOKED') THEN false ELSE $3 END,
 status=CASE WHEN status='DRAINING' THEN status WHEN $3 THEN 'ONLINE' ELSE 'PENDING_ACTIVATION' END WHERE realm=$1 AND id=$2`, realm, id, converged)
	if err != nil {
		return d, err
	}
	d.AppliedRevision, d.Installed, d.ReportError = revision, installed, reportError
	return d, tx.Commit(ctx)
}

func (s *Store) DisconnectDevice(ctx context.Context, realm, id, connection string) error {
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT id FROM governance_desktop_nodes WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, id); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE governance_device_connections SET connection_id='',connection_expires=NULL,applied_revision=0 WHERE realm=$1 AND node_id=$2 AND connection_id=$3`, realm, id, connection)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		if _, err = tx.Exec(ctx, `UPDATE governance_desktop_nodes SET scheduling_eligible=false,status=CASE WHEN status='ONLINE' THEN 'OFFLINE' ELSE status END WHERE realm=$1 AND id=$2`, realm, id); err != nil {
			return err
		}
	}
	if err = interruptDeviceCommands(ctx, tx, realm, id, connection); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// interruptDeviceCommands fences every command issued to the old connection.
// Only execute_task commands reopen Scheduler delivery; start/stop/reconcile
// preserve their existing explicit at-most-once management semantics.
func interruptDeviceCommands(ctx context.Context, tx pgx.Tx, realm, id, connection string) error {
	query := `UPDATE governance_device_commands SET state='interrupted',updated_at=now()
	 WHERE realm=$1 AND node_id=$2 AND state IN ('queued','delivered')`
	args := []any{realm, id}
	if connection != "" {
		query += ` AND connection_id=$3`
		args = append(args, connection)
	}
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE scheduler_dispatch_outbox o
	 SET delivered_at=NULL,claimed_by=NULL,claimed_at=NULL
	 FROM governance_device_commands q,scheduler_tasks s
	 WHERE q.realm=$1 AND q.node_id=$2 AND q.action='execute_task' AND q.state='interrupted'
	   AND o.task_id=q.run_id AND o.attempt=q.attempt AND o.node_id=q.node_id
	   AND s.task_id=o.task_id AND s.attempt=o.attempt AND s.node_id=o.node_id AND s.state='PLACED'
	   AND NOT EXISTS (SELECT 1 FROM governance_device_commands active
	     WHERE active.realm=q.realm AND active.run_id=q.run_id AND active.action='execute_task'
	       AND active.state IN ('queued','delivered') AND active.expires_at>now())`, realm, id)
	return err
}

func (s *Store) QueueDeviceCommand(ctx context.Context, realm, id, actor, action string, revision int64, body json.RawMessage) (DeviceCommand, error) {
	var cmd DeviceCommand
	if action != "reconcile" && action != "start" && action != "stop" {
		return cmd, ErrBadRequest
	}
	if len(body) > 1<<20 {
		return cmd, ErrBadRequest
	}
	tx, d, err := s.deviceLock(ctx, realm, id)
	if err != nil {
		return cmd, err
	}
	defer tx.Rollback(ctx)
	if revision != d.Revision {
		return cmd, ErrConflict
	}
	if d.Status == "REVOKED" || d.ConnectionID == "" || d.ConnectionExpires == nil || !d.ConnectionExpires.After(time.Now()) {
		return cmd, ErrForbidden
	}
	if action == "start" && (d.Status != "ONLINE" || d.AppliedRevision != d.Revision || actor != d.Owner) {
		return cmd, ErrForbidden
	}
	if action != "reconcile" {
		var selected struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		}
		if json.Unmarshal(body, &selected) != nil {
			return cmd, ErrBadRequest
		}
		found := false
		for _, item := range d.Policy.Artifacts {
			if item.Name == selected.Name && item.Version == selected.Version {
				found = true
			}
		}
		if !found {
			return cmd, ErrBadRequest
		}
	}
	commandID, err := deviceRandom()
	if err != nil {
		return cmd, err
	}
	var active int
	err = tx.QueryRow(ctx, `SELECT count(*) FROM governance_device_commands WHERE realm=$1 AND node_id=$2 AND state IN ('queued','delivered') AND expires_at>now()`, realm, id).Scan(&active)
	if err != nil {
		return cmd, err
	}
	if active >= 16 {
		return cmd, ErrConflict
	}
	if len(body) == 0 {
		body = json.RawMessage(`{}`)
	}
	cmd = DeviceCommand{ID: commandID, Action: action, State: "queued", Revision: d.Revision, Body: body}
	err = tx.QueryRow(ctx, `INSERT INTO governance_device_commands(id,realm,node_id,actor_id,revision,connection_id,action,body,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '5 minutes') RETURNING created_at,expires_at`, cmd.ID, realm, id, actor, d.Revision, d.ConnectionID, action, body).Scan(&cmd.CreatedAt, &cmd.ExpiresAt)
	if err != nil {
		return cmd, err
	}
	if err = recordUserAdminEvent(ctx, tx, realm, d.Owner, "node_updated", actor, map[string]any{"node_id": id, "action": "command_queued", "command": action, "command_id": cmd.ID}); err != nil {
		return cmd, err
	}
	return cmd, tx.Commit(ctx)
}

func (s *Store) DeviceCommands(ctx context.Context, realm, id string) ([]DeviceCommand, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,action,CASE WHEN expires_at<now() AND state IN ('queued','delivered') THEN 'interrupted' ELSE state END,revision,body,result,expires_at,created_at
 FROM governance_device_commands WHERE realm=$1 AND node_id=$2 ORDER BY created_at DESC LIMIT 50`, realm, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeviceCommand{}
	for rows.Next() {
		var cmd DeviceCommand
		if err = rows.Scan(&cmd.ID, &cmd.Action, &cmd.State, &cmd.Revision, &cmd.Body, &cmd.Result, &cmd.ExpiresAt, &cmd.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, cmd)
	}
	return out, rows.Err()
}

// DispatchDeviceTasks bridges Scheduler's durable outbox to the current mTLS
// device lease. The outbox is considered delivered only after an immutable
// device command exists; Scheduler remains PLACED until the desktop confirms
// that the assignment was persisted in its local task inbox.
func (s *Store) DispatchDeviceTasks(ctx context.Context, limit int) (int, error) {
	if limit < 1 {
		return 0, nil
	}
	if limit > 64 {
		limit = 64
	}
	dispatched := 0
	for dispatched < limit {
		ok, err := s.dispatchDeviceTask(ctx)
		if err != nil || !ok {
			return dispatched, err
		}
		dispatched++
	}
	return dispatched, nil
}

func (s *Store) dispatchDeviceTask(ctx context.Context) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Expiry or a reconnect never loses an accepted Scheduler placement. Once
	// no live command remains, reopen its original outbox row for a new lease.
	if _, err = tx.Exec(ctx, `UPDATE governance_device_commands SET state='interrupted',updated_at=now()
	  WHERE action='execute_task' AND state IN ('queued','delivered') AND expires_at<=now()`); err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE scheduler_dispatch_outbox o
	  SET delivered_at=NULL,claimed_by=NULL,claimed_at=NULL
	  FROM governance_device_commands q,scheduler_tasks s
	  WHERE q.action='execute_task' AND q.state='interrupted'
	    AND o.task_id=q.run_id AND o.attempt=q.attempt AND o.node_id=q.node_id
	    AND s.task_id=o.task_id AND s.attempt=o.attempt AND s.node_id=o.node_id AND s.state='PLACED'
	    AND NOT EXISTS (SELECT 1 FROM governance_device_commands active
	      WHERE active.realm=q.realm AND active.run_id=q.run_id AND active.action='execute_task'
	        AND active.state IN ('queued','delivered') AND active.expires_at>now())`); err != nil {
		return false, err
	}

	var realm, runID, taskID, nodeID, owner string
	var attempt int
	var revision, deadlineMS int64
	var connectionID string
	var body json.RawMessage
	err = tx.QueryRow(ctx, `SELECT r.realm,r.id,r.task_id,s.attempt,s.deadline_ms,n.id,n.owner_user_id,d.revision,d.connection_id,
	  jsonb_build_object(
	    'task_id',t.id,'run_id',r.id,'attempt',s.attempt,'worker_id',s.worker_id,
	    'project_id',t.project_id,'title',t.title,'intent',t.intent,
	    'intent_contract',t.intent_contract,'deadline_ms',s.deadline_ms)
	  FROM scheduler_dispatch_outbox o
	  JOIN scheduler_tasks s ON s.task_id=o.task_id AND s.attempt=o.attempt AND s.node_id=o.node_id
	  JOIN governance_task_runs r ON r.realm=s.realm AND r.id=s.task_id AND r.attempt=s.attempt
	  JOIN governance_delegation_tasks t ON t.realm=r.realm AND t.id=r.task_id AND t.scheduler_task_id=r.id
	  JOIN governance_desktop_nodes n ON n.realm=s.realm AND n.id=s.node_id AND s.worker_id='user:'||n.owner_user_id
	  JOIN governance_users u ON u.realm=n.realm AND u.id=n.owner_user_id
	  JOIN governance_device_connections d ON d.realm=n.realm AND d.node_id=n.id
	  WHERE o.delivered_at IS NULL AND o.claimed_by IS NULL AND s.state='PLACED'
	    AND t.state IN ('QUEUED','ASSIGNED') AND t.business_state='ASSIGNED'
	    AND r.state IN ('QUEUED','ASSIGNED') AND r.scheduler_task_id=r.id
	    AND r.attempt=(SELECT max(latest.attempt) FROM governance_task_runs latest WHERE latest.realm=r.realm AND latest.task_id=r.task_id)
	    AND (r.assigned_node_id='' OR r.assigned_node_id=n.id) AND r.session_ref=''
	    AND u.status='active' AND n.status='ONLINE' AND n.scheduling_eligible
	    AND n.last_seen_at>=now()-interval '30 seconds'
	    AND d.revision>0 AND d.applied_revision=d.revision AND d.report_error=''
	    AND d.connection_id<>'' AND d.connection_expires>now() AND d.certificate_expires>now()
	    AND (s.deadline_ms=0 OR s.deadline_ms>(EXTRACT(EPOCH FROM now())*1000)::bigint)
	    AND NOT EXISTS (SELECT 1 FROM governance_device_commands active
	      WHERE active.realm=r.realm AND active.run_id=r.id AND active.action='execute_task'
	        AND active.state IN ('queued','delivered') AND active.expires_at>now())
	    AND (SELECT count(*) FROM governance_device_commands active
	      WHERE active.realm=r.realm AND active.node_id=n.id AND active.state IN ('queued','delivered') AND active.expires_at>now())<16
	  ORDER BY o.id LIMIT 1 FOR UPDATE OF o,s,r,t,n,d SKIP LOCKED FOR SHARE OF u`).
		Scan(&realm, &runID, &taskID, &attempt, &deadlineMS, &nodeID, &owner, &revision, &connectionID, &body)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	sessionRef := "device-" + deviceHash(realm+"\x00"+runID)
	var envelope map[string]any
	if json.Unmarshal(body, &envelope) != nil {
		return false, ErrBadRequest
	}
	envelope["session_ref"] = sessionRef
	body, err = json.Marshal(envelope)
	if err != nil {
		return false, err
	}
	expiresAt := time.Now().Add(5 * time.Minute)
	if deadlineMS > 0 {
		deadline := time.UnixMilli(deadlineMS)
		if deadline.Before(expiresAt) {
			expiresAt = deadline
		}
	}
	commandID, err := deviceRandom()
	if err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO governance_device_commands
	  (id,realm,node_id,actor_id,revision,connection_id,action,body,expires_at,run_id,attempt,session_ref)
	  VALUES($1,$2,$3,'device-gateway',$4,$5,'execute_task',$6,$7,$8,$9,$10)`,
		commandID, realm, nodeID, revision, connectionID, body, expiresAt, runID, attempt, sessionRef); err != nil {
		return false, err
	}
	if tag, updateErr := tx.Exec(ctx, `UPDATE scheduler_dispatch_outbox SET delivered_at=(EXTRACT(EPOCH FROM now())*1000)::bigint,
	  claimed_by=NULL,claimed_at=NULL WHERE task_id=$1 AND attempt=$2 AND node_id=$3 AND delivered_at IS NULL`, runID, attempt, nodeID); updateErr != nil {
		return false, updateErr
	} else if tag.RowsAffected() != 1 {
		return false, fmt.Errorf("%w: scheduler dispatch changed", ErrConflict)
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_task_runs SET assigned_node_id=$3,session_ref=$4
	  WHERE realm=$1 AND id=$2 AND state IN ('QUEUED','ASSIGNED')`, realm, runID, nodeID, sessionRef); err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_delegation_tasks SET assigned_node_id=$3,updated_at=now()
	  WHERE realm=$1 AND id=$2`, realm, taskID, nodeID); err != nil {
		return false, err
	}
	detail, _ := json.Marshal(map[string]any{"run_id": runID, "attempt": attempt, "node_id": nodeID, "command_id": commandID, "owner_user_id": owner})
	if err = insertTaskAudit(ctx, tx, taskID, "device_execution_dispatched", "device-gateway", detail); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// DispatchDeviceCancellations carries a scheduler cancellation to the device that
// is running the task.
//
// Until this existed the two halves were simply not connected: the scheduler sets
// CANCELLING, and the device knows how to stop a run, but nothing carried one to
// the other. A cancelled task therefore kept running on the machine, and -- because
// the device has exactly one execution slot -- kept the slot occupied as well.
//
// Deliberately not folded into dispatchDeviceTask, for one reason: a cancel must
// not be subject to the per-device in-flight cap. A device holding sixteen commands
// is precisely the device that cannot be cancelled, and the cap is a delivery
// budget; being unable to stop work is not a budget question.
func (s *Store) DispatchDeviceCancellations(ctx context.Context, limit int) (int, error) {
	if limit < 1 {
		return 0, nil
	}
	if limit > 64 {
		limit = 64
	}
	dispatched := 0
	for dispatched < limit {
		ok, err := s.dispatchDeviceCancellation(ctx)
		if err != nil || !ok {
			return dispatched, err
		}
		dispatched++
	}
	return dispatched, nil
}

func (s *Store) dispatchDeviceCancellation(ctx context.Context) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The join key is c.run_id = scheduler_tasks.task_id: that is what the run id
	// on a device command has always meant (dispatchDeviceTask takes it from the
	// outbox row's task_id), so no new column is needed to find the task a device
	// is running.
	//
	// Only commands that are still live are cancelled. A queued execute_task that
	// never reached the device has nothing to stop -- interrupting it is the
	// existing expiry path's job, and sending a cancel for it would only teach the
	// device to answer "not in flight".
	var realm, runID, nodeID, taskID, sessionRef, connectionID string
	var attempt int
	var revision int64
	var body json.RawMessage
	err = tx.QueryRow(ctx, `SELECT c.realm,c.run_id,c.node_id,c.attempt,c.session_ref,c.revision,c.connection_id,c.body,r.task_id
	  FROM governance_device_commands c
	  JOIN scheduler_tasks s ON s.task_id=c.run_id
	  JOIN governance_task_runs r ON r.realm=c.realm AND r.id=c.run_id
	  WHERE c.action='execute_task' AND c.state IN ('queued','delivered') AND c.expires_at>now()
	    AND s.state='CANCELLING'
	    AND NOT EXISTS (SELECT 1 FROM governance_device_commands cancel
	      WHERE cancel.realm=c.realm AND cancel.run_id=c.run_id AND cancel.action='cancel_task'
	        AND cancel.state IN ('queued','delivered') AND cancel.expires_at>now())
	  ORDER BY c.created_at LIMIT 1 FOR UPDATE OF c SKIP LOCKED`).
		Scan(&realm, &runID, &nodeID, &attempt, &sessionRef, &revision, &connectionID, &body, &taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}

	commandID, err := deviceRandom()
	if err != nil {
		return false, err
	}
	// The body is carried over verbatim rather than rebuilt. It already holds the
	// envelope the device matched the run on -- including the session_ref that was
	// derived at dispatch time -- and rebuilding it here would be a second place
	// that has to agree about how a device task is described.
	//
	// Two guards, for two different writers, and they are not redundant:
	//
	//   * the NOT EXISTS in the SELECT above is what a single sequential caller
	//     relies on -- it keeps the loop from even attempting a second insert;
	//   * ON CONFLICT DO NOTHING + the partial unique index is what protects
	//     against a *concurrent* caller, which no test here exercises: the
	//     integration tests drive one dispatcher at a time, so removing the index
	//     leaves them green (verified by mutation). It is kept because the
	//     invariant should not depend on there only ever being one process.
	//
	// Stated plainly because the alternative is worse: a comment claiming a
	// guarantee is tested when it is not is how the next person deletes it.
	tag, err := tx.Exec(ctx, `INSERT INTO governance_device_commands
	  (id,realm,node_id,actor_id,revision,connection_id,action,body,expires_at,run_id,attempt,session_ref)
	  VALUES($1,$2,$3,'device-gateway',$4,$5,'cancel_task',$6,now()+interval '5 minutes',$7,$8,$9)
	  ON CONFLICT DO NOTHING`,
		commandID, realm, nodeID, revision, connectionID, body, runID, attempt, sessionRef)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		// Another writer got there first. Not an error, and not progress either --
		// returning true would spin the caller's loop on the same row.
		return false, tx.Commit(ctx)
	}
	detail, _ := json.Marshal(map[string]any{"run_id": runID, "attempt": attempt, "node_id": nodeID, "command_id": commandID, "reason": "scheduler task cancelled"})
	if err = insertTaskAudit(ctx, tx, taskID, "device_execution_cancel_requested", "device-gateway", detail); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func (s *Store) ClaimDeviceCommands(ctx context.Context, realm, id, connection string) ([]DeviceCommand, error) {
	rows, err := s.pool.Query(ctx, `UPDATE governance_device_commands SET state='delivered',updated_at=now() WHERE id IN (
 SELECT q.id FROM governance_device_commands q JOIN governance_device_connections d ON d.realm=q.realm AND d.node_id=q.node_id
 JOIN governance_desktop_nodes n ON n.realm=q.realm AND n.id=q.node_id JOIN governance_users u ON u.realm=n.realm AND u.id=n.owner_user_id
 WHERE q.realm=$1 AND q.node_id=$2 AND q.connection_id=$3 AND d.connection_id=$3 AND d.connection_expires>now() AND d.certificate_expires>now()
 AND u.status='active' AND n.status<>'REVOKED' AND q.state='queued' AND q.expires_at>now() AND q.revision=d.revision
	AND (q.action<>'start' OR (n.status='ONLINE' AND d.applied_revision=d.revision)) ORDER BY q.created_at,q.id LIMIT 4 FOR UPDATE OF q SKIP LOCKED)
 RETURNING id,action,state,revision,body,result,expires_at,created_at`, realm, id, connection)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeviceCommand{}
	for rows.Next() {
		var cmd DeviceCommand
		if err = rows.Scan(&cmd.ID, &cmd.Action, &cmd.State, &cmd.Revision, &cmd.Body, &cmd.Result, &cmd.ExpiresAt, &cmd.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, cmd)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID < out[j].ID
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out, rows.Err()
}

func (s *Store) CompleteDeviceCommand(ctx context.Context, realm, id, connection, commandID, state string, result json.RawMessage) error {
	if (state != "completed" && state != "failed") || len(result) > 1<<20 {
		return ErrBadRequest
	}
	if len(result) == 0 {
		result = json.RawMessage(`{}`)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var action, currentState, runID, sessionRef, owner string
	var attempt int
	var revision int64
	var previous json.RawMessage
	err = tx.QueryRow(ctx, `SELECT q.action,q.state,q.result,q.run_id,q.attempt,q.session_ref,q.revision,n.owner_user_id
	  FROM governance_device_commands q
	  JOIN governance_device_connections d ON d.realm=q.realm AND d.node_id=q.node_id
	  JOIN governance_desktop_nodes n ON n.realm=q.realm AND n.id=q.node_id
	  JOIN governance_users u ON u.realm=n.realm AND u.id=n.owner_user_id
	  WHERE q.realm=$1 AND q.node_id=$2 AND q.connection_id=$3 AND q.id=$4
	    AND d.connection_id=$3 AND d.connection_expires>now() AND d.certificate_expires>now()
	    AND q.revision=d.revision AND n.status<>'REVOKED' AND u.status='active'
	  FOR UPDATE OF q,d,n`, realm, id, connection, commandID).
		Scan(&action, &currentState, &previous, &runID, &attempt, &sessionRef, &revision, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: command lease changed", ErrConflict)
	}
	if err != nil {
		return err
	}
	if currentState == "completed" || currentState == "failed" {
		var same bool
		if err = tx.QueryRow(ctx, `SELECT $1::text=$2 AND $3::jsonb=$4::jsonb`, currentState, state, previous, result).Scan(&same); err != nil {
			return err
		}
		if !same {
			return fmt.Errorf("%w: command result is immutable", ErrConflict)
		}
		return tx.Commit(ctx)
	}
	var live bool
	if err = tx.QueryRow(ctx, `SELECT state='delivered' AND expires_at>now() FROM governance_device_commands WHERE id=$1`, commandID).Scan(&live); err != nil || !live {
		return fmt.Errorf("%w: command lease changed", ErrConflict)
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_device_commands SET state=$2,result=$3,updated_at=now() WHERE id=$1`, commandID, state, result); err != nil {
		return err
	}
	if action != "execute_task" {
		return tx.Commit(ctx)
	}
	if runID == "" || attempt < 1 || sessionRef == "" || revision < 1 {
		return fmt.Errorf("%w: invalid task command identity", ErrConflict)
	}
	var taskID string
	if state == "completed" {
		tag, updateErr := tx.Exec(ctx, `UPDATE governance_task_runs SET state='RUNNING',assigned_node_id=$3,session_ref=$4,
		  started_at=COALESCE(started_at,now()) WHERE realm=$1 AND id=$2 AND attempt=$5 AND worker_id=$6
		  AND state IN ('QUEUED','ASSIGNED') AND assigned_node_id=$3 AND session_ref=$4`,
			realm, runID, id, sessionRef, attempt, "user:"+owner)
		if updateErr != nil {
			return updateErr
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("%w: task run changed before device acceptance", ErrConflict)
		}
		if err = tx.QueryRow(ctx, `UPDATE governance_delegation_tasks t SET state='RUNNING',business_state='EXECUTING',
		  assigned_node_id=$3,updated_at=now() FROM governance_task_runs r
		  WHERE r.realm=$1 AND r.id=$2 AND t.realm=r.realm AND t.id=r.task_id
		    AND t.state IN ('QUEUED','ASSIGNED') AND t.business_state='ASSIGNED' RETURNING t.id`, realm, runID, id).Scan(&taskID); err != nil {
			return fmt.Errorf("%w: task changed before device acceptance", ErrConflict)
		}
		if tag, updateErr = tx.Exec(ctx, `UPDATE scheduler_tasks SET state='RUNNING',updated_at=(EXTRACT(EPOCH FROM now())*1000)::bigint
		  WHERE task_id=$1 AND realm=$2 AND node_id=$3 AND attempt=$4 AND worker_id=$5 AND state='PLACED'`,
			runID, realm, id, attempt, "user:"+owner); updateErr != nil {
			return updateErr
		} else if tag.RowsAffected() != 1 {
			return fmt.Errorf("%w: scheduler task changed before device acceptance", ErrConflict)
		}
		if tag, updateErr = tx.Exec(ctx, `UPDATE scheduler_task_attempts SET state='RUNNING',updated_at=(EXTRACT(EPOCH FROM now())*1000)::bigint
		  WHERE task_id=$1 AND attempt=$2 AND node_id=$3 AND state='PLACED'`, runID, attempt, id); updateErr != nil {
			return updateErr
		} else if tag.RowsAffected() != 1 {
			return fmt.Errorf("%w: scheduler attempt changed before device acceptance", ErrConflict)
		}
		detail, _ := json.Marshal(map[string]any{"run_id": runID, "attempt": attempt, "node_id": id, "command_id": commandID, "session_ref": sessionRef})
		if err = insertTaskAudit(ctx, tx, taskID, "device_execution_accepted", owner, detail); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}

	// A local rejection is a terminal receipt for this immutable attempt. It
	// remains visible to the requester and can be retried through the ordinary
	// Task retry path without pretending that execution ever started.
	summary := "Device did not accept the task assignment"
	payload, _ := json.Marshal(map[string]any{"task_id": "", "run_id": runID, "state": "FAILED", "session_ref": sessionRef, "node_id": id, "summary": summary})
	if err = tx.QueryRow(ctx, `SELECT task_id FROM governance_task_runs WHERE realm=$1 AND id=$2 AND attempt=$3
	  AND worker_id=$4 AND state IN ('QUEUED','ASSIGNED') FOR UPDATE`, realm, runID, attempt, "user:"+owner).Scan(&taskID); err != nil {
		return fmt.Errorf("%w: task run changed before device rejection", ErrConflict)
	}
	var receipt map[string]any
	_ = json.Unmarshal(payload, &receipt)
	receipt["task_id"] = taskID
	payload, _ = json.Marshal(receipt)
	if _, err = tx.Exec(ctx, `INSERT INTO governance_task_results(run_id,realm,task_id,payload) VALUES($1,$2,$3,$4)`, runID, realm, taskID, payload); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_task_runs SET state='FAILED',session_ref=$3,ended_at=COALESCE(ended_at,now()),last_error=$4
	  WHERE realm=$1 AND id=$2`, realm, runID, sessionRef, summary); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_delegation_tasks SET state='FAILED',last_error=$3,updated_at=now()
	  WHERE realm=$1 AND id=$2`, realm, taskID, summary); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE scheduler_tasks SET state='FAILED',updated_at=(EXTRACT(EPOCH FROM now())*1000)::bigint
	  WHERE task_id=$1 AND realm=$2 AND node_id=$3 AND attempt=$4 AND state='PLACED'`, runID, realm, id, attempt); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE scheduler_task_attempts SET state='FAILED',updated_at=(EXTRACT(EPOCH FROM now())*1000)::bigint
	  WHERE task_id=$1 AND attempt=$2 AND node_id=$3 AND state='PLACED'`, runID, attempt, id); err != nil {
		return err
	}
	detail, _ := json.Marshal(map[string]any{"run_id": runID, "attempt": attempt, "node_id": id, "command_id": commandID, "session_ref": sessionRef, "state": "FAILED"})
	if err = insertTaskAudit(ctx, tx, taskID, "device_execution_rejected", owner, detail); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO governance_task_audit(id,realm,task_id,event,actor,detail)
	  SELECT gen_random_uuid()::text,t.realm,t.intent_contract->>'parent_task_id','child_result',$3,
	    $4::jsonb || jsonb_build_object('child_task_id',t.id)
	  FROM governance_delegation_tasks t
	  WHERE t.realm=$1 AND t.id=$2 AND COALESCE(t.intent_contract->>'parent_task_id','')<>''`, realm, taskID, owner, detail); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
