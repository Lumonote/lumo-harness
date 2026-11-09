package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func attachmentFixture(t *testing.T) (*Store, SessionOwner, AttachmentRequest) {
	t.Helper()
	s := newStore(t)
	ctx := context.Background()
	node := executionRequest("attachments-process")
	if _, err := s.AcquireExecutionNode(ctx, node); err != nil {
		t.Fatal(err)
	}
	o, token, err := s.ReserveSessionOwner(ctx, ReserveSessionOwner{Realm: "r", OwnerUserID: "alice", ProjectID: "p", NodeID: "node"})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := s.SessionExecutionLease(ctx, o.SessionRef, ExecutionLeaseRequest{ExecutionNodeRequest: node, WriterHolder: "writer"}, "acquire")
	if err != nil {
		t.Fatal(err)
	}
	o, err = s.ActivateSessionOwner(ctx, "r", o.SessionRef, token)
	if err != nil {
		t.Fatal(err)
	}
	return s, o, AttachmentRequest{ExecutionLeaseRequest: ExecutionLeaseRequest{ExecutionNodeRequest: node, WriterHolder: "writer", FencingToken: lease.FencingToken}, OwnerUserID: "alice"}
}
func textAttachment() *AttachmentReceipt {
	return &AttachmentReceipt{Kind: "text", Name: "notes.txt", MediaType: "text/plain", Bytes: 5, SHA256: strings.Repeat("a", 64), NativeRef: AttachmentNativeRef{AttachmentID: "r/file-content/" + strings.Repeat("a", 64), Name: "notes.txt", Bytes: 5}}
}

func TestDocumentAttachmentReceiptValidation(t *testing.T) {
	for extension, mediaType := range map[string]string{
		".pdf":  "application/pdf",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	} {
		t.Run(extension, func(t *testing.T) {
			r := *textAttachment()
			r.Kind, r.Name, r.MediaType = "document", "report"+extension, mediaType
			r.NativeRef.Name = r.Name
			if !validAttachmentReceipt("r", r) {
				t.Fatal("valid document rejected")
			}
			bad := r
			bad.MediaType = "application/octet-stream"
			if validAttachmentReceipt("r", bad) {
				t.Fatal("unknown MIME accepted")
			}
			bad = r
			bad.Name = "report.txt"
			bad.NativeRef.Name = bad.Name
			if validAttachmentReceipt("r", bad) {
				t.Fatal("extension mismatch accepted")
			}
			bad = r
			bad.NativeRef.AttachmentID = "other/file-content/" + r.SHA256
			if validAttachmentReceipt("r", bad) {
				t.Fatal("cross realm accepted")
			}
			bad = r
			bad.NativeRef.Width = 1
			if validAttachmentReceipt("r", bad) {
				t.Fatal("image fields accepted for document")
			}
		})
	}
}

