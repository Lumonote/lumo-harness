package indexing

import (
	"reflect"
	"strings"
	"testing"
)

func TestChunkContentIsDeterministic(t *testing.T) {
	content := "# 标题\n\n第一段内容，比较短。\n\n第二段也短。\n\n## 小节\n\n- 列表项一\n- 列表项二\n\n[参考](docs/design.md) 与 [[知识库约定]] 都在这里。\n"
	first := ChunkContent(content, DefaultChunkOptions())
	for i := 0; i < 20; i++ {
		again := ChunkContent(content, DefaultChunkOptions())
		if !reflect.DeepEqual(first, again) {
			t.Fatalf("第 %d 次分片与首次不一致：分片必须只是内容的纯函数，"+
				"否则重试会按 chunk_index 写入错位的旧分片\nfirst=%#v\nagain=%#v", i+1, first, again)
		}
	}
	if len(first) == 0 {
		t.Fatal("非空内容必须产生至少一个分片")
	}
}

func TestChunkContentRespectsLimit(t *testing.T) {
	// 三个 300 rune 的块 + 上限 800：贪心装箱应在第三块处换行。
	block := strings.Repeat("甲", 300)
	content := block + "\n\n" + block + "\n\n" + block
	chunks := ChunkContent(content, ChunkOptions{MaxRunes: 800, MinRunes: 80})
	if len(chunks) != 2 {
		t.Fatalf("期望 2 个分片（600 + 300），实得 %d", len(chunks))
	}
	for i, c := range chunks {
		if got := len([]rune(c.Text)); got > 800 {
			t.Fatalf("分片 %d 有 %d 个 rune，超过上限 800", i, got)
		}
	}
}

func TestChunkContentHardSplitsOversizedBlock(t *testing.T) {
	// 单个超长段落没有空行可切，必须按 rune 硬切而不是整块塞进一个分片。
	content := strings.Repeat("乙", 2000)
	chunks := ChunkContent(content, ChunkOptions{MaxRunes: 800, MinRunes: 80})
	if len(chunks) < 3 {
		t.Fatalf("2000 rune 的单块按 800 上限至少要 3 个分片，实得 %d", len(chunks))
	}
	total := 0
	for _, c := range chunks {
		if got := len([]rune(c.Text)); got > 800 {
			t.Fatalf("硬切后仍有 %d rune 的分片", got)
		}
		total += len([]rune(c.Text))
	}
	if total != 2000 {
		t.Fatalf("硬切不能丢字符：原文 2000，实得 %d", total)
	}
}

func TestChunkContentHardSplitPrefersWhitespace(t *testing.T) {
	// 在靠近上限处有空格时应从空格断开，避免把单词切成两半。
	word := strings.Repeat("word ", 300) // 1500 rune，末尾带空格
	chunks := ChunkContent(word, ChunkOptions{MaxRunes: 100, MinRunes: 10})
	for _, c := range chunks {
		if strings.HasPrefix(c.Text, "ord") || strings.HasSuffix(c.Text, "wor") {
			t.Fatalf("硬切把单词切断了: %q", c.Text)
		}
	}
}

func TestChunkContentEmptyIsNoChunks(t *testing.T) {
	for _, content := range []string{"", "   ", "\n\n\n", "\r\n  \r\n"} {
		if got := ChunkContent(content, DefaultChunkOptions()); got != nil {
			t.Fatalf("空正文 %q 必须产生零分片（不是空文本分片），实得 %#v", content, got)
		}
	}
}

func TestChunkContentNormalizesCRLF(t *testing.T) {
	crlf := "第一段\r\n\r\n第二段"
	lf := "第一段\n\n第二段"
	if !reflect.DeepEqual(ChunkContent(crlf, DefaultChunkOptions()), ChunkContent(lf, DefaultChunkOptions())) {
		t.Fatal("CRLF 与 LF 的分片结果必须一致，否则同一文档在不同编辑器下会写出不同 chunk_index")
	}
}

