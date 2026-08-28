package bundle

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/jsonlzstd"
	"github.com/lumo-harness/platform/registry/internal/objstore"
)

func TestCreateAndDecodeBundle(t *testing.T) {
	policy := []byte("# approved policy\n")
	executable := []byte{0, 1, 2, 3}
	raw, got, err := Create(
		Header{SchemaVersion: SchemaVersion, Bundle: "bundle.customer-service", Version: "1.0.0"},
		[]Artifact{{Name: "skill.enterprise-policy", Version: "2.0.0", Digest: objstore.Digest([]byte("artifact"))}},
		[]Entry{
			{Path: "skills/enterprise-policy/SKILL.md", Encoding: "utf8", SHA256: objstore.Digest(policy), Data: string(policy)},
			{Path: "bin/pdf-render", Encoding: "base64", SHA256: objstore.Digest(executable), Data: base64.StdEncoding.EncodeToString(executable)},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got.CompressedDigest != objstore.Digest(raw) || got.Footer.EntryCount != 2 || len(got.Artifacts) != 1 {
		t.Fatalf("decoded Bundle = %+v", got)
	}
}

func TestDecodeRejectsFooterOrPathTampering(t *testing.T) {
	payload := []byte("safe")
	_, _, err := Create(
		Header{SchemaVersion: SchemaVersion, Bundle: "bundle.safe", Version: "1.0.0"}, nil,
		[]Entry{{Path: "skills/safe/SKILL.md", Encoding: "utf8", SHA256: objstore.Digest(payload), Data: string(payload)}},
	)
	if err != nil {
		t.Fatal(err)
	}
	badFooter, err := jsonlzstd.Encode([]json.RawMessage{
		json.RawMessage(`{"type":"bundle-header","schema_version":1,"bundle":"bundle.safe","version":"1.0.0"}`),
		json.RawMessage(`{"type":"entry","path":"../outside","encoding":"utf8","sha256":"sha256:0f7c3b2a6a2d77dc60242f6f793e184021e40a2b02a2f83c03258c3d7bd0a5c7","data":"safe"}`),
		json.RawMessage(`{"type":"bundle-footer","entry_count":1,"content_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}`),
	}, jsonlzstd.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = Decode(badFooter)
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}

func TestCreateRejectsUnsafePath(t *testing.T) {
	payload := []byte("safe")
	_, _, err := Create(
		Header{SchemaVersion: SchemaVersion, Bundle: "bundle.safe", Version: "1.0.0"}, nil,
		[]Entry{{Path: "../unsafe", Encoding: "utf8", SHA256: objstore.Digest(payload), Data: string(payload)}},
	)
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}
