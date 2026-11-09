package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	bg "github.com/lumo-harness/platform/governance/internal/breakglass"
)

const recoveryDDL = `
CREATE TABLE IF NOT EXISTS governance_recovery_requests (
 realm TEXT NOT NULL,id TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('restore','key_destroy')),
 namespace TEXT NOT NULL,target_id TEXT NOT NULL,recovery_point TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL,
 requested_by TEXT NOT NULL,approved_by TEXT NOT NULL DEFAULT '',approved_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','executing','succeeded','failed','uncertain','expired','revoked')),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 provider_id TEXT NOT NULL,policy_digest TEXT NOT NULL,request_digest TEXT NOT NULL,
 execution_id TEXT NOT NULL UNIQUE,fencing_token BIGINT NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
 executed_by TEXT NOT NULL DEFAULT '',claim_hash TEXT NOT NULL DEFAULT '',lease_until TIMESTAMPTZ,last_error TEXT NOT NULL DEFAULT '',receipt JSONB,
 PRIMARY KEY(realm,id),
 CHECK(approved_by='' OR approved_by<>requested_by),
 CHECK(executed_by='' OR executed_by<>approved_by),
 CHECK((operation='restore' AND recovery_point<>'') OR (operation='key_destroy' AND recovery_point=''))
);
ALTER TABLE governance_recovery_requests ADD COLUMN IF NOT EXISTS provider_protocol TEXT NOT NULL DEFAULT 'lumo.recovery.v1' CHECK(provider_protocol IN ('lumo.recovery.v1','lumo.recovery.v2'));
CREATE INDEX IF NOT EXISTS governance_recovery_requests_list ON governance_recovery_requests(realm,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS governance_recovery_audit (
 id BIGSERIAL PRIMARY KEY,realm TEXT NOT NULL,request_id TEXT NOT NULL,event TEXT NOT NULL CHECK(event IN ('requested','approved','claimed','succeeded','failed','uncertain','expired','revoked')),
 actor TEXT NOT NULL,revision BIGINT NOT NULL,fencing_token BIGINT NOT NULL,detail JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(realm,request_id) REFERENCES governance_recovery_requests(realm,id)
);
CREATE INDEX IF NOT EXISTS governance_recovery_audit_request ON governance_recovery_audit(realm,request_id,id);
`

var ErrRecoveryChanged = errors.New("recovery request changed")
var ErrRecoveryState = errors.New("recovery workflow transition not allowed")
var ErrRecoveryClaim = errors.New("recovery execution claim lost")

const recoverySelect = `SELECT realm,id,operation,namespace,target_id,recovery_point,reason,requested_by,approved_by,approved_at,expires_at,created_at,updated_at,status,revision,provider_id,policy_digest,request_digest,execution_id,fencing_token,executed_by,lease_until,last_error,receipt,provider_protocol FROM governance_recovery_requests`

