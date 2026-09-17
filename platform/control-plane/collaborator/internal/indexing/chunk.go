// Package indexing 消费协作服务的发布 outbox，把已发布快照投影进知识库 seam（§5.4.3）。
//
// 管道形状：outbox 行 → 分片 → POST /seam/knowledge/ingest → 确认（MarkDispatched）。
//
// 三条不变量，每条都对应一处具体的失败模式：
//
//  1. **只投影发布态。** 输入只有 collab_snapshots 的内容（铁律 17）。编辑态 CRDT
//     update 流永不进入这里。
//  2. **分片必须是内容的纯函数。** 下游按 (doc_id, chunk_index) upsert，所以「同一
//     内容重放必须得到逐字相同的分片序列」，否则重试会留下错位的旧分片。因此这里
//     不用随机、不用时间、不用 map 迭代顺序。
//  3. **确认发生在写入成功之后。** 顺序反了就会出现「标记已派发但知识库没有」的
//     静默丢失，而 outbox 的全部意义就是不让这件事发生。
package indexing

import (
	"strings"
	"unicode"
)

// Chunk 一个待嵌入的分片。metadata 是图投影的输入（见 knowledge/graph-projector.ts：
// 它只读 metadata.references / entities / derivedFrom）。
type Chunk struct {
	Text     string         `json:"text"`
	Metadata map[string]any `json:"metadata"`
}

// ChunkOptions 分片参数。零值不可用，用 DefaultChunkOptions。
type ChunkOptions struct {
	// MaxRunes 单个分片的目标上限（按 rune 计，不按字节：中文文档按字节切会把
	// 一个字劈成两半，也会让「1200 字节」这种配置实际只装 400 个汉字）。
	MaxRunes int
	// MinRunes 合并下限：小于它的尾块尽量并进前一块，避免产生大量碎片分片。
	MinRunes int
}

// DefaultChunkOptions 面向中文技术文档的保守取值。
//
// MaxRunes 取 800：多数 embedding 模型的上下文在 512–8192 token，中文大致 1 字 1
// token，800 字留足了安全余量；再大则单分片语义过杂、召回精度下降。
func DefaultChunkOptions() ChunkOptions {
	return ChunkOptions{MaxRunes: 800, MinRunes: 80}
}

// ChunkContent 把已发布正文切成确定性分片。
//
// 切分策略：先按空行切成块（Markdown 的段落/列表/代码块边界），再贪心装箱到
// MaxRunes。**不做重叠**：重叠会让同一段文字出现在两个分片里，召回时重复命中，
// 而 chunk_index 的稳定性（重放幂等的前提）在重叠窗口变化时也更难保证。
func ChunkContent(content string, opts ChunkOptions) []Chunk {
	if opts.MaxRunes <= 0 {
		opts = DefaultChunkOptions()
	}
	if opts.MinRunes <= 0 || opts.MinRunes > opts.MaxRunes {
		opts.MinRunes = opts.MaxRunes / 10
	}

	blocks := splitBlocks(content)
	if len(blocks) == 0 {
		// 空正文是合法发布（发布了但没内容）：返回零分片，下游会清掉该文档的旧投影。
		// 这不是错误，所以不报错——但也不返回一个空文本分片去污染向量表。
		return nil
	}

	references := extractReferences(content)

	var texts []string
	var current []string
	currentRunes := 0
	flush := func() {
		if len(current) == 0 {
			return
		}
		texts = append(texts, strings.Join(current, "\n\n"))
		current = nil
		currentRunes = 0
	}

	for _, block := range blocks {
		// 单块本身就超限：先结清手上这块，再把超长块按 rune 硬切。
		if countRunes(block) > opts.MaxRunes {
			flush()
			for _, piece := range hardSplit(block, opts.MaxRunes) {
				texts = append(texts, piece)
			}
			continue
		}
		if currentRunes+countRunes(block) > opts.MaxRunes {
			flush()
		}
		current = append(current, block)
		currentRunes += countRunes(block)
	}
	flush()

	// 尾块过小就并回前一块（可能略微超过 MaxRunes，这是有意的：碎片分片对检索
	// 的伤害大于一次轻微超限）。
	if len(texts) > 1 && countRunes(texts[len(texts)-1]) < opts.MinRunes {
		last := texts[len(texts)-1]
		texts = texts[:len(texts)-1]
		texts[len(texts)-1] = texts[len(texts)-1] + "\n\n" + last
	}

	out := make([]Chunk, 0, len(texts))
	for i, text := range texts {
		meta := map[string]any{"chunkIndex": i, "chunkCount": len(texts)}
		if refs := referencesIn(text, references); len(refs) > 0 {
			meta["references"] = refs
		}
		out = append(out, Chunk{Text: text, Metadata: meta})
	}
	return out
}

