// Package bundle defines the immutable JSONL + zstd artifact Bundle format.
//
// A Bundle's digest and signature cover the compressed .jsonl.zst bytes.  This
// package never recompresses data while reading: Decode validates the exact
// incoming bytes, then validates the decompressed record stream and every
// entry digest before handing data to an installer.
package bundle

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/lumo-harness/platform/registry/internal/jsonlzstd"
	"github.com/lumo-harness/platform/registry/internal/objstore"
)

const SchemaVersion = 1

var (
	ErrInvalid = errors.New("registry: 非法 Bundle")
	bundleName = regexp.MustCompile(`^[a-z][a-z0-9.-]{2,127}$`)
	version    = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
)

// Header is the first record of a Bundle.
type Header struct {
	SchemaVersion int    `json:"schema_version"`
	Bundle        string `json:"bundle"`
	Version       string `json:"version"`
}

// Artifact pins one logical dependency to the exact content digest chosen by
// the Bundle author.  The object itself is fetched and signature-verified by
// the Registry/Provisioner path; this line preserves the immutable closure.
type Artifact struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Digest  string `json:"digest"`
}

// Entry is an unpackable Bundle payload.  The schema deliberately has no mode,
// link target, or install script field, so a Bundle cannot encode a symlink or
// an implicit executable action.
type Entry struct {
	Path     string `json:"path"`
	Encoding string `json:"encoding"` // utf8 or base64
	SHA256   string `json:"sha256"`
	Data     string `json:"data"`
}

// Footer is the last record and binds the ordered entry list.
type Footer struct {
	EntryCount    int    `json:"entry_count"`
	ContentDigest string `json:"content_digest"`
}

// Bundle is a verified projection of the compressed stream.
type Bundle struct {
	Header           Header     `json:"header"`
	Artifacts        []Artifact `json:"artifacts,omitempty"`
	Entries          []Entry    `json:"entries"`
	Footer           Footer     `json:"footer"`
	CompressedDigest string     `json:"compressed_digest"`
}

type headerRecord struct {
	Type string `json:"type"`
	Header
}

type artifactRecord struct {
	Type string `json:"type"`
	Artifact
}

type entryRecord struct {
	Type string `json:"type"`
	Entry
}

type footerRecord struct {
	Type string `json:"type"`
	Footer
}

// Create serializes a valid Bundle to its canonical JSONL+zstd transport
// representation.  The caller signs the returned bytes directly.
func Create(header Header, artifacts []Artifact, entries []Entry) ([]byte, *Bundle, error) {
	if err := validateHeader(header); err != nil {
		return nil, nil, err
	}
	if len(entries) == 0 {
		return nil, nil, invalid("Bundle 至少需要一条 entry")
	}
	records := make([]json.RawMessage, 0, len(artifacts)+len(entries)+2)
	if raw, err := json.Marshal(headerRecord{Type: "bundle-header", Header: header}); err != nil {
		return nil, nil, err
	} else {
		records = append(records, raw)
	}
	seenArtifacts := map[string]struct{}{}
	for _, artifact := range artifacts {
		if err := validateArtifact(artifact); err != nil {
			return nil, nil, err
		}
		key := artifact.Name + "\x00" + artifact.Version
		if _, exists := seenArtifacts[key]; exists {
			return nil, nil, invalid("artifact %s@%s 重复", artifact.Name, artifact.Version)
		}
		seenArtifacts[key] = struct{}{}
		raw, err := json.Marshal(artifactRecord{Type: "artifact", Artifact: artifact})
		if err != nil {
			return nil, nil, err
		}
		records = append(records, raw)
	}
	seenPaths := map[string]struct{}{}
	for _, entry := range entries {
		if _, err := entryBytes(entry); err != nil {
			return nil, nil, err
		}
		if _, exists := seenPaths[entry.Path]; exists {
			return nil, nil, invalid("entry.path %q 重复", entry.Path)
		}
		seenPaths[entry.Path] = struct{}{}
		raw, err := json.Marshal(entryRecord{Type: "entry", Entry: entry})
		if err != nil {
			return nil, nil, err
		}
		records = append(records, raw)
	}
	footer := Footer{EntryCount: len(entries), ContentDigest: contentDigest(entries)}
	raw, err := json.Marshal(footerRecord{Type: "bundle-footer", Footer: footer})
	if err != nil {
		return nil, nil, err
	}
	records = append(records, raw)
	compressed, err := jsonlzstd.Encode(records, jsonlzstd.Limits{})
	if err != nil {
		return nil, nil, err
	}
	parsed, err := Decode(compressed)
	if err != nil {
		return nil, nil, err
	}
	return compressed, parsed, nil
}