func scanRecovery(row pgx.Row) (bg.DurableRequest, error) {
	var r bg.DurableRequest
	var receipt []byte
	err := row.Scan(&r.Realm, &r.ID, &r.Operation, &r.Namespace, &r.TargetID, &r.RecoveryPoint, &r.Reason, &r.RequestedBy, &r.ApprovedBy, &r.ApprovedAt, &r.ExpiresAt, &r.CreatedAt, &r.UpdatedAt, &r.Status, &r.Revision, &r.ProviderID, &r.PolicyDigest, &r.RequestDigest, &r.ExecutionID, &r.FencingToken, &r.ExecutedBy, &r.LeaseUntil, &r.LastError, &receipt, &r.ProviderProtocol)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, err
	}
	if len(receipt) > 0 && string(receipt) != "null" {
		if err = json.Unmarshal(receipt, &r.Receipt); err != nil {
			return r, err
		}
	}
	return r, nil
}
func recoveryRandom(prefix string) (string, error) {
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(raw[:]), nil
}
func recoveryAudit(ctx context.Context, tx pgx.Tx, r bg.DurableRequest, event, actor string, detail any) error {
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO governance_recovery_audit(realm,request_id,event,actor,revision,fencing_token,detail) VALUES($1,$2,$3,$4,$5,$6,$7)`, r.Realm, r.ID, event, actor, r.Revision, r.FencingToken, raw)
	return err
}
func (s *Store) CreateRecovery(ctx context.Context, r bg.DurableRequest) (bg.DurableRequest, error) {
	if r.Target.Validate() != nil || r.Realm == "" || r.RequestedBy == "" || strings.TrimSpace(r.Reason) == "" || len([]rune(r.Reason)) > 1000 || r.ProviderID == "" || len(r.PolicyDigest) != 64 {
		return r, ErrBadRequest
	}
	tx, err := s.beginOrganizationChange(ctx, r.Realm)
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx)
	if err = requireCurrentRolePolicyAdmin(ctx, tx, r.Realm, r.RequestedBy); err != nil {
		return r, err
	}
	var now time.Time
	if err = tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return r, err
	}
	r.ExpiresAt = r.ExpiresAt.UTC().Truncate(time.Millisecond)
	if !r.ExpiresAt.After(now.Add(time.Minute)) || r.ExpiresAt.After(now.Add(24*time.Hour)) {
		return r, fmt.Errorf("%w: expiry must be between one minute and 24 hours", ErrBadRequest)
	}
	r.ID, err = recoveryRandom("recovery_")
	if err != nil {
		return r, err
	}
	r.ExecutionID, err = recoveryRandom("execution_")
	if err != nil {
		return r, err
	}
	r.ProviderProtocol = bg.ProtocolVersion
	r.RequestDigest = r.Digest()
	r, err = scanRecovery(tx.QueryRow(ctx, `INSERT INTO governance_recovery_requests(realm,id,operation,namespace,target_id,recovery_point,reason,requested_by,expires_at,status,provider_id,policy_digest,request_digest,execution_id,provider_protocol)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13,$14) RETURNING `+recoveryColumns(), r.Realm, r.ID, r.Operation, r.Namespace, r.TargetID, r.RecoveryPoint, r.Reason, r.RequestedBy, r.ExpiresAt, r.ProviderID, r.PolicyDigest, r.RequestDigest, r.ExecutionID, r.ProviderProtocol))
	if err != nil {
		return r, err
	}
	if err = recoveryAudit(ctx, tx, r, "requested", r.RequestedBy, map[string]any{"request_digest": r.RequestDigest, "target": r.Target, "provider_id": r.ProviderID, "expires_at": r.ExpiresAt}); err != nil {
		return r, err
	}
	return r, tx.Commit(ctx)
}
func (s *Store) recoveryLocked(ctx context.Context, tx pgx.Tx, realm, id string, expected int64) (bg.DurableRequest, error) {
	r, err := scanRecovery(tx.QueryRow(ctx, recoverySelect+` WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, id))
	if err != nil {
		return r, err
	}
	if expected < 1 {
		return r, ErrBadRequest
	}
	if r.Revision != expected {
		return r, ErrRecoveryChanged
	}
	return r, nil
}
func expireRecovery(ctx context.Context, tx pgx.Tx, r bg.DurableRequest, actor string) (bg.DurableRequest, bool, error) {
	if r.Status != bg.Awaiting && r.Status != bg.Approved && r.Status != bg.Failed {
		return r, false, nil
	}
	var expired bool
	if err := tx.QueryRow(ctx, `SELECT expires_at<=clock_timestamp() FROM governance_recovery_requests WHERE realm=$1 AND id=$2`, r.Realm, r.ID).Scan(&expired); err != nil {
		return r, false, err
	}
	if !expired {
		return r, false, nil
	}
	r, err := scanRecovery(tx.QueryRow(ctx, `UPDATE governance_recovery_requests SET status='expired',revision=revision+1,updated_at=clock_timestamp() WHERE realm=$1 AND id=$2 RETURNING `+recoveryColumns(), r.Realm, r.ID))
	if err != nil {
		return r, false, err
	}
	return r, true, recoveryAudit(ctx, tx, r, "expired", actor, map[string]string{"reason": "approval window expired"})
}
func recoveryColumns() string {
	return strings.Split(strings.TrimPrefix(recoverySelect, "SELECT "), " FROM ")[0]
}
func (s *Store) ChangeRecovery(ctx context.Context, realm, id, actor, action string, expected int64) (bg.DurableRequest, error) {
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return bg.DurableRequest{}, err
	}
	defer tx.Rollback(ctx)
	if err = requireCurrentRolePolicyAdmin(ctx, tx, realm, actor); err != nil {
		return bg.DurableRequest{}, err
	}
	r, err := s.recoveryLocked(ctx, tx, realm, id, expected)
	if err != nil {
		return r, err
	}
	var expired bool
	r, expired, err = expireRecovery(ctx, tx, r, actor)
	if err != nil {
		return r, err
	}
	if expired {
		return r, tx.Commit(ctx)
	}
	switch action {
	case "approve":
		if r.Status != bg.Awaiting || r.RequestedBy == actor {
			return r, ErrRecoveryState
		}
		if err = requireCurrentRolePolicyAdmin(ctx, tx, realm, r.RequestedBy); err != nil {
			return r, err
		}
		r, err = scanRecovery(tx.QueryRow(ctx, `UPDATE governance_recovery_requests SET status='approved',approved_by=$3,approved_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE realm=$1 AND id=$2 RETURNING `+recoveryColumns(), realm, id, actor))
	case "revoke":
		if r.Status != bg.Awaiting && r.Status != bg.Approved && r.Status != bg.Failed {
			return r, ErrRecoveryState
		}
		r, err = scanRecovery(tx.QueryRow(ctx, `UPDATE governance_recovery_requests SET status='revoked',revision=revision+1,updated_at=clock_timestamp() WHERE realm=$1 AND id=$2 RETURNING `+recoveryColumns(), realm, id))
	default:
		return r, ErrBadRequest
	}
	if err != nil {
		return r, err
	}
	event := "approved"
	if action == "revoke" {
		event = "revoked"
	}
	if err = recoveryAudit(ctx, tx, r, event, actor, map[string]string{"request_digest": r.RequestDigest}); err != nil {
		return r, err
	}
	return r, tx.Commit(ctx)
}

