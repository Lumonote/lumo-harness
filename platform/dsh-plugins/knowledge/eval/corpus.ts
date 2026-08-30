/**
 * 评测语料切块（评测夹具，**不是**分块策略的实现）。
 *
 * 刻意保持朴素：按 markdown 标题切，一个标题一条 chunk。真正的分块策略（自适应分层、
 * 父子分块）属于 ingest 管道，不在本轮范围 —— 见 spec §7.3。
 */

export interface CorpusChunk {
  /** `{prefix}#{小节号}`，与 golden.zh.json 的 expectedDocIds 对齐 */
  docId: string
  title: string
  text: string
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/
/** 标题里的小节号，如「5.4.4 Embedding 版本化」的 `5.4.4`、「0. 定位」的 `0` */
const SECTION_NUMBER = /^(\d+(?:\.\d+)*)\.?(?:\s|$)/

function docIdFor(title: string, prefix: string): string {
  const numbered = SECTION_NUMBER.exec(title)
  // 无编号标题回退到标题本身作 slug —— 术语字典这类没有编号但值得检索的小节要能被标注。
  return `${prefix}#${numbered ? numbered[1] : title.trim()}`
}

export function chunkByHeading(markdown: string, prefix: string): CorpusChunk[] {
  const chunks: CorpusChunk[] = []
  let current: CorpusChunk | undefined

  for (const line of markdown.split('\n')) {
    const heading = HEADING.exec(line)
    if (heading) {
      // 每个标题都开新块，无论层级 —— 否则上级块会把下级正文吞进来，
      // 一条 chunk 命中即算命中两节，指标虚高。
      if (current) chunks.push(current)
      const title = heading[2]!
      current = { docId: docIdFor(title, prefix), title, text: `${title}\n` }
      continue
    }
    // 首个标题之前的导语没有小节归属，留着会制造无法标注的 docId，直接丢弃。
    if (current) current.text += `${line}\n`
  }
  if (current) chunks.push(current)

  return chunks
    .map((c) => ({ ...c, text: c.text.trim() }))
    .filter((c) => c.text.length > c.title.length)
}
