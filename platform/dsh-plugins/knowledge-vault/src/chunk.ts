/**
 * Markdown 标题切块（纯函数）。`#`/`##` 标题开启新块，标题行保留在块内；
 * 首个标题出现前的正文并作「正文」块；只有标题没有正文的块丢弃。
 */

export interface VaultChunk {
  text: string
  metadata: { heading: string }
}

const HEADING = /^(#{1,2})\s+(.*)$/u

export function splitMarkdownChunks(body: string): VaultChunk[] {
  const sections: Array<{ heading: string; lines: string[] }> = []
  let current: { heading: string; lines: string[] } | null = null
  for (const line of body.split(/\r?\n/)) {
    const match = HEADING.exec(line)
    if (match !== null) {
      current = { heading: match[2]!.trim(), lines: [line] }
      sections.push(current)
    } else if (current === null) {
      current = { heading: '正文', lines: [line] }
      sections.push(current)
    } else {
      current.lines.push(line)
    }
  }
  return sections
    .map(section => ({ heading: section.heading, text: section.lines.join('\n').trim() }))
    .filter(section => {
      if (section.text === '') return false
      const lines = section.text.split('\n')
      // 标题行后没有正文（只有标题的块）→ 丢弃
      if (HEADING.test(lines[0]!)) return lines.slice(1).join('\n').trim() !== ''
      return true
    })
    .map(section => ({ text: section.text, metadata: { heading: section.heading } }))
}