type RecoveryClaim struct {
	Actor    string
	Request  bg.DurableRequest
	Token    string
	Mode     string
	Replayed bool
}

func (s *Store) ClaimRecovery(ctx context.Context, realm, id, actor string, expected int64, provider, policy, mode string) (RecoveryClaim, error) {
	var claim RecoveryClaim
	if mode != "execute" && mode != "receipt" {
		return claim, ErrBadRequest
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return claim, err
	}
	defer tx.Rollback(ctx)
	if err = requireCurrentRolePolicyAdmin(ctx, tx, realm, actor); err != nil {
		return claim, err
	}
	r, err := scanRecovery(tx.QueryRow(ctx, recoverySelect+` WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, id))
	if err != nil {
		return claim, err
	}
	if r.Status == bg.Succeeded {
		return RecoveryClaim{Request: r, Replayed: true}, tx.Commit(ctx)
	}
	if expected < 1 {
		return claim, ErrBadRequest
	}
	if expected != r.Revision {
		return claim, ErrRecoveryChanged
	}
	if r.ProviderID != provider || r.PolicyDigest != policy {
		return claim, ErrRecoveryChanged
	}
	if r.ApprovedBy == "" {
		return claim, ErrRecoveryState
	}
	if mode == "execute" {
		if r.ProviderProtocol != bg.ProtocolVersion {
			return claim, ErrRecoveryChanged
		}
		if r.ApprovedBy == actor {
			return claim, ErrRecoveryState
		}
		if err = requireCurrentRolePolicyAdmin(ctx, tx, realm, r.RequestedBy); err != nil {
			return claim, err
		}
		if err = requireCurrentRolePolicyAdmin(ctx, tx, realm, r.ApprovedBy); err != nil {
			return claim, err
		}
	}
	var now time.Time
	if err = tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return claim, err
	}
	if r.Status == bg.Executing && (r.LeaseUntil == nil || r.LeaseUntil.After(now)) {
		return claim, ErrRecoveryState
	}
	if r.Status != bg.Approved && r.Status != bg.Failed && r.Status != bg.Uncertain && r.Status != bg.Executing {
		return claim, ErrRecoveryState
	}
	if mode == "execute" && !r.ExpiresAt.After(now) {
		if r.Status == bg.Approved || r.Status == bg.Failed {
			r, _, err = expireRecovery(ctx, tx, r, actor)
			if err != nil {
				return claim, err
			}
			return RecoveryClaim{Request: r}, tx.Commit(ctx)
		}
		return claim, ErrRecoveryState
	}
	if mode == "receipt" && r.FencingToken == 0 {
		return claim, ErrRecoveryState
	}
	token, err := recoveryRandom("")
	if err != nil {
		return claim, err
	}
	hash := sha256.Sum256([]byte(token))
	r, err = scanRecovery(tx.QueryRow(ctx, `UPDATE governance_recovery_requests SET status='executing',revision=revision+1,fencing_token=fencing_token+1,executed_by=CASE WHEN $5='execute' THEN $3 ELSE executed_by END,claim_hash=$4,lease_until=clock_timestamp()+interval '45 seconds',last_error='',updated_at=clock_timestamp() WHERE realm=$1 AND id=$2 RETURNING `+recoveryColumns(), realm, id, actor, hex.EncodeToString(hash[:]), mode))
	if err != nil {
		return claim, err
	}
	if err = recoveryAudit(ctx, tx, r, "claimed", actor, map[string]string{"mode": mode, "execution_id": r.ExecutionID}); err != nil {
		return claim, err
	}
	if err = tx.Commit(ctx); err != nil {
		return claim, err
	}
	return RecoveryClaim{Actor: actor, Request: r, Token: token, Mode: mode}, nil
}
func (s *Store) FinishRecovery(ctx context.Context, claim RecoveryClaim, receipt *bg.Receipt, code string) (bg.DurableRequest, error) {
	r := claim.Request
	tx, err := s.beginOrganizationChange(ctx, r.Realm)
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx)
	current, err := scanRecovery(tx.QueryRow(ctx, recoverySelect+` WHERE realm=$1 AND id=$2 FOR UPDATE`, r.Realm, r.ID))
	if err != nil {
		return current, err
	}
	hash := sha256.Sum256([]byte(claim.Token))
	var owns bool
	if err = tx.QueryRow(ctx, `SELECT status='executing' AND fencing_token=$3 AND claim_hash=$4 AND lease_until>clock_timestamp() FROM governance_recovery_requests WHERE realm=$1 AND id=$2`, r.Realm, r.ID, r.FencingToken, hex.EncodeToString(hash[:])).Scan(&owns); err != nil {
		return current, err
	}
	if !owns {
		return current, ErrRecoveryClaim
	}
	status, event := bg.Uncertain, "uncertain"
	var raw []byte
	if receipt != nil {
		if receipt.Execution != r.Execution(claim.Mode) || (receipt.Outcome != "succeeded" && receipt.Outcome != "rejected" && receipt.Outcome != "pending" && receipt.Outcome != "not_found") {
			return current, ErrBadRequest
		}
		raw, err = json.Marshal(receipt)
		if err != nil {
			return current, err
		}
		if receipt.Outcome == "succeeded" {
			status, event = bg.Succeeded, "succeeded"
			code = ""
		} else if receipt.Outcome == "rejected" {
			status, event = bg.Failed, "failed"
			code = "provider_rejected"
		} else {
			code = "provider_pending"
		}
	}
	if code != "" && code != "provider_rejected" && code != "provider_pending" {
		code = "provider_unavailable"
	}
	current, err = scanRecovery(tx.QueryRow(ctx, `UPDATE governance_recovery_requests SET status=$3,revision=revision+1,claim_hash='',lease_until=NULL,last_error=$4,receipt=$5,updated_at=clock_timestamp() WHERE realm=$1 AND id=$2 RETURNING `+recoveryColumns(), r.Realm, r.ID, status, code, raw))
	if err != nil {
		return current, err
	}
	detail := map[string]any{"execution_id": current.ExecutionID, "request_digest": current.RequestDigest, "result": code}
	if receipt != nil {
		detail["receipt_id"] = receipt.ReceiptID
		detail["outcome"] = receipt.Outcome
	}
	if err = recoveryAudit(ctx, tx, current, event, claim.Actor, detail); err != nil {
		return current, err
	}
	return current, tx.Commit(ctx)
}
func (s *Store) GetRecovery(ctx context.Context, realm, id, actor string) (bg.DurableRequest, []bg.WorkflowAudit, error) {
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return bg.DurableRequest{}, nil, err
	}
	defer tx.Rollback(ctx)
	if err = requireCurrentRolePolicyAdmin(ctx, tx, realm, actor); err != nil {
		return bg.DurableRequest{}, nil, err
	}
	r, err := scanRecovery(tx.QueryRow(ctx, recoverySelect+` WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, id))
	if err != nil {
		return r, nil, err
	}
	r, _, err = expireRecovery(ctx, tx, r, actor)
	if err != nil {
		return r, nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id,request_id,event,actor,revision,fencing_token,detail,created_at FROM governance_recovery_audit WHERE realm=$1 AND request_id=$2 ORDER BY id DESC LIMIT 500`, realm, id)
	if err != nil {
		return r, nil, err
	}
	audit := []bg.WorkflowAudit{}
	for rows.Next() {
		var event bg.WorkflowAudit
		if err = rows.Scan(&event.ID, &event.RequestID, &event.Event, &event.Actor, &event.Revision, &event.FencingToken, &event.Detail, &event.CreatedAt); err != nil {
			rows.Close()
			return r, nil, err
		}
		audit = append(audit, event)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return r, nil, err
	}
	for i, j := 0, len(audit)-1; i < j; i, j = i+1, j-1 {
		audit[i], audit[j] = audit[j], audit[i]
	}
	return r, audit, tx.Commit(ctx)
}
func (s *Store) ListRecoveries(ctx context.Context, realm, actor string) ([]bg.DurableRequest, error) {
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = requireCurrentRolePolicyAdmin(ctx, tx, realm, actor); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, recoverySelect+` WHERE realm=$1 ORDER BY created_at DESC,id DESC LIMIT 100`, realm)
	if err != nil {
		return nil, err
	}
	result := []bg.DurableRequest{}
	for rows.Next() {
		r, e := scanRecovery(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		result = append(result, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i, r := range result {
		result[i], _, err = expireRecovery(ctx, tx, r, actor)
		if err != nil {
			return nil, err
		}
	}
	return result, tx.Commit(ctx)
}