func TestDocumentAttachmentPersistsAcrossStoreRestart(t *testing.T) {
	s, owner, request := attachmentFixture(t)
	request.Operation = "create"
	request.Receipt = textAttachment()
	request.Receipt.Kind = "document"
	request.Receipt.Name = "report.PDF"
	request.Receipt.NativeRef.Name = request.Receipt.Name
	request.Receipt.MediaType = "application/pdf"
	items, err := s.SessionAttachments(context.Background(), owner.SessionRef, request)
	if err != nil || len(items) != 1 {
		t.Fatalf("create: %+v %v", items, err)
	}
	request.Operation, request.ReceiptID, request.Receipt = "get", items[0].ReceiptID, nil
	items, err = New(s.pool).SessionAttachments(context.Background(), owner.SessionRef, request)
	if err != nil || len(items) != 1 || items[0].Kind != "document" || items[0].MediaType != "application/pdf" {
		t.Fatalf("restart: %+v %v", items, err)
	}
}
func TestAttachmentReceiptsPersistAndFenceEveryAccess(t *testing.T) {
	s, o, in := attachmentFixture(t)
	ctx := context.Background()
	in.Operation = "create"
	in.Receipt = textAttachment()
	rows, err := s.SessionAttachments(ctx, o.SessionRef, in)
	if err != nil || len(rows) != 1 || !attachmentID.MatchString(rows[0].ReceiptID) {
		t.Fatalf("create %+v %v", rows, err)
	}
	id := rows[0].ReceiptID
	in.Operation = "get"
	in.Receipt = nil
	in.ReceiptID = id
	rows, err = New(s.pool).SessionAttachments(ctx, o.SessionRef, in)
	if err != nil || len(rows) != 1 || rows[0].NativeRef.AttachmentID != "r/file-content/"+strings.Repeat("a", 64) {
		t.Fatalf("restart %+v %v", rows, err)
	}
	for _, field := range []string{"owner", "realm", "project", "node", "process", "token", "writer", "fence"} {
		bad := in
		switch field {
		case "owner":
			bad.OwnerUserID = "bob"
		case "realm":
			bad.Realm = "foreign"
		case "project":
			bad.ProjectID = "foreign"
		case "node":
			bad.NodeID = "other"
		case "process":
			bad.ProcessID = "old"
		case "token":
			bad.Token = strings.Repeat("b", 64)
		case "writer":
			bad.WriterHolder = "foreign"
		case "fence":
			bad.FencingToken++
		}
		if _, err := s.SessionAttachments(ctx, o.SessionRef, bad); err == nil {
			t.Fatalf("accepted forged %s", field)
		}
		bad.Operation = "retire"
		if _, err := s.SessionAttachments(ctx, o.SessionRef, bad); err == nil {
			t.Fatalf("accepted forged retirement %s", field)
		}
	}
	if _, err = s.pool.Exec(ctx, `UPDATE session_execution_leases SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	for _, op := range []string{"get", "list", "create", "retire"} {
		bad := in
		bad.Operation = op
		if op != "get" && op != "retire" {
			bad.ReceiptID = ""
		}
		if op == "create" {
			bad.Receipt = textAttachment()
		}
		if _, err = s.SessionAttachments(ctx, o.SessionRef, bad); !errors.Is(err, ErrExecutionFenced) {
			t.Fatalf("expired %s: %v", op, err)
		}
	}
}
func TestAttachmentForkCopiesOnlyExplicitParentReceipts(t *testing.T) {
	s, o, in := attachmentFixture(t)
	ctx := context.Background()
	in.Operation = "create"
	in.Receipt = textAttachment()
	first, err := s.SessionAttachments(ctx, o.SessionRef, in)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.SessionAttachments(ctx, o.SessionRef, in)
	if err != nil {
		t.Fatal(err)
	}
	in.Operation, in.Receipt, in.ReceiptID = "retire", nil, first[0].ReceiptID
	if _, err = s.SessionAttachments(ctx, o.SessionRef, in); err != nil {
		t.Fatal(err)
	}
	child, token, err := s.ReserveSessionOwner(ctx, ReserveSessionOwner{Realm: "r", OwnerUserID: "alice", ProjectID: "p", NodeID: "node", ParentSessionRef: o.SessionRef})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := s.SessionExecutionLease(ctx, child.SessionRef, in.ExecutionLeaseRequest, "acquire")
	if err != nil {
		t.Fatal(err)
	}
	fork := in
	fork.FencingToken = lease.FencingToken
	fork.Operation = "inherit"
	fork.Receipt = nil
	fork.ReceiptID = ""
	fork.SourceSession = o.SessionRef
	fork.ReceiptIDs = []string{first[0].ReceiptID}
	if _, err = s.SessionAttachments(ctx, child.SessionRef, fork); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ActivateSessionOwner(ctx, "r", child.SessionRef, token); err != nil {
		t.Fatal(err)
	}
	fork.Operation = "get"
	fork.SourceSession = ""
	fork.ReceiptIDs = nil
	fork.ReceiptID = first[0].ReceiptID
	if inherited, e := s.SessionAttachments(ctx, child.SessionRef, fork); e != nil || len(inherited) != 1 || inherited[0].RetiredAt == nil {
		t.Fatalf("retired history lost on fork: %+v %v", inherited, e)
	}
	fork.ReceiptID = second[0].ReceiptID
	if _, err = s.SessionAttachments(ctx, child.SessionRef, fork); !errors.Is(err, ErrNotFound) {
		t.Fatalf("inherited unsent receipt: %v", err)
	}
}
func TestAttachmentScopeIsRecheckedAfterWaitingForOwnerLock(t *testing.T) {
	s, o, in := attachmentFixture(t)
	ctx := context.Background()
	in.Operation = "create"
	in.Receipt = textAttachment()
	if _, err := s.pool.Exec(ctx, `UPDATE session_execution_leases SET expires_at=clock_timestamp()+interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT 1 FROM session_owners WHERE session_ref=$1 FOR UPDATE`, o.SessionRef); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, e := s.SessionAttachments(ctx, o.SessionRef, in); done <- e }()
	waitExecutionLock(t, ctx, tx)
	if _, err = tx.Exec(ctx, `SELECT pg_sleep(1.1)`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("expired receipt write: %v", err)
	}
	var count int
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM session_attachment_receipts`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial receipt: %d %v", count, err)
	}
}
func TestAttachmentMetadataRejectsArbitraryReferences(t *testing.T) {
	for _, field := range []string{"url", "realm", "digest", "length", "path", "mime", "image", "marker"} {
		r := *textAttachment()
		switch field {
		case "url":
			r.NativeRef.AttachmentID = "https://foreign/private"
		case "realm":
			r.NativeRef.AttachmentID = "foreign/file-content/" + r.SHA256
		case "digest":
			r.SHA256 = strings.Repeat("b", 64)
		case "length":
			r.NativeRef.Bytes++
		case "path":
			r.Name = "../private"
		case "mime":
			r.MediaType = "text/html"
		case "image":
			r.NativeRef.Width = 1
		case "marker":
			r.Name = "notes[lumo-attachment:att_" + strings.Repeat("b", 48) + "].txt"
			r.NativeRef.Name = r.Name
		}
		if validAttachmentReceipt("r", r) {
			t.Fatalf("accepted %s", field)
		}
	}
}

