/**
 * 统一 Ask 列表的前端数据源合并（P1 工作台）。AsksPanel 原来只读 /lumo/api/asks（连接器 + 远程电脑确认），
 * 这里再并入三类“等人”的来源，各自仍由原后端负责状态机与“只有负责人可答”的校验：
 *   - 双受众插件工具审批   GET /lumo/api/dual/asks          id = run:dual-<n>
 *   - SSH 远端高风险操作   GET /lumo/api/remote-hosts/asks  id = run:remote-…
 *   - ACP 会话权限请求     GET /lumo/api/acp/asks           id = session:acp-…
 * 某个来源未启用（501/404）或失败时静默跳过，不影响其余来源。作答按 id 前缀路由回原来源。
 */
import type { Ask, AskOption } from '../../../../shared/seam-contracts/asks.ts'

export interface AskSource { id: string; label: string; list: string; prefix?: RegExp; answer: (id: string) => string }

const enc = encodeURIComponent
export const ASK_SOURCES: readonly AskSource[] = [
  { id: 'unified', label: '统一审批', list: '/lumo/api/asks', answer: id => `/lumo/api/asks/${enc(id)}/answer` },
  { id: 'dual', label: '插件工具', list: '/lumo/api/dual/asks', prefix: /^run:dual-/u, answer: id => `/lumo/api/dual/asks/${enc(id)}/answer` },
  { id: 'remote-hosts', label: '远端机器', list: '/lumo/api/remote-hosts/asks', prefix: /^run:remote-/u, answer: id => `/lumo/api/remote-hosts/asks/${enc(id)}/answer` },
  { id: 'acp', label: '引擎会话', list: '/lumo/api/acp/asks', prefix: /^session:acp-/u, answer: id => `/lumo/api/acp/asks/${enc(id)}/answer` },
]

export function sourceOf(ask: Pick<Ask, 'id'>): AskSource {
  return ASK_SOURCES.find(s => s.prefix?.test(ask.id)) ?? ASK_SOURCES[0]!
}
export function answerPath(ask: Pick<Ask, 'id'>): string { return sourceOf(ask).answer(ask.id) }

/** 从标题 / operation / source_status 判断高风险（dual 标题含“风险 high”；远端安装/升级/回滚/隧道一律高风险）。 */
export function isHighRisk(ask: Pick<Ask, 'id' | 'title' | 'source'>): boolean {
  if (/风险\s*high/u.test(ask.title)) return true
  if (/^run:remote-/u.test(ask.id)) return true
  return /^remote\./u.test(ask.source?.operation ?? '')
}

const SESSION_SCOPE = /^(approve_session|allow_always|allow-always|always)/u
/** R6：高风险不显示“本会话内允许 / 总是允许”。后端（dual）本来就不下发，这里再兜一层。 */
export function visibleOptions(ask: Pick<Ask, 'id' | 'title' | 'source' | 'options'>): AskOption[] {
  const options = ask.options ?? []
  return isHighRisk(ask) ? options.filter(o => !SESSION_SCOPE.test(o.id)) : options
}

export function isApproveOption(id: string): boolean { return /^(approve|allow)/u.test(id) && !SESSION_SCOPE.test(id) }

/** 按 id 去重合并；先出现的来源优先（统一列表里已有的不会被重复显示）。 */
export function mergeAsks(lists: ReadonlyArray<readonly Ask[]>): Ask[] {
  const seen = new Map<string, Ask>()
  for (const list of lists) for (const ask of list) if (ask && typeof ask.id === 'string' && !seen.has(ask.id)) seen.set(ask.id, ask)
  return [...seen.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

export interface LoadResult { asks: Ask[]; errors: string[] }
export async function loadAllAsks(fetchList: (path: string) => Promise<{ asks?: Ask[] }>): Promise<LoadResult> {
  const errors: string[] = []
  const results = await Promise.all(ASK_SOURCES.map(async source => {
    try { return (await fetchList(source.list)).asks ?? [] } catch (reason) {
      const status = (reason as { status?: number }).status
      if (source.id === 'unified' || (status !== 404 && status !== 501 && status !== 503)) errors.push(`${source.label}：${reason instanceof Error ? reason.message : String(reason)}`)
      return []
    }
  }))
  return { asks: mergeAsks(results), errors }
}
