/** Human-visible ACP v1 projection. Never keep the MCP setup or expanded Skill prompt here. */
export interface SessionCommand { name: string; description: string; input?: { hint: string } }
export interface SessionModes { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string }> }
export interface ToolDetail { input?: string; output?: string; locations?: Array<{ path: string; line?: number }>; diffs?: Array<{ path: string; oldText?: string; newText: string }>; exitCode?: number }
export interface PlanEntry { content: string; status: string; priority?: string }
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const string = (value: unknown, max = 200_000): string | undefined => typeof value === 'string' ? value.slice(0, max) : undefined
function printable(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  try { return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 200_000) } catch { return undefined }
}
export function sessionCommands(value: unknown): SessionCommand[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 256).flatMap(item => {
    const v = record(item)
    if (!v || typeof v.name !== 'string' || !v.name || v.name.length > 100) return []
    const input = record(v.input)
    return [{ name: v.name, description: string(v.description, 2000) ?? '', ...(typeof input?.hint === 'string' ? { input: { hint: input.hint.slice(0, 2000) } } : {}) }]
  })
}
export function sessionModes(value: unknown): SessionModes | undefined {
  const modes = record(record(value)?.modes ?? value)
  if (!modes || typeof modes.currentModeId !== 'string' || !Array.isArray(modes.availableModes)) return undefined
  const availableModes = modes.availableModes.slice(0, 100).flatMap(item => {
    const m = record(item)
    return m && typeof m.id === 'string' && typeof m.name === 'string' ? [{ id: m.id, name: m.name, ...(typeof m.description === 'string' ? { description: m.description } : {}) }] : []
  })
  return { currentModeId: modes.currentModeId, availableModes }
}
export function toolDetail(update: Record<string, unknown>): ToolDetail {
  const result: ToolDetail = {}
  const input = printable(update.rawInput), output = printable(update.rawOutput)
  if (input !== undefined) result.input = input
  if (output !== undefined) result.output = output
  const texts: string[] = [], diffs: NonNullable<ToolDetail['diffs']> = []
  for (const item of Array.isArray(update.content) ? update.content.slice(0, 100) : []) {
    const c = record(item)
    if (c?.type === 'content') { const text = string(record(c.content)?.text); if (text !== undefined) texts.push(text) }
    if (c?.type === 'diff' && typeof c.path === 'string' && typeof c.newText === 'string') diffs.push({ path: c.path, newText: c.newText.slice(0, 200_000), ...(typeof c.oldText === 'string' ? { oldText: c.oldText.slice(0, 200_000) } : {}) })
  }
  if (texts.length) result.output = texts.join('\n').slice(0, 200_000)
  if (diffs.length) result.diffs = diffs
  if (Array.isArray(update.locations)) result.locations = update.locations.slice(0, 100).flatMap(item => { const loc = record(item); return loc && typeof loc.path === 'string' ? [{ path: loc.path, ...(Number.isSafeInteger(loc.line) ? { line: loc.line as number } : {}) }] : [] })
  const rawOutput = record(update.rawOutput)
  if (Number.isSafeInteger(rawOutput?.exitCode ?? rawOutput?.exit_code)) result.exitCode = (rawOutput?.exitCode ?? rawOutput?.exit_code) as number
  return result
}
export function planEntries(value: unknown): PlanEntry[] {
  return (Array.isArray(value) ? value : []).slice(0, 200).flatMap(item => { const p = record(item); return p && typeof p.content === 'string' ? [{ content: p.content.slice(0, 10_000), status: string(p.status, 100) ?? 'pending', ...(typeof p.priority === 'string' ? { priority: p.priority } : {}) }] : [] })
}