func TestAttachmentRetirementKeepsHistoryAndQuotaAcrossRestart(t *testing.T) {
	s, owner, request := attachmentFixture(t)
	ctx := context.Background()
	request.Operation, request.Receipt = "create", textAttachment()
	created, err := s.SessionAttachments(ctx, owner.SessionRef, request)
	if err != nil {
		t.Fatal(err)
	}
	request.Operation, request.Receipt, request.ReceiptID = "retire", nil, created[0].ReceiptID
	forged := request
	forged.OwnerUserID = "bob"
	if _, err = s.SessionAttachments(ctx, owner.SessionRef, forged); err == nil {
		t.Fatal("foreign retirement accepted")
	}
	retired, err := s.SessionAttachments(ctx, owner.SessionRef, request)
	if err != nil || len(retired) != 1 || retired[0].RetiredAt == nil {
		t.Fatalf("retire: %+v %v", retired, err)
	}
	repeated, err := New(s.pool).SessionAttachments(ctx, owner.SessionRef, request)
	if err != nil || len(repeated) != 1 || !repeated[0].RetiredAt.Equal(*retired[0].RetiredAt) {
		t.Fatalf("retirement is not idempotent: %+v %v", repeated, err)
	}
	request.Operation = "get"
	history, err := s.SessionAttachments(ctx, owner.SessionRef, request)
	if err != nil || len(history) != 1 || history[0].RetiredAt == nil || history[0].NativeRef != created[0].NativeRef {
		t.Fatalf("history changed: %+v %v", history, err)
	}
	request.Operation, request.ReceiptID = "list", ""
	active, err := s.SessionAttachments(ctx, owner.SessionRef, request)
	if err != nil || len(active) != 0 {
		t.Fatalf("retired receipt is still selectable: %+v %v", active, err)
	}
	var charged int64
	if err = s.pool.QueryRow(ctx, `SELECT COALESCE(sum(bytes),0) FROM platform_storage_charges WHERE realm='r' AND kind='session-attachment' AND released_at IS NULL`).Scan(&charged); err != nil || charged != created[0].Bytes {
		t.Fatalf("retirement released retained quota: %d %v", charged, err)
	}
}

func TestAttachmentRetirementRollsBackWhenLeaseExpiresAtOwnerLock(t *testing.T) {
	s, owner, request := attachmentFixture(t)
	ctx := context.Background()
	request.Operation, request.Receipt = "create", textAttachment()
	created, err := s.SessionAttachments(ctx, owner.SessionRef, request)
	if err != nil {
		t.Fatal(err)
	}
	request.Operation, request.Receipt, request.ReceiptID = "retire", nil, created[0].ReceiptID
	if _, err = s.pool.Exec(ctx, `UPDATE session_execution_leases SET expires_at=clock_timestamp()+interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT 1 FROM session_owners WHERE session_ref=$1 FOR UPDATE`, owner.SessionRef); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, e := s.SessionAttachments(ctx, owner.SessionRef, request); done <- e }()
	waitExecutionLock(t, ctx, tx)
	if _, err = tx.Exec(ctx, `SELECT pg_sleep(1.1)`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("expired retirement: %v", err)
	}
	var retained bool
	if err = s.pool.QueryRow(ctx, `SELECT retired_at IS NULL FROM session_attachment_receipts WHERE receipt_id=$1`, request.ReceiptID).Scan(&retained); err != nil || !retained {
		t.Fatalf("partial retirement committed: %v %v", retained, err)
	}
}

