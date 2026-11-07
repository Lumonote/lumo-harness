package store

import (
	"context"
	"errors"
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
	}
	if _, err = s.pool.Exec(ctx, `UPDATE session_execution_leases SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	for _, op := range []string{"get", "list", "create"} {
		bad := in
		bad.Operation = op
		if op != "get" {
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
	if _, err = s.SessionAttachments(ctx, child.SessionRef, fork); err != nil {
		t.Fatal(err)
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
