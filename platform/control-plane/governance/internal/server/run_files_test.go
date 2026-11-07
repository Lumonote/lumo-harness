package server

import (
	"encoding/json"
	"fmt"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestControlledRuntimeDecoderAdmitsBoundedEscapedFilesAndRejectsSelfAttestation(t *testing.T) {
	result := domain.TaskResult{TaskID: "task", RunID: "run", State: "COMPLETED", SessionRef: "session", Summary: "files delivered", Output: json.RawMessage(`[{"type":"text","text":"complete output"}]`)}
	for i := 0; i < 8; i++ {
		result.Files = append(result.Files, domain.RunTextFile{Name: fmt.Sprintf("file-%d.txt", i), MediaType: "text/plain; charset=utf-8", Text: strings.Repeat("<", 32768)})
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) <= 1<<20 {
		t.Fatal("fixture must exercise escaped UTF-8 beyond the ordinary JSON body bound")
	}
	var decoded domain.TaskResult
	if !decodeControlledRunResult(httptest.NewRecorder(), httptest.NewRequest("PUT", "/", strings.NewReader(string(raw))), &decoded) || decoded.Validate() != nil {
		t.Fatal("bounded controlled runtime output refused")
	}
	for _, body := range []string{`{"task_id":"task","proven":true}`, `{} {}`, strings.Repeat("x", (4<<20)+1)} {
		if decodeControlledRunResult(httptest.NewRecorder(), httptest.NewRequest("PUT", "/", strings.NewReader(body)), &domain.TaskResult{}) {
			t.Fatal("self-attested or unbounded result accepted")
		}
	}
}