func TestAttachmentActiveCapacityAndInventoryKeepRetainedHistory(t *testing.T) {
	s, owner, request := attachmentFixture(t)
	ctx := context.Background()
	// Historical capacity is independent of active admission. Seed immutable rows
	// as an old long-lived Session, then exercise all new operations through the
	// public Store boundary and its real execution lease.
	_, err := s.pool.Exec(ctx, `INSERT INTO session_attachment_receipts(realm,session_ref,receipt_id,owner_user_id,project_id,kind,name,media_type,bytes,sha256,native_ref,retired_at)
 SELECT 'r',$1,'att_'||lpad(i::text,48,'0'),'alice','p','text','notes.txt','text/plain',5,repeat('a',64),jsonb_build_object('attachmentId','r/file-content/'||repeat('a',64),'name','notes.txt','bytes',5),CASE WHEN i<=105 THEN now() ELSE NULL END FROM generate_series(1,205) i`, owner.SessionRef)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.initStorageLedger(ctx); err != nil {
		t.Fatal(err)
	}
	request.Operation, request.Receipt = "create", textAttachment()
	if _, err = s.SessionAttachments(ctx, owner.SessionRef, request); !errors.Is(err, ErrAttachmentCapacity) {
		t.Fatalf("active limit bypass: %v", err)
	}
	request.Operation, request.Receipt, request.ReceiptID = "retire", nil, "att_"+strings.Repeat("0", 45)+"205"
	if _, err = s.SessionAttachments(ctx, owner.SessionRef, request); err != nil {
		t.Fatal(err)
	}
	request.Operation, request.Receipt, request.ReceiptID = "create", textAttachment(), ""
	created, err := s.SessionAttachments(ctx, owner.SessionRef, request)
	if err != nil || len(created) != 1 {
		t.Fatalf("retirement did not reopen admission: %+v %v", created, err)
	}
	request.Operation, request.Receipt, request.Status, request.Limit = "inventory", nil, "all", 31
	seen := map[string]bool{}
	for {
		page, e := New(s.pool).SessionAttachmentInventory(ctx, owner.SessionRef, request)
		if e != nil {
			t.Fatal(e)
		}
		u := page.Usage
		if u.TotalCount != 206 || u.ActiveCount != 100 || u.RetiredCount != 106 || u.TotalBytes != 1030 || u.ActiveBytes != 500 || u.RetiredBytes != 530 || u.Accounting != "logical-retained-reference-bytes" || u.RetirementReleasesQuota {
			t.Fatalf("invalid usage: %+v", u)
		}
		if len(page.Receipts) > 31 {
			t.Fatal("unbounded page")
		}
		for _, r := range page.Receipts {
			if seen[r.ReceiptID] || r.ReceiptID <= request.After {
				t.Fatal("duplicate/backward page")
			}
			seen[r.ReceiptID] = true
		}
		if page.NextCursor == "" {
			break
		}
		request.After = page.NextCursor
	}
	if len(seen) != 206 {
		t.Fatalf("lost retained rows: %d", len(seen))
	}
	var charged int64
	if err = s.pool.QueryRow(ctx, `SELECT COALESCE(sum(bytes),0) FROM platform_storage_charges WHERE reference_id LIKE $1 AND released_at IS NULL`, owner.SessionRef+"/%").Scan(&charged); err != nil || charged != 1030 {
		t.Fatalf("logical retained charge differs: %d %v", charged, err)
	}
	request.After = ""
	request.Status = "retired"
	request.Limit = 100
	page, err := s.SessionAttachmentInventory(ctx, owner.SessionRef, request)
	if err != nil || len(page.Receipts) != 100 || page.NextCursor == "" {
		t.Fatalf("retired page %+v %v", page, err)
	}
	for _, r := range page.Receipts {
		if r.RetiredAt == nil {
			t.Fatal("active row in retired page")
		}
	}
	for _, bad := range []AttachmentRequest{
		func() AttachmentRequest { v := request; v.OwnerUserID = "bob"; return v }(),
		func() AttachmentRequest { v := request; v.After = "https://private"; return v }(),
		func() AttachmentRequest { v := request; v.Limit = 101; return v }(),
		func() AttachmentRequest { v := request; v.Status = "unknown"; return v }(),
	} {
		if _, err = s.SessionAttachmentInventory(ctx, owner.SessionRef, bad); err == nil {
			t.Fatal("forged inventory accepted")
		}
	}
}

