package store

import (
	"context"
	"encoding/json"
	"errors"
	"path"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/storageledger"
)

const sessionAttachmentDDL = `
CREATE TABLE IF NOT EXISTS session_attachment_receipts (
 realm TEXT NOT NULL,session_ref TEXT NOT NULL REFERENCES session_owners(session_ref),receipt_id TEXT NOT NULL,
 owner_user_id TEXT NOT NULL,project_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('text','image','document')),
 name TEXT NOT NULL,media_type TEXT NOT NULL,bytes BIGINT NOT NULL CHECK(bytes>0 AND bytes<=8388608),
 sha256 TEXT NOT NULL,native_ref JSONB NOT NULL,inherited_from_session TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(realm,session_ref,receipt_id)
);
ALTER TABLE session_attachment_receipts DROP CONSTRAINT IF EXISTS session_attachment_receipts_kind_check;
ALTER TABLE session_attachment_receipts ADD CONSTRAINT session_attachment_receipts_kind_check CHECK(kind IN ('text','image','document'));
ALTER TABLE session_attachment_receipts ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS session_attachment_receipts_active ON session_attachment_receipts(realm,session_ref,receipt_id) WHERE retired_at IS NULL;
`

var attachmentID = regexp.MustCompile(`^att_[a-f0-9]{48}$`)
var attachmentHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
var managedSession = regexp.MustCompile(`^session-[a-f0-9]{32}$`)
var ErrAttachmentCapacity = errors.New("active attachment capacity reached")

const ActiveAttachmentLimit = 100

type AttachmentUsage struct {
	TotalCount   int64 `json:"total_count"`
	ActiveCount  int64 `json:"active_count"`
	RetiredCount int64 `json:"retired_count"`
	TotalBytes   int64 `json:"total_bytes"`
	ActiveBytes  int64 `json:"active_bytes"`
	RetiredBytes int64 `json:"retired_bytes"`
	ActiveLimit  int   `json:"active_limit"`
	// Logical reference accounting includes retired receipts and forks. It is
	// deliberately not an estimate of deduplicated physical storage.
	Accounting              string `json:"accounting"`
	RetirementReleasesQuota bool   `json:"retirement_releases_quota"`
}
type AttachmentInventory struct {
	Receipts   []AttachmentReceipt `json:"receipts"`
	NextCursor string              `json:"next_cursor"`
	Usage      AttachmentUsage     `json:"usage"`
}

