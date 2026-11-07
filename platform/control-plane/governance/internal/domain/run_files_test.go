package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestControlledFilesManifestCoversExactUTF8BytesAndAllMetadata(t *testing.T) {
	result := TaskResult{TaskID: "task", RunID: "run", Summary: "complete", Output: json.RawMessage(`[{"type":"text","text":"all files generated"}]`), Files: []RunTextFile{{Name: "report.md", MediaType: "text/markdown; charset=utf-8", Text: "# 结论\n全部内容"}, {Name: "data.json", MediaType: "application/json", Text: `{"ok":true}`}}}
	manifest, digest, err := BuildRunTextFilesManifest(result)
	if err != nil || manifest.Scope != ClosedTextFilesOutputProfile || len(manifest.Files) != 2 || manifest.Files[0].Bytes != len([]byte(result.Files[0].Text)) {
		t.Fatalf("manifest: %+v %s %v", manifest, digest, err)
	}
	for _, change := range []string{"text", "name", "media", "summary", "omit", "order"} {
		copy := result
		copy.Files = append([]RunTextFile{}, result.Files...)
		switch change {
		case "text":
			copy.Files[0].Text += "!"
		case "name":
			copy.Files[0].Name = "other.md"
		case "media":
			copy.Files[0].Name = "report.txt"
			copy.Files[0].MediaType = "text/plain; charset=utf-8"
		case "summary":
			copy.Summary = "changed"
		case "omit":
			copy.Files = copy.Files[:1]
		case "order":
			copy.Files[0], copy.Files[1] = copy.Files[1], copy.Files[0]
		}
		_, changed, err := BuildRunTextFilesManifest(copy)
		if err != nil || changed == digest {
			t.Fatalf("%s not bound to exact digest: %v", change, err)
		}
	}
}
func TestControlledFilesRejectUnknownFormatsAndBounds(t *testing.T) {
	valid := RunTextFile{Name: "safe.txt", MediaType: "text/plain; charset=utf-8", Text: "text"}
	for _, file := range []RunTextFile{{Name: "../safe.txt", MediaType: valid.MediaType, Text: "x"}, {Name: "shell.sh", MediaType: valid.MediaType, Text: "x"}, {Name: "safe.txt", MediaType: "text/html", Text: "x"}, {Name: "data.json", MediaType: "application/json", Text: "not json"}, {Name: "safe.txt", MediaType: valid.MediaType, Text: "\x00"}, {Name: "safe.txt", MediaType: valid.MediaType, Text: strings.Repeat("x", 32769)}} {
		if ValidateRunTextFiles([]RunTextFile{file}) == nil {
			t.Fatalf("invalid file accepted: %q", file.Name)
		}
	}
	if ValidateRunTextFiles(nil) == nil || ValidateRunTextFiles([]RunTextFile{valid, valid}) == nil {
		t.Fatal("empty or duplicate file set accepted")
	}
	files := make([]RunTextFile, 9)
	for i := range files {
		files[i] = RunTextFile{Name: string(rune('a'+i)) + ".txt", MediaType: valid.MediaType, Text: strings.Repeat("x", 32768)}
	}
	if ValidateRunTextFiles(files) == nil {
		t.Fatal("aggregate file size accepted")
	}
}
