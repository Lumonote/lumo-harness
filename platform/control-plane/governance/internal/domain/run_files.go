package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

const ClosedTextFilesOutputProfile = "platform-closed-text-files-v1"
const MaxRunTextFiles = 16
const MaxRunTextFileBytes = 32 * 1024
const MaxRunTextFilesBytes = 256 * 1024

type RunTextFile struct {
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	Text      string `json:"text"`
}
type RunFileEntry struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	Bytes     int    `json:"bytes"`
	SHA256    string `json:"sha256"`
}
type RunFileReadReceipt struct {
	ID      string `json:"id"`
	Receipt string `json:"receipt"`
}
type RunReviewFile struct {
	RunFileEntry
	Text    string `json:"text"`
	Receipt string `json:"receipt"`
}

var runFileName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,115}\.(txt|md|csv|json)$`)

func (file RunTextFile) Validate() error {
	if !runFileName.MatchString(file.Name) || strings.Contains(file.Name, "..") || !utf8.ValidString(file.Text) || strings.ContainsRune(file.Text, 0) || len(file.Text) == 0 || len(file.Text) > MaxRunTextFileBytes {
		return fmt.Errorf("controlled file requires a safe leaf name and 1..32768 UTF-8 bytes")
	}
	media := map[string]string{"txt": "text/plain; charset=utf-8", "md": "text/markdown; charset=utf-8", "csv": "text/csv; charset=utf-8", "json": "application/json"}
	ext := file.Name[strings.LastIndexByte(file.Name, '.')+1:]
	if media[ext] != file.MediaType || (ext == "json" && !json.Valid([]byte(file.Text))) {
		return fmt.Errorf("controlled file media type does not match its text format")
	}
	return nil
}
func ValidateRunTextFiles(files []RunTextFile) error {
	if len(files) < 1 || len(files) > MaxRunTextFiles {
		return fmt.Errorf("controlled output requires 1..16 files")
	}
	names := map[string]bool{}
	total := 0
	for _, file := range files {
		if err := file.Validate(); err != nil {
			return err
		}
		name := strings.ToLower(file.Name)
		if names[name] {
			return fmt.Errorf("controlled file names must be unique")
		}
		names[name] = true
		total += len(file.Text)
	}
	if total > MaxRunTextFilesBytes {
		return fmt.Errorf("controlled files exceed 256 KiB")
	}
	return nil
}
func BuildRunTextFilesManifest(result TaskResult) (RunOutputManifest, string, error) {
	manifest, _, err := BuildRunOutputManifest(result)
	if err != nil {
		return manifest, "", err
	}
	if err = ValidateRunTextFiles(result.Files); err != nil {
		return manifest, "", err
	}
	manifest.Scope = ClosedTextFilesOutputProfile
	for i, file := range result.Files {
		hash := sha256.Sum256([]byte(file.Text))
		manifest.Files = append(manifest.Files, RunFileEntry{ID: fmt.Sprintf("file-%04d", i+1), Name: file.Name, MediaType: file.MediaType, Bytes: len(file.Text), SHA256: hex.EncodeToString(hash[:])})
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return manifest, "", err
	}
	hash := sha256.Sum256(raw)
	return manifest, hex.EncodeToString(hash[:]), nil
}
func ProvenOutputProfile(profile string) bool {
	return profile == ClosedTextOutputProfile || profile == ClosedTextFilesOutputProfile || profile == ClosedRepositoryOutputProfile
}
