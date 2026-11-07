package breakglass

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
)

const ProtocolVersion = "lumo.recovery.v1"

var ErrInvalidRequest = errors.New("invalid recovery request")
var opaqueID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`)
var namespaceID = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

type Operation string

const (
	Restore    Operation = "restore"
	DestroyKey Operation = "key_destroy"
)

type WorkflowStatus string

const (
	Awaiting        WorkflowStatus = "pending"
	Approved        WorkflowStatus = "approved"
	Executing       WorkflowStatus = "executing"
	Succeeded       WorkflowStatus = "succeeded"
	Failed          WorkflowStatus = "failed"
	Uncertain       WorkflowStatus = "uncertain"
	WorkflowExpired WorkflowStatus = "expired"
	WorkflowRevoked WorkflowStatus = "revoked"
)

type Target struct {
	Operation     Operation `json:"operation"`
	Namespace     string    `json:"namespace"`
	TargetID      string    `json:"target_id"`
	RecoveryPoint string    `json:"recovery_point,omitempty"`
}

func (t Target) Validate() error {
	if (t.Operation != Restore && t.Operation != DestroyKey) || !namespaceID.MatchString(t.Namespace) || !opaqueID.MatchString(t.TargetID) || strings.Contains(t.TargetID, "..") {
		return ErrInvalidRequest
	}
	if (t.Operation == Restore && (!opaqueID.MatchString(t.RecoveryPoint) || strings.Contains(t.RecoveryPoint, ".."))) || (t.Operation == DestroyKey && t.RecoveryPoint != "") {
		return ErrInvalidRequest
	}
	return nil
}

type DurableRequest struct {
	ID    string `json:"id"`
	Realm string `json:"realm"`
	Target
	Reason        string         `json:"reason"`
	RequestedBy   string         `json:"requested_by"`
	ApprovedBy    string         `json:"approved_by,omitempty"`
	ApprovedAt    *time.Time     `json:"approved_at,omitempty"`
	ExpiresAt     time.Time      `json:"expires_at"`
	CreatedAt     time.Time      `json:"created_at"`
	UpdatedAt     time.Time      `json:"updated_at"`
	Status        WorkflowStatus `json:"status"`
	Revision      int64          `json:"revision"`
	ProviderID    string         `json:"provider_id"`
	PolicyDigest  string         `json:"policy_digest"`
	RequestDigest string         `json:"request_digest"`
	ExecutionID   string         `json:"execution_id"`
	FencingToken  int64          `json:"fencing_token"`
	ExecutedBy    string         `json:"executed_by,omitempty"`
	LeaseUntil    *time.Time     `json:"lease_until,omitempty"`
	LastError     string         `json:"last_error,omitempty"`
	Receipt       *Receipt       `json:"receipt,omitempty"`
}

func (r DurableRequest) Digest() string {
	raw, _ := json.Marshal(struct {
		ID           string    `json:"id"`
		Realm        string    `json:"realm"`
		Target       Target    `json:"target"`
		Reason       string    `json:"reason"`
		RequestedBy  string    `json:"requested_by"`
		ExpiresAt    time.Time `json:"expires_at"`
		ProviderID   string    `json:"provider_id"`
		PolicyDigest string    `json:"policy_digest"`
		ExecutionID  string    `json:"execution_id"`
	}{r.ID, r.Realm, r.Target, r.Reason, r.RequestedBy, r.ExpiresAt.UTC(), r.ProviderID, r.PolicyDigest, r.ExecutionID})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

type Execution struct {
	Version    string `json:"version"`
	ProviderID string `json:"provider_id"`
	RequestID  string `json:"request_id"`
	Realm      string `json:"realm"`
	Target
	RequestDigest  string `json:"request_digest"`
	ExecutionID    string `json:"execution_id"`
	IdempotencyKey string `json:"idempotency_key"`
	FencingToken   int64  `json:"fencing_token"`
	Mode           string `json:"mode"`
}

func (r DurableRequest) Execution(mode string) Execution {
	return Execution{ProtocolVersion, r.ProviderID, r.ID, r.Realm, r.Target, r.RequestDigest, r.ExecutionID, "lumo-recovery:" + r.ExecutionID, r.FencingToken, mode}
}

type Receipt struct {
	Execution
	Outcome     string    `json:"outcome"`
	ReceiptID   string    `json:"receipt_id"`
	CompletedAt time.Time `json:"completed_at"`
	Signature   string    `json:"signature"`
}
type WorkflowAudit struct {
	ID           int64           `json:"id"`
	RequestID    string          `json:"request_id"`
	Event        string          `json:"event"`
	Actor        string          `json:"actor"`
	Revision     int64           `json:"revision"`
	FencingToken int64           `json:"fencing_token"`
	Detail       json.RawMessage `json:"detail"`
	CreatedAt    time.Time       `json:"created_at"`
}