// splitBlocks 按空行切块，并丢弃纯空白块。
func splitBlocks(content string) []string {
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	var blocks []string
	var current []string
	for _, line := range strings.Split(normalized, "\n") {
		if strings.TrimSpace(line) == "" {
			if len(current) > 0 {
				blocks = append(blocks, strings.Join(current, "\n"))
				current = nil
			}
			continue
		}
		current = append(current, line)
	}
	if len(current) > 0 {
		blocks = append(blocks, strings.Join(current, "\n"))
	}
	return blocks
}

// hardSplit 把超长块按 rune 边界切成不超过 limit 的片段，优先在空白处断开。
func hardSplit(block string, limit int) []string {
	runes := []rune(block)
	var out []string
	for len(runes) > limit {
		cut := limit
		// 回退到最近一个空白字符，避免把单词/标识符切断；回退超过一半就放弃
		// （说明这段本来就没有空白，比如一长串 base64），宁可硬切。
		for i := limit; i > limit/2; i-- {
			if unicode.IsSpace(runes[i-1]) {
				cut = i
				break
			}
		}
		out = append(out, strings.TrimSpace(string(runes[:cut])))
		runes = runes[cut:]
	}
	if len(runes) > 0 {
		out = append(out, strings.TrimSpace(string(runes)))
	}
	return out
}

func countRunes(s string) int { return len([]rune(s)) }

// extractReferences 从整篇正文抽取 Markdown 链接目标与 wiki 链接。
//
// 抽整篇再按分片归属，而不是逐分片抽：链接的**定义**和**使用**可能落在相邻分片，
// 逐分片抽会漏掉跨分片的引用，而图投影靠 references 建边。
func extractReferences(content string) map[string]struct{} {
	refs := make(map[string]struct{})
	for _, target := range markdownLinkTargets(content) {
		refs[target] = struct{}{}
	}
	for _, target := range wikiLinkTargets(content) {
		refs[target] = struct{}{}
	}
	return refs
}

// markdownLinkTargets 抽取 [text](target) 的 target（不含锚点与标题部分）。
func markdownLinkTargets(content string) []string {
	var out []string
	for i := 0; i < len(content); i++ {
		if content[i] != ']' || i+1 >= len(content) || content[i+1] != '(' {
			continue
		}
		end := strings.IndexByte(content[i+2:], ')')
		if end < 0 {
			continue
		}
		target := strings.TrimSpace(content[i+2 : i+2+end])
		// 去掉可选的 "标题" 与 #锚点，只留目标本身
		if idx := strings.IndexAny(target, "#"); idx >= 0 {
			target = target[:idx]
		}
		if idx := strings.Index(target, ` "`); idx >= 0 {
			target = target[:idx]
		}
		target = strings.TrimSpace(target)
		if target != "" && !strings.ContainsAny(target, "\n") {
			out = append(out, target)
		}
		i += 2 + end
	}
	return out
}

// wikiLinkTargets 抽取 [[target]] / [[target|别名]] 的 target。
func wikiLinkTargets(content string) []string {
	var out []string
	for {
		start := strings.Index(content, "[[")
		if start < 0 {
			return out
		}
		end := strings.Index(content[start+2:], "]]")
		if end < 0 {
			return out
		}
		inner := content[start+2 : start+2+end]
		if bar := strings.IndexByte(inner, '|'); bar >= 0 {
			inner = inner[:bar]
		}
		inner = strings.TrimSpace(inner)
		if inner != "" {
			out = append(out, inner)
		}
		content = content[start+2+end+2:]
	}
}

// referencesIn 返回分片文本中实际出现的引用（保序、去重），供图投影建边。
func referencesIn(text string, all map[string]struct{}) []string {
	if len(all) == 0 {
		return nil
	}
	seen := make(map[string]struct{})
	var out []string
	for _, target := range append(markdownLinkTargets(text), wikiLinkTargets(text)...) {
		if _, ok := all[target]; !ok {
			continue
		}
		if _, dup := seen[target]; dup {
			continue
		}
		seen[target] = struct{}{}
		out = append(out, target)
	}
	return out
}