func TestAttachmentForkBatchesAreIdempotentAndRetainEveryHistoricalReceipt(t *testing.T) {
	s, owner, request := attachmentFixture(t)
	ctx := context.Background()
	_, err := s.pool.Exec(ctx, `INSERT INTO session_attachment_receipts(realm,session_ref,receipt_id,owner_user_id,project_id,kind,name,media_type,bytes,sha256,native_ref,retired_at)
 SELECT 'r',$1,'att_'||lpad(i::text,48,'0'),'alice','p','text','notes.txt','text/plain',5,repeat('a',64),jsonb_build_object('attachmentId','r/file-content/'||repeat('a',64),'name','notes.txt','bytes',5),CASE WHEN i<=150 THEN now() ELSE NULL END FROM generate_series(1,206) i`, owner.SessionRef)
	if err != nil {
		t.Fatal(err)
	}
	child, token, err := s.ReserveSessionOwner(ctx, ReserveSessionOwner{Realm: "r", OwnerUserID: "alice", ProjectID: "p", NodeID: "node", ParentSessionRef: owner.SessionRef})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := s.SessionExecutionLease(ctx, child.SessionRef, request.ExecutionLeaseRequest, "acquire")
	if err != nil {
		t.Fatal(err)
	}
	request.FencingToken, request.Operation, request.SourceSession = lease.FencingToken, "inherit", owner.SessionRef
	for offset := 1; offset <= 205; offset += 100 {
		request.ReceiptIDs = nil
		for i := offset; i < offset+100 && i <= 205; i++ {
			request.ReceiptIDs = append(request.ReceiptIDs, fmt.Sprintf("att_%048d", i))
		}
		for repeat := 0; repeat < 2; repeat++ {
			rows, e := s.SessionAttachments(ctx, child.SessionRef, request)
			if e != nil || len(rows) != len(request.ReceiptIDs) {
				t.Fatalf("batch: %d %v", len(rows), e)
			}
		}
	}
	var count, retired int
	var charged int64
	if err = s.pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE retired_at IS NOT NULL) FROM session_attachment_receipts WHERE session_ref=$1`, child.SessionRef).Scan(&count, &retired); err != nil || count != 205 || retired != 150 {
		t.Fatalf("fork lost history: %d %d %v", count, retired, err)
	}
	if err = s.pool.QueryRow(ctx, `SELECT COALESCE(sum(bytes),0) FROM platform_storage_charges WHERE reference_id LIKE $1 AND released_at IS NULL`, child.SessionRef+"/%").Scan(&charged); err != nil || charged != 1025 {
		t.Fatalf("duplicate charges: %d %v", charged, err)
	}
	if _, err = s.ActivateSessionOwner(ctx, "r", child.SessionRef, token); err != nil {
		t.Fatal(err)
	}
	request.Operation, request.SourceSession, request.ReceiptIDs, request.ReceiptID = "get", "", nil, fmt.Sprintf("att_%048d", 206)
	if _, err = s.SessionAttachments(ctx, child.SessionRef, request); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unsent receipt inherited: %v", err)
	}
	request.Operation, request.ReceiptID, request.Status, request.Limit = "inventory", "", "all", 100
	if _, err = s.pool.Exec(ctx, `UPDATE session_execution_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE session_ref=$1`, child.SessionRef); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SessionAttachmentInventory(ctx, child.SessionRef, request); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("stale inventory: %v", err)
	}
}

func TestAttachmentHistorySurvivesExecutionMigrationWithoutListTruncation(t *testing.T) {
	s, ref, source, target, checkpoint := migrationFixture(t)
	ctx := context.Background()
	_, err := s.pool.Exec(ctx, `INSERT INTO session_attachment_receipts(realm,session_ref,receipt_id,owner_user_id,project_id,kind,name,media_type,bytes,sha256,native_ref,retired_at)
 SELECT 'r',$1,'att_'||lpad(i::text,48,'0'),'alice','p','text','notes.txt','text/plain',5,repeat('a',64),jsonb_build_object('attachmentId','r/file-content/'||repeat('a',64),'name','notes.txt','bytes',5),now() FROM generate_series(1,205) i`, ref)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CheckpointSessionMigration(ctx, ref, checkpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ActivateSessionMigration(ctx, ref, checkpoint.ID, SessionMigrationActivation{OwnerUserID: "alice", SnapshotSHA256: checkpoint.SnapshotSHA256, Execution: target}); err != nil {
		t.Fatal(err)
	}
	lease, err := s.SessionExecutionLease(ctx, ref, target, "acquire")
	if err != nil {
		t.Fatal(err)
	}
	target.FencingToken = lease.FencingToken
	request := AttachmentRequest{ExecutionLeaseRequest: target, OwnerUserID: "alice", Operation: "inventory", Status: "retired", Limit: 100}
	seen := 0
	for {
		page, e := New(s.pool).SessionAttachmentInventory(ctx, ref, request)
		if e != nil {
			t.Fatal(e)
		}
		seen += len(page.Receipts)
		if page.NextCursor == "" {
			break
		}
		request.After = page.NextCursor
	}
	if seen != 205 {
		t.Fatalf("migration lost retained history: %d", seen)
	}
	request.Operation, request.After, request.Status, request.Limit, request.ReceiptID = "get", "", "", 0, fmt.Sprintf("att_%048d", 205)
	if rows, e := s.SessionAttachments(ctx, ref, request); e != nil || len(rows) != 1 || rows[0].RetiredAt == nil {
		t.Fatalf("target read: %+v %v", rows, e)
	}
	request.ExecutionLeaseRequest = source
	if _, err = s.SessionAttachments(ctx, ref, request); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("source read after migration: %v", err)
	}
}

func TestAttachmentPartialInheritanceAbortNeverReleasesAnActiveChild(t *testing.T) {
	s, parent, request := attachmentFixture(t)
	ctx := context.Background()
	request.Operation, request.Receipt = "create", textAttachment()
	rows, err := s.SessionAttachments(ctx, parent.SessionRef, request)
	if err != nil {
		t.Fatal(err)
	}
	for _, active := range []bool{false, true} {
		child, token, e := s.ReserveSessionOwner(ctx, ReserveSessionOwner{Realm: "r", OwnerUserID: "alice", ProjectID: "p", NodeID: "node", ParentSessionRef: parent.SessionRef})
		if e != nil {
			t.Fatal(e)
		}
		lease, e := s.SessionExecutionLease(ctx, child.SessionRef, request.ExecutionLeaseRequest, "acquire")
		if e != nil {
			t.Fatal(e)
		}
		fork := request
		fork.Operation, fork.Receipt, fork.SourceSession, fork.ReceiptIDs, fork.FencingToken = "inherit", nil, parent.SessionRef, []string{rows[0].ReceiptID}, lease.FencingToken
		if _, e = s.SessionAttachments(ctx, child.SessionRef, fork); e != nil {
			t.Fatal(e)
		}
		if active {
			if _, e = s.ActivateSessionOwner(ctx, "r", child.SessionRef, token); e != nil {
				t.Fatal(e)
			}
		}
		fork.Operation, fork.ReceiptIDs, fork.CreationToken = "abort-inheritance", nil, strings.Repeat("f", 64)
		if _, e = s.SessionAttachments(ctx, child.SessionRef, fork); e == nil {
			t.Fatal("wrong reservation token accepted")
		}
		fork.CreationToken = token
		_, e = s.SessionAttachments(ctx, child.SessionRef, fork)
		if active {
			if !errors.Is(e, ErrOwnerConflict) {
				t.Fatalf("active abort: %v", e)
			}
		} else {
			if e != nil {
				t.Fatal(e)
			}
			if _, e = s.SessionAttachments(ctx, child.SessionRef, fork); e != nil {
				t.Fatalf("abort replay: %v", e)
			}
			if _, e = s.ActivateSessionOwner(ctx, "r", child.SessionRef, token); !errors.Is(e, ErrOwnerConflict) {
				t.Fatalf("aborted child activated: %v", e)
			}
		}
		var references, charges int
		if e = s.pool.QueryRow(ctx, `SELECT count(*) FROM session_attachment_receipts WHERE session_ref=$1`, child.SessionRef).Scan(&references); e != nil {
			t.Fatal(e)
		}
		if e = s.pool.QueryRow(ctx, `SELECT count(*) FROM platform_storage_charges WHERE reference_id LIKE $1 AND released_at IS NULL`, child.SessionRef+"/%").Scan(&charges); e != nil {
			t.Fatal(e)
		}
		expected := 0
		if active {
			expected = 1
		}
		if references != expected || charges != expected {
			t.Fatalf("active=%v references=%d charges=%d", active, references, charges)
		}
	}
}
