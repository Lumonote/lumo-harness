package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRunOutputManifestEnumeratesAndHashesExactText(t *testing.T) {
	result := TaskResult{TaskID: "task", RunID: "run", Summary: "delivered", Output: json.RawMessage(`[{"type":"text","text":"one"},{"type":"text","text":"two"},{"type":"text","text":"three"}]`)}
	manifest, digest, err := BuildRunOutputManifest(result)
	if err != nil || len(digest) != 64 || len(manifest.Entries) != 3 || manifest.Scope != ClosedTextOutputProfile {
		t.Fatalf("manifest: %+v %s %v", manifest, digest, err)
	}
	_, same, err := BuildRunOutputManifest(result)
	if err != nil || same != digest {
		t.Fatal("manifest digest must be deterministic")
	}
	result.Summary = "changed"
	_, changed, _ := BuildRunOutputManifest(result)
	if changed == digest {
		t.Fatal("summary change did not invalidate digest")
	}
	for _, raw := range []string{`null`, `[]`, `{"artifacts":0,"proven":true}`, `[{"type":"image","text":"one"}]`, `[{"type":"text","text":" "}]`, `[{"type":"text","text":"one","proven":true}]`} {
		result.Output = json.RawMessage(raw)
		if _, _, err := BuildRunOutputManifest(result); err == nil {
			t.Fatalf("unknown output accepted: %s", raw)
		}
	}
}

func TestReviewApprovalBindsExactDigestAndStructuredVerdict(t *testing.T) {
	digest := strings.Repeat("a", 64)
	output := func(text string) json.RawMessage {
		raw, _ := json.Marshal([]map[string]string{{"type": "text", "text": text}})
		return raw
	}
	approved, err := ReviewApproval(output(`{"verdict":"approve","manifest_digest":"`+digest+`"}`), digest)
	if err != nil || !approved {
		t.Fatal(err)
	}
	approved, err = ReviewApproval(output(`{"verdict":"reject","manifest_digest":"`+digest+`"}`), digest)
	if err != nil || approved {
		t.Fatal("rejection approved")
	}
	for _, text := range []string{`Looks good`, "```json\n{}\n```", `{"verdict":"approve","manifest_digest":"old"}`, `{"verdict":"approve","manifest_digest":"` + digest + `","proven":true}`, `{"verdict":"approve","manifest_digest":"` + digest + `"} {}`} {
		if ok, err := ReviewApproval(output(text), digest); err == nil || ok {
			t.Fatalf("invalid approval accepted: %s", text)
		}
	}
}