// Decode strictly validates a compressed Bundle without changing the signed
// bytes.  It rejects unknown record fields/types, duplicate keys, order
// changes, unsafe paths, entry tampering, and a mismatched footer.
func Decode(compressed []byte) (*Bundle, error) {
	records, err := jsonlzstd.Decode(compressed, jsonlzstd.Limits{})
	if err != nil {
		return nil, err
	}
	result := &Bundle{CompressedDigest: objstore.Digest(compressed)}
	phase := 0 // 0 header, 1 artifacts, 2 entries, 3 footer
	seenArtifacts := map[string]struct{}{}
	seenPaths := map[string]struct{}{}
	for _, raw := range records {
		var envelope struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			return nil, invalid("Bundle record type 解析失败: %v", err)
		}
		switch envelope.Type {
		case "bundle-header":
			if phase != 0 {
				return nil, invalid("bundle-header 必须且只能作为第一条")
			}
			var record headerRecord
			if err := decodeStrict(raw, &record); err != nil {
				return nil, err
			}
			if err := validateHeader(record.Header); err != nil {
				return nil, err
			}
			result.Header = record.Header
			phase = 1
		case "artifact":
			if phase != 1 {
				return nil, invalid("artifact 必须位于 header 和第一条 entry 之间")
			}
			var record artifactRecord
			if err := decodeStrict(raw, &record); err != nil {
				return nil, err
			}
			if err := validateArtifact(record.Artifact); err != nil {
				return nil, err
			}
			key := record.Name + "\x00" + record.Version
			if _, exists := seenArtifacts[key]; exists {
				return nil, invalid("artifact %s@%s 重复", record.Name, record.Version)
			}
			seenArtifacts[key] = struct{}{}
			result.Artifacts = append(result.Artifacts, record.Artifact)
		case "entry":
			if phase != 1 && phase != 2 {
				return nil, invalid("entry 必须位于 header 后、footer 前")
			}
			var record entryRecord
			if err := decodeStrict(raw, &record); err != nil {
				return nil, err
			}
			if _, err := entryBytes(record.Entry); err != nil {
				return nil, err
			}
			if _, exists := seenPaths[record.Path]; exists {
				return nil, invalid("entry.path %q 重复", record.Path)
			}
			seenPaths[record.Path] = struct{}{}
			result.Entries = append(result.Entries, record.Entry)
			phase = 2
		case "bundle-footer":
			if phase != 2 {
				return nil, invalid("bundle-footer 必须位于至少一条 entry 后")
			}
			var record footerRecord
			if err := decodeStrict(raw, &record); err != nil {
				return nil, err
			}
			if record.EntryCount != len(result.Entries) {
				return nil, invalid("footer entry_count=%d，与实际 %d 不符", record.EntryCount, len(result.Entries))
			}
			if record.ContentDigest != contentDigest(result.Entries) {
				return nil, invalid("footer content_digest 与 entry 内容不符")
			}
			result.Footer = record.Footer
			phase = 3
		default:
			return nil, invalid("未声明的 JSONL record type %q", envelope.Type)
		}
	}
	if phase != 3 {
		return nil, invalid("Bundle 缺少 bundle-footer")
	}
	return result, nil
}

func decodeStrict(raw []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return invalid("Bundle record 解析失败: %v", err)
	}
	if dec.More() {
		return invalid("Bundle record 含有额外 JSON 值")
	}
	return nil
}

func validateHeader(header Header) error {
	if header.SchemaVersion != SchemaVersion {
		return invalid("schema_version 必须为 %d", SchemaVersion)
	}
	if !bundleName.MatchString(header.Bundle) {
		return invalid("bundle %q 非法", header.Bundle)
	}
	if !version.MatchString(header.Version) {
		return invalid("version %q 非法（须为 x.y.z）", header.Version)
	}
	return nil
}

func validateArtifact(artifact Artifact) error {
	if !bundleName.MatchString(artifact.Name) {
		return invalid("artifact name %q 非法", artifact.Name)
	}
	if !version.MatchString(artifact.Version) {
		return invalid("artifact version %q 非法", artifact.Version)
	}
	if !objstore.ValidDigest(artifact.Digest) {
		return invalid("artifact digest %q 非法", artifact.Digest)
	}
	return nil
}

func entryBytes(entry Entry) ([]byte, error) {
	if err := validatePath(entry.Path); err != nil {
		return nil, err
	}
	var payload []byte
	switch entry.Encoding {
	case "utf8":
		if !utf8.ValidString(entry.Data) {
			return nil, invalid("entry %q 的 utf8 data 非法", entry.Path)
		}
		payload = []byte(entry.Data)
	case "base64":
		decoded, err := base64.StdEncoding.DecodeString(entry.Data)
		if err != nil {
			return nil, invalid("entry %q 的 base64 data 非法", entry.Path)
		}
		payload = decoded
	default:
		return nil, invalid("entry %q 的 encoding 必须为 utf8 或 base64", entry.Path)
	}
	if len(payload) > 16<<20 {
		return nil, invalid("entry %q 超过 16 MiB", entry.Path)
	}
	if !objstore.ValidDigest(entry.SHA256) || objstore.Digest(payload) != entry.SHA256 {
		return nil, invalid("entry %q 的 sha256 与 data 不符", entry.Path)
	}
	return payload, nil
}

func EntryBytes(entry Entry) ([]byte, error) {
	return entryBytes(entry)
}

func validatePath(value string) error {
	if value == "" || strings.ContainsRune(value, '\x00') || strings.Contains(value, "\\") || path.IsAbs(value) {
		return invalid("entry.path %q 非法", value)
	}
	if cleaned := path.Clean(value); cleaned != value || value == "." || value == ".." || strings.HasPrefix(value, "../") || strings.HasSuffix(value, "/") {
		return invalid("entry.path %q 不得包含目录穿越或非规范段", value)
	}
	return nil
}

func contentDigest(entries []Entry) string {
	h := sha256.New()
	var length [8]byte
	for _, entry := range entries {
		payload, err := entryBytes(entry)
		if err != nil {
			return "" // callers validate each entry before this is reachable
		}
		binary.BigEndian.PutUint64(length[:], uint64(len(entry.Path)))
		_, _ = h.Write(length[:])
		_, _ = h.Write([]byte(entry.Path))
		binary.BigEndian.PutUint64(length[:], uint64(len(payload)))
		_, _ = h.Write(length[:])
		_, _ = h.Write(payload)
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}