func TestChunkContentMergesTinyTail(t *testing.T) {
	// 尾块小于 MinRunes 时并入前一块，避免产生碎片分片。
	big := strings.Repeat("丙", 700)
	content := big + "\n\n短尾"
	chunks := ChunkContent(content, ChunkOptions{MaxRunes: 800, MinRunes: 80})
	if len(chunks) != 1 {
		t.Fatalf("尾块应并入前一块，期望 1 个分片，实得 %d", len(chunks))
	}
	if !strings.Contains(chunks[0].Text, "短尾") {
		t.Fatal("并入后必须仍包含尾块文本")
	}
}

func TestChunkMetadataIndexesAndCount(t *testing.T) {
	block := strings.Repeat("丁", 500)
	chunks := ChunkContent(block+"\n\n"+block, ChunkOptions{MaxRunes: 600, MinRunes: 10})
	if len(chunks) < 2 {
		t.Fatalf("期望至少 2 个分片，实得 %d", len(chunks))
	}
	for i, c := range chunks {
		if c.Metadata["chunkIndex"] != i {
			t.Fatalf("分片 %d 的 chunkIndex = %v", i, c.Metadata["chunkIndex"])
		}
		if c.Metadata["chunkCount"] != len(chunks) {
			t.Fatalf("分片 %d 的 chunkCount = %v，期望 %d", i, c.Metadata["chunkCount"], len(chunks))
		}
	}
}

func TestChunkReferencesFeedGraphProjection(t *testing.T) {
	// graph-projector.ts 只读 metadata.references 建边；抽不到就等于图里没有边。
	// 上限调到 50 让两个引用段各自成片，从而能分别断言归属。
	content := "见 [设计文档](docs/design.md#锚点) 与 [[知识库约定|别名]]。\n\n" +
		"这一段引用 [另一个](docs/other.md \"带标题\")。"
	chunks := ChunkContent(content, ChunkOptions{MaxRunes: 50, MinRunes: 1})
	if len(chunks) != 2 {
		t.Fatalf("期望 2 个分片，实得 %d", len(chunks))
	}
	first, _ := chunks[0].Metadata["references"].([]string)
	if !reflect.DeepEqual(first, []string{"docs/design.md", "知识库约定"}) {
		t.Fatalf("首个分片的引用应为 [docs/design.md 知识库约定]（去锚点、去别名、保序），实得 %#v", first)
	}
	second, _ := chunks[1].Metadata["references"].([]string)
	if !reflect.DeepEqual(second, []string{"docs/other.md"}) {
		t.Fatalf("第二个分片的引用应去掉 \"标题\" 部分，实得 %#v", second)
	}
}

func TestChunkWithoutReferencesOmitsKey(t *testing.T) {
	// 无引用时不能带一个空 references：下游把「有键但为空」当作「有引用」处理。
	chunks := ChunkContent("这一段没有任何链接。", DefaultChunkOptions())
	if len(chunks) != 1 {
		t.Fatalf("期望 1 个分片，实得 %d", len(chunks))
	}
	if _, ok := chunks[0].Metadata["references"]; ok {
		t.Fatal("无引用的分片不应带 references 键")
	}
}

func TestChunkReferencesDeduplicatesWithinChunk(t *testing.T) {
	content := "[a](x.md) 和 [b](x.md) 指向同一目标"
	chunks := ChunkContent(content, DefaultChunkOptions())
	refs, _ := chunks[0].Metadata["references"].([]string)
	if len(refs) != 1 || refs[0] != "x.md" {
		t.Fatalf("同一分片内的重复引用应去重，实得 %#v", refs)
	}
}

func TestChunkOptionsFallback(t *testing.T) {
	// 零值 ChunkOptions 不能被当成「上限 0」，否则会把内容切成单字分片。
	chunks := ChunkContent(strings.Repeat("戊", 100), ChunkOptions{})
	if len(chunks) != 1 {
		t.Fatalf("零值选项应回落到默认值，100 rune 内容期望 1 个分片，实得 %d", len(chunks))
	}
}