type AttachmentNativeRef struct {
	AttachmentID       string `json:"attachmentId"`
	Name               string `json:"name,omitempty"`
	Bytes              int64  `json:"bytes"`
	MediaType          string `json:"mediaType,omitempty"`
	Width              int    `json:"width,omitempty"`
	Height             int    `json:"height,omitempty"`
	OriginalDimensions *struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"originalDimensions,omitempty"`
}
type AttachmentReceipt struct {
	ReceiptID string              `json:"receipt_id"`
	Kind      string              `json:"kind"`
	Name      string              `json:"name"`
	MediaType string              `json:"media_type"`
	Bytes     int64               `json:"bytes"`
	SHA256    string              `json:"sha256"`
	NativeRef AttachmentNativeRef `json:"native_ref"`
	CreatedAt time.Time           `json:"created_at"`
	RetiredAt *time.Time          `json:"retired_at,omitempty"`
}
type AttachmentRequest struct {
	ExecutionLeaseRequest
	OwnerUserID   string             `json:"owner_user_id"`
	Operation     string             `json:"operation"`
	ReceiptID     string             `json:"receipt_id,omitempty"`
	Receipt       *AttachmentReceipt `json:"receipt,omitempty"`
	SourceSession string             `json:"source_session,omitempty"`
	ReceiptIDs    []string           `json:"receipt_ids,omitempty"`
	After         string             `json:"after,omitempty"`
	Status        string             `json:"status,omitempty"`
	Limit         int                `json:"limit,omitempty"`
	CreationToken string             `json:"creation_token,omitempty"`
	inventory     *AttachmentInventory
}

// Inventory shares the exact owner/lease authorization and transaction used by
// mutations. No caller may enumerate metadata with only a receipt ID.
func (s *Store) SessionAttachmentInventory(ctx context.Context, ref string, in AttachmentRequest) (AttachmentInventory, error) {
	page := AttachmentInventory{Receipts: []AttachmentReceipt{}}
	if in.Operation != "inventory" {
		return page, ErrOwnerInvalid
	}
	in.inventory = &page
	rows, err := s.SessionAttachments(ctx, ref, in)
	page.Receipts = rows
	return page, err
}

func validAttachmentReceipt(realm string, r AttachmentReceipt) bool {
	if r.ReceiptID != "" || r.RetiredAt != nil || !attachmentHash.MatchString(r.SHA256) || r.Bytes < 1 || r.Bytes > 8*1024*1024 || r.NativeRef.Bytes != r.Bytes || !utf8.ValidString(r.Name) || strings.TrimSpace(r.Name) == "" || len(r.Name) > 200 || strings.ContainsAny(r.Name, "/\\\x00\r\n") || strings.Contains(r.Name, "[lumo-attachment:") || r.NativeRef.Name != r.Name {
		return false
	}
	if r.Kind == "text" {
		return r.MediaType == "text/plain" && r.Bytes <= 1024*1024 && r.NativeRef.AttachmentID == realm+"/file-content/"+r.SHA256 && r.NativeRef.MediaType == "" && r.NativeRef.Width == 0 && r.NativeRef.Height == 0 && r.NativeRef.OriginalDimensions == nil
	}
	if r.Kind == "document" {
		types := map[string]string{
			".pdf":  "application/pdf",
			".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		}
		expected, ok := types[strings.ToLower(path.Ext(r.Name))]
		return ok && r.MediaType == expected && r.NativeRef.AttachmentID == realm+"/file-content/"+r.SHA256 && r.NativeRef.MediaType == "" && r.NativeRef.Width == 0 && r.NativeRef.Height == 0 && r.NativeRef.OriginalDimensions == nil
	}
	if r.Kind != "image" || r.NativeRef.AttachmentID != realm+"/content/"+r.SHA256 || r.NativeRef.MediaType != r.MediaType || r.NativeRef.Width < 1 || r.NativeRef.Height < 1 || r.NativeRef.Width > 8192 || r.NativeRef.Height > 8192 || int64(r.NativeRef.Width)*int64(r.NativeRef.Height) > 64000000 {
		return false
	}
	if d := r.NativeRef.OriginalDimensions; d != nil && (d.Width < 1 || d.Height < 1 || d.Width > 8192 || d.Height > 8192 || int64(d.Width)*int64(d.Height) > 64000000) {
		return false
	}
	return r.MediaType == "image/png" || r.MediaType == "image/jpeg" || r.MediaType == "image/webp" || r.MediaType == "image/gif"
}

const attachmentColumns = `receipt_id,kind,name,media_type,bytes,sha256,native_ref,created_at,retired_at`

func scanAttachment(row pgx.Row) (AttachmentReceipt, error) {
	var r AttachmentReceipt
	var raw []byte
	err := row.Scan(&r.ReceiptID, &r.Kind, &r.Name, &r.MediaType, &r.Bytes, &r.SHA256, &raw, &r.CreatedAt, &r.RetiredAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	if err == nil {
		err = json.Unmarshal(raw, &r.NativeRef)
	}
	return r, err
}

// Every access requires the current process secret and exact execution lease.
// The control API never trusts receipt IDs as authority on their own.
func (s *Store) SessionAttachments(ctx context.Context, ref string, in AttachmentRequest) ([]AttachmentReceipt, error) {
	if !managedSession.MatchString(ref) || !validExecutionNode(in.ExecutionNodeRequest) || in.OwnerUserID == "" || len(in.OwnerUserID) > 256 || in.WriterHolder == "" || in.FencingToken < 1 {
		return nil, ErrOwnerInvalid
	}
	if in.Operation != "inventory" && (in.After != "" || in.Status != "" || in.Limit != 0) {
		return nil, ErrOwnerInvalid
	}
	if in.Operation != "abort-inheritance" && in.CreationToken != "" {
		return nil, ErrOwnerInvalid
	}
	switch in.Operation {
	case "create":
		if in.Receipt == nil || in.ReceiptID != "" || len(in.ReceiptIDs) > 0 || in.SourceSession != "" || !validAttachmentReceipt(in.Realm, *in.Receipt) {
			return nil, ErrOwnerInvalid
		}
	case "get", "retire":
		if !attachmentID.MatchString(in.ReceiptID) || in.Receipt != nil || len(in.ReceiptIDs) > 0 || in.SourceSession != "" {
			return nil, ErrOwnerInvalid
		}
	case "list":
		if in.ReceiptID != "" || in.Receipt != nil || len(in.ReceiptIDs) > 0 || in.SourceSession != "" {
			return nil, ErrOwnerInvalid
		}
	case "inventory":
		if in.inventory == nil || in.ReceiptID != "" || in.Receipt != nil || len(in.ReceiptIDs) > 0 || in.SourceSession != "" || (in.After != "" && !attachmentID.MatchString(in.After)) || in.Limit < 0 || in.Limit > 100 || (in.Status != "" && in.Status != "active" && in.Status != "retired" && in.Status != "all") {
			return nil, ErrOwnerInvalid
		}
	case "inherit":
		if !managedSession.MatchString(in.SourceSession) || in.SourceSession == ref || len(in.ReceiptIDs) > 100 || in.Receipt != nil || in.ReceiptID != "" {
			return nil, ErrOwnerInvalid
		}
		seen := map[string]bool{}
		for _, id := range in.ReceiptIDs {
			if !attachmentID.MatchString(id) || seen[id] {
				return nil, ErrOwnerInvalid
			}
			seen[id] = true
		}
	case "abort-inheritance":
		if !attachmentHash.MatchString(in.CreationToken) || !managedSession.MatchString(in.SourceSession) || in.SourceSession == ref || len(in.ReceiptIDs) > 0 || in.Receipt != nil || in.ReceiptID != "" {
			return nil, ErrOwnerInvalid
		}
	default:
		return nil, ErrOwnerInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	n, err := scanExecutionNode(tx.QueryRow(ctx, `SELECT `+executionNodeColumns+` FROM session_execution_nodes WHERE realm=$1 AND node_id=$2 AND project_id=$3 AND process_id=$4 AND endpoint=$5 AND token_hash=$6 FOR SHARE`, in.Realm, in.NodeID, in.ProjectID, in.ProcessID, in.Endpoint, ownerTokenHash(in.Token)))
	if err != nil {
		return nil, err
	}
	l, err := scanExecutionLease(tx.QueryRow(ctx, `SELECT `+executionLeaseColumns+` FROM session_execution_leases WHERE session_ref=$1 FOR SHARE`, ref))
	if err != nil {
		return nil, err
	}
	if l.Realm != in.Realm || l.NodeID != in.NodeID || l.ProjectID != in.ProjectID || l.ProcessID != in.ProcessID || l.NodeFence != n.Fence || l.FencingToken != in.FencingToken || l.WriterHolder != in.WriterHolder {
		return nil, ErrExecutionFenced
	}
	o, err := scanOwner(tx.QueryRow(ctx, `SELECT `+ownerColumns+` FROM session_owners WHERE session_ref=$1 FOR UPDATE`, ref))
	if err != nil {
		return nil, err
	}
	if o.Realm != in.Realm || o.OwnerUserID != in.OwnerUserID || o.ProjectID != in.ProjectID || o.NodeID != in.NodeID || (o.State != "active" && !(in.Operation == "inherit" && o.State == "reserved") && !(in.Operation == "abort-inheritance" && (o.State == "reserved" || o.State == "failed"))) {
		return nil, ErrNotFound
	}
	valid := func() error {
		var ok bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_execution_nodes n JOIN session_execution_leases l ON l.realm=n.realm AND l.node_id=n.node_id WHERE n.realm=$1 AND n.node_id=$2 AND n.process_id=$3 AND n.fence=$4 AND n.expires_at>clock_timestamp() AND l.session_ref=$5 AND l.process_id=$3 AND l.node_fence=$4 AND l.fencing_token=$6 AND l.writer_holder=$7 AND l.expires_at>clock_timestamp())`, in.Realm, in.NodeID, in.ProcessID, n.Fence, ref, in.FencingToken, in.WriterHolder).Scan(&ok)
		if err != nil {
			return err
		}
		if !ok {
			return ErrExecutionFenced
		}
		return nil
	}
	if err = valid(); err != nil {
		return nil, err
	}
	out := []AttachmentReceipt{}
	switch in.Operation {
	case "abort-inheritance":
		// Only the holder of this reservation token may abandon a not-yet-active
		// child. Activation and abort serialize on the owner row; an uncertain
		// activation can therefore never release an active Session's references.
		if o.State == "active" || o.ParentSessionRef != in.SourceSession {
			return nil, ErrOwnerConflict
		}
		var matches bool
		if err = tx.QueryRow(ctx, `SELECT creation_token_hash=$2 FROM session_owners WHERE session_ref=$1`, ref, ownerTokenHash(in.CreationToken)).Scan(&matches); err != nil {
			return nil, err
		}
		if !matches {
			return nil, ErrOwnerConflict
		}
		if err = storageledger.Lock(ctx, tx, in.Realm, in.ProjectID); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `UPDATE platform_storage_charges c SET released_at=COALESCE(c.released_at,clock_timestamp()) FROM session_attachment_receipts a WHERE a.realm=$1 AND a.session_ref=$2 AND a.inherited_from_session=$3 AND c.realm=a.realm AND c.kind='session-attachment' AND c.project_id=a.project_id AND c.reference_id=a.session_ref||'/'||a.receipt_id`, in.Realm, ref, in.SourceSession); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM session_attachment_receipts WHERE realm=$1 AND session_ref=$2 AND inherited_from_session=$3`, in.Realm, ref, in.SourceSession); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `UPDATE session_owners SET state='failed' WHERE session_ref=$1 AND state IN ('reserved','failed')`, ref); err != nil {
			return nil, err
		}
	case "create":
		var count int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM session_attachment_receipts WHERE realm=$1 AND session_ref=$2 AND retired_at IS NULL`, in.Realm, ref).Scan(&count); err != nil {
			return nil, err
		}
		if count >= ActiveAttachmentLimit {
			return nil, ErrAttachmentCapacity
		}
		id, e := randomOwnerToken(24)
		if e != nil {
			return nil, e
		}
		r := *in.Receipt
		r.ReceiptID = "att_" + id
		raw, e := json.Marshal(r.NativeRef)
		if e != nil {
			return nil, e
		}
		if err = storageledger.Register(ctx, tx, storageledger.Charge{Realm: in.Realm, ProjectID: in.ProjectID, Kind: "session-attachment", ReferenceID: ref + "/" + r.ReceiptID, Bytes: r.Bytes, ObjectKey: r.NativeRef.AttachmentID}); err != nil {
			return nil, err
		}
		r, err = scanAttachment(tx.QueryRow(ctx, `INSERT INTO session_attachment_receipts(realm,session_ref,receipt_id,owner_user_id,project_id,kind,name,media_type,bytes,sha256,native_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING `+attachmentColumns, in.Realm, ref, r.ReceiptID, in.OwnerUserID, in.ProjectID, r.Kind, r.Name, r.MediaType, r.Bytes, r.SHA256, raw))
		if err == nil {
			out = append(out, r)
		}
	case "get":
		var r AttachmentReceipt
		r, err = scanAttachment(tx.QueryRow(ctx, `SELECT `+attachmentColumns+` FROM session_attachment_receipts WHERE realm=$1 AND session_ref=$2 AND receipt_id=$3 AND owner_user_id=$4 AND project_id=$5`, in.Realm, ref, in.ReceiptID, in.OwnerUserID, in.ProjectID))
		if err == nil {
			out = append(out, r)
		}
	case "retire":
		// Logical retirement only: native content is shared with append-only
		// history and legacy references. Keep both bytes and quota charged.
		var r AttachmentReceipt
		r, err = scanAttachment(tx.QueryRow(ctx, `UPDATE session_attachment_receipts SET retired_at=COALESCE(retired_at,clock_timestamp()) WHERE realm=$1 AND session_ref=$2 AND receipt_id=$3 AND owner_user_id=$4 AND project_id=$5 RETURNING `+attachmentColumns, in.Realm, ref, in.ReceiptID, in.OwnerUserID, in.ProjectID))
		if err == nil {
			out = append(out, r)
		}
	case "inventory", "list":
		limit, after, status := 100, "", "active"
		if in.Operation == "inventory" {
			limit, after, status = in.Limit, in.After, in.Status
			if limit == 0 {
				limit = 50
			}
			if status == "" {
				status = "active"
			}
			u := &in.inventory.Usage
			u.ActiveLimit, u.Accounting = ActiveAttachmentLimit, "logical-retained-reference-bytes"
			if err = tx.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE retired_at IS NULL),count(*) FILTER(WHERE retired_at IS NOT NULL),COALESCE(sum(bytes),0),COALESCE(sum(bytes) FILTER(WHERE retired_at IS NULL),0),COALESCE(sum(bytes) FILTER(WHERE retired_at IS NOT NULL),0) FROM session_attachment_receipts WHERE realm=$1 AND session_ref=$2`, in.Realm, ref).Scan(&u.TotalCount, &u.ActiveCount, &u.RetiredCount, &u.TotalBytes, &u.ActiveBytes, &u.RetiredBytes); err != nil {
				return nil, err
			}
		}
		var rows pgx.Rows
		rows, err = tx.Query(ctx, `SELECT `+attachmentColumns+` FROM session_attachment_receipts WHERE realm=$1 AND session_ref=$2 AND owner_user_id=$3 AND project_id=$4 AND receipt_id>$5 AND ($6='all' OR ($6='active' AND retired_at IS NULL) OR ($6='retired' AND retired_at IS NOT NULL)) ORDER BY receipt_id LIMIT $7`, in.Realm, ref, in.OwnerUserID, in.ProjectID, after, status, limit+1)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var r AttachmentReceipt
				r, err = scanAttachment(rows)
				if err != nil {
					break
				}
				out = append(out, r)
			}
			if err == nil {
				err = rows.Err()
			}
			rows.Close()
		}
		if in.Operation == "inventory" && len(out) > limit {
			out = out[:limit]
			in.inventory.NextCursor = out[len(out)-1].ReceiptID
		}
		if in.Operation == "list" && len(out) > limit {
			out = out[:limit]
		}
	case "inherit":
		if o.State != "reserved" || o.ParentSessionRef != in.SourceSession {
			return nil, ErrOwnerConflict
		}
		p, e := scanOwner(tx.QueryRow(ctx, `SELECT `+ownerColumns+` FROM session_owners WHERE session_ref=$1 FOR SHARE`, in.SourceSession))
		if e != nil {
			return nil, e
		}
		if p.State != "active" || p.Realm != in.Realm || p.OwnerUserID != in.OwnerUserID || p.ProjectID != in.ProjectID || p.NodeID != in.NodeID {
			return nil, ErrNotFound
		}
		for _, id := range in.ReceiptIDs {
			r, e := scanAttachment(tx.QueryRow(ctx, `SELECT `+attachmentColumns+` FROM session_attachment_receipts WHERE realm=$1 AND session_ref=$2 AND receipt_id=$3`, in.Realm, in.SourceSession, id))
			if e != nil {
				return nil, e
			}
			raw, e := json.Marshal(r.NativeRef)
			if e != nil {
				return nil, e
			}
			if err = storageledger.Register(ctx, tx, storageledger.Charge{Realm: in.Realm, ProjectID: in.ProjectID, Kind: "session-attachment", ReferenceID: ref + "/" + r.ReceiptID, Bytes: r.Bytes, ObjectKey: r.NativeRef.AttachmentID}); err != nil {
				return nil, err
			}
			_, err = tx.Exec(ctx, `INSERT INTO session_attachment_receipts(realm,session_ref,receipt_id,owner_user_id,project_id,kind,name,media_type,bytes,sha256,native_ref,inherited_from_session,retired_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(realm,session_ref,receipt_id) DO UPDATE SET retired_at=COALESCE(session_attachment_receipts.retired_at,EXCLUDED.retired_at)`, in.Realm, ref, r.ReceiptID, in.OwnerUserID, in.ProjectID, r.Kind, r.Name, r.MediaType, r.Bytes, r.SHA256, raw, in.SourceSession, r.RetiredAt)
			if err != nil {
				return nil, err
			}
			out = append(out, r)
		}
	}
	if err != nil {
		return nil, err
	}
	if err = valid(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
