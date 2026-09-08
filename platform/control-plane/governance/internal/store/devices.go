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
	Realm              string           `json:"realm"`
	NodeID             string           `json:"node_id"`
	Owner              string           `json:"owner_user_id"`
	OS                 string           `json:"os"`
	Arch               string           `json:"arch"`
	Status             string           `json:"status"`
	Revision           int64            `json:"revision"`
	Policy             DevicePolicy     `json:"policy"`
	PublicKeyHash      string           `json:"public_key_hash,omitempty"`
	CertificateSerial  string           `json:"certificate_serial,omitempty"`
	CertificateExpires *time.Time       `json:"certificate_expires,omitempty"`
	CertificatePEM     string           `json:"-"`
	PreviousSerial     string           `json:"-"`
	RenewalReplayExpires *time.Time      `json:"-"`
	ConnectionID       string           `json:"-"`
	ConnectionExpires  *time.Time       `json:"connection_expires,omitempty"`
	AppliedRevision    int64            `json:"applied_revision"`
	Installed          []DeviceArtifact `json:"installed"`
	ReportError        string           `json:"report_error,omitempty"`
	LastReportAt       *time.Time       `json:"last_report_at,omitempty"`
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
	if _, err = tx.Exec(ctx, `UPDATE governance_device_commands SET state='interrupted',updated_at=now() WHERE realm=$1 AND node_id=$2 AND state IN ('queued','delivered')`, realm, id); err != nil {
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
	// Delivery is at most once across reconnects. An interrupted command is not
	// a completed task and may require a separate, explicit retry by its owner.
	_, err = tx.Exec(ctx, `UPDATE governance_device_commands SET state='interrupted',updated_at=now() WHERE realm=$1 AND node_id=$2 AND state IN ('queued','delivered')`, realm, id)
	if err != nil {
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
	// A live management channel does not grant generic Agent execution. Desktop
	// execution is admitted separately by its command policy and local consent.
	_, err = tx.Exec(ctx, `UPDATE governance_desktop_nodes SET last_seen_at=now(),scheduling_eligible=false,
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
	if _, err = tx.Exec(ctx, `UPDATE governance_device_commands SET state='interrupted',updated_at=now() WHERE realm=$1 AND node_id=$2 AND connection_id=$3 AND state IN ('queued','delivered')`, realm, id, connection); err != nil {
		return err
	}
	return tx.Commit(ctx)
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
		var selected struct { Name string `json:"name"`; Version string `json:"version"` }
		if json.Unmarshal(body, &selected) != nil {
			return cmd, ErrBadRequest
		}
		found := false
		for _, item := range d.Policy.Artifacts {
			if item.Name == selected.Name && item.Version == selected.Version { found = true }
		}
		if !found { return cmd, ErrBadRequest }
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
		if out[i].CreatedAt.Equal(out[j].CreatedAt) { return out[i].ID < out[j].ID }
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
	tag, err := s.pool.Exec(ctx, `UPDATE governance_device_commands q SET state=$5,result=$6,updated_at=now() FROM governance_device_connections d
 WHERE q.realm=$1 AND q.node_id=$2 AND q.connection_id=$3 AND q.id=$4 AND q.state='delivered' AND q.expires_at>now()
 AND d.realm=q.realm AND d.node_id=q.node_id AND d.connection_id=$3 AND d.connection_expires>now() AND q.revision=d.revision
 AND d.certificate_expires>now() AND EXISTS (SELECT 1 FROM governance_desktop_nodes n JOIN governance_users u ON u.realm=n.realm AND u.id=n.owner_user_id
 WHERE n.realm=q.realm AND n.id=q.node_id AND n.status<>'REVOKED' AND u.status='active')`, realm, id, connection, commandID, state, result)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("%w: command lease changed", ErrConflict)
	}
	return nil
}
