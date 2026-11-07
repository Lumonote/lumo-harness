package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// ClosedTextOutputProfile covers only the text deliverables collected by the
// tool-free governed executor. It makes no claim about external side effects.
const ClosedTextOutputProfile = "platform-closed-text-v1"

type RunExecutionSnapshot struct {
	Realm          string          `json:"realm"`
	TaskID         string          `json:"task_id"`
	RunID          string          `json:"run_id"`
	WorkerID       string          `json:"worker_id"`
	NodeID         string          `json:"node_id"`
	SessionRef     string          `json:"session_ref"`
	PresetID       string          `json:"preset_id"`
	PresetRevision int             `json:"preset_revision"`
	Provider       string          `json:"provider"`
	Model          string          `json:"model"`
	OutputProfile  string          `json:"output_profile"`
	Intent         string          `json:"intent"`
	IntentContract *IntentContract `json:"intent_contract,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
}

type RunOutputEntry struct {
	ID     string `json:"id"`
	SHA256 string `json:"sha256"`
	Text   string `json:"text"`
}

type RunOutputManifest struct {
	Scope   string           `json:"scope"`
	TaskID  string           `json:"task_id"`
	RunID   string           `json:"run_id"`
	Summary string           `json:"summary"`
	Entries []RunOutputEntry `json:"entries"`
}

// BuildRunOutputManifest enumerates the entire accepted output array; a model
// cannot choose which blocks to register or provide an affected-artifact count.
// Unknown/non-text content cannot be certified by this execution profile.
func BuildRunOutputManifest(result TaskResult) (RunOutputManifest, string, error) {
	manifest := RunOutputManifest{Scope: ClosedTextOutputProfile, TaskID: result.TaskID, RunID: result.RunID, Summary: result.Summary}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	d := json.NewDecoder(bytes.NewReader(result.Output))
	d.DisallowUnknownFields()
	if err := d.Decode(&blocks); err != nil || len(blocks) == 0 || len(blocks) > 256 {
		return manifest, "", fmt.Errorf("closed output requires 1..256 text deliverables")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return manifest, "", fmt.Errorf("invalid closed output")
	}
	for i, block := range blocks {
		if block.Type != "text" || strings.TrimSpace(block.Text) == "" {
			return manifest, "", fmt.Errorf("non-text or empty output has unknown impact")
		}
		h := sha256.Sum256([]byte(block.Text))
		manifest.Entries = append(manifest.Entries, RunOutputEntry{ID: fmt.Sprintf("output-%04d", i+1), SHA256: hex.EncodeToString(h[:]), Text: block.Text})
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return manifest, "", err
	}
	h := sha256.Sum256(raw)
	return manifest, hex.EncodeToString(h[:]), nil
}

type RunReviewContext struct {
	ProducerTaskID   string            `json:"producer_task_id"`
	ProducerRunID    string            `json:"producer_run_id"`
	ProducerIntent   string            `json:"producer_intent"`
	ProducerContract *IntentContract   `json:"producer_contract,omitempty"`
	ManifestDigest   string            `json:"manifest_digest"`
	Manifest         RunOutputManifest `json:"manifest"`
	ExpiresAt        time.Time         `json:"expires_at"`
}

type PreparedRunExecution struct {
	Snapshot RunExecutionSnapshot `json:"snapshot"`
	Review   *RunReviewContext    `json:"review,omitempty"`
}

// ReviewApproval reads the reviewer's immutable execution result, not a human
// transition request. The exact digest is required even for a rejection.
func ReviewApproval(output json.RawMessage, digest string) (bool, error) {
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(output, &blocks); err != nil || len(blocks) != 1 || blocks[0].Type != "text" {
		return false, fmt.Errorf("review requires one structured text verdict")
	}
	var verdict struct {
		Verdict        string `json:"verdict"`
		ManifestDigest string `json:"manifest_digest"`
	}
	d := json.NewDecoder(strings.NewReader(blocks[0].Text))
	d.DisallowUnknownFields()
	if err := d.Decode(&verdict); err != nil {
		return false, fmt.Errorf("invalid review verdict")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return false, fmt.Errorf("review verdict must contain one JSON object")
	}
	if verdict.ManifestDigest != digest || (verdict.Verdict != "approve" && verdict.Verdict != "reject") {
		return false, fmt.Errorf("review verdict does not bind the exact manifest")
	}
	return verdict.Verdict == "approve", nil
}
