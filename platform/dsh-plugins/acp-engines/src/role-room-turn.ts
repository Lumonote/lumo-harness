import type { PromptContext } from './prompt-context.ts'
import type { ContentBlock } from './acp-protocol.ts'
import type { ChatAttachment } from './chat-attachments.ts'
import type { EngineHost } from './engine-host.ts'
import type { SessionScope } from './session-scope.ts'
import { ROOM_LIMITS } from './role-room-model.ts'

export type RoomEngine = Pick<EngineHost, 'get' | 'list' | 'probeStatic' | 'createSession' | 'resume' | 'prompt' | 'subscribe' | 'cancel' | 'close' | 'setModel'>
  & Partial<Pick<EngineHost, 'ensureCapacity' | 'release' | 'delete' | 'reserveWorkspace' | 'workspaceBusy'>>

/** Subscribe before dispatch, ignore replay, and stop the sequence on every non-success outcome. */
export const runRoleTurn = (host: RoomEngine, id: string, scope: SessionScope, prompt: string | ContentBlock[], signal: AbortSignal,
  progress: (text: string, truncated: boolean) => void, timeoutMs = 30 * 60_000, display?: { text: string; attachments: ChatAttachment[] } & PromptContext, workspaceOwner?: string): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('协作已停止')); return }
  if (host.get(id, scope)?.state !== 'idle') { reject(new Error('角色会话未就绪，请恢复会话或等待当前执行结束')); return }
  let armed = false, done = false, text = '', truncated = false
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (error?: Error) => {
    if (done) return
    done = true; unsubscribe?.(); clearTimeout(timer); signal.removeEventListener('abort', abort)
    if (error) reject(error); else resolve()
  }
  const abort = () => {
    try { host.cancel(id, scope) } catch { /* Still finish the coordinator when the process is gone. */ }
    finish(new Error('协作已停止；请核对引擎已执行的操作'))
  }
  unsubscribe = host.subscribe(id, scope, 0, (_seq, event) => {
    if (!armed || done) return
    if (event.type === 'message.chunk' && event.role === 'agent') {
      truncated ||= text.length + event.text.length > ROOM_LIMITS.output
      text = (text + event.text).slice(0, ROOM_LIMITS.output); progress(text, truncated)
    } else if (event.type === 'turn.ended') {
      finish(event.stopReason === 'end_turn' ? undefined : new Error(event.error ?? `引擎回合结束：${event.stopReason}`))
    } else if (event.type === 'session.closed') finish(new Error('角色引擎会话已关闭'))
  })
  if (!unsubscribe) { finish(new Error('角色会话不可连接')); return }
  signal.addEventListener('abort', abort, { once: true })
  timer = setTimeout(() => { try { host.cancel(id, scope) } catch { /* Process may already be gone. */ } finish(new Error('角色执行超时，已请求停止；请核对实际结果')) }, timeoutMs)
  timer.unref?.()
  armed = true
  try { const result = host.prompt(id, scope, prompt, display, workspaceOwner ? { workspaceOwner } : undefined); if (!result.ok) finish(new Error(result.error)) }
  catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
})
