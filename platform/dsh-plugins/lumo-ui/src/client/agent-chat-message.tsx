import { PromptContextChips } from './agent-composer-input.tsx'
import { MessageAttachments } from './chat-attachments.tsx'
import type { ChatAttachment } from '../../../acp-engines/src/chat-attachments.ts'
import { MarkdownText, UserMessageBubble, DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import { readDraft, writeDraft } from './conversation-drafts.ts'
import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

const labels = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '脚注' }
// The host owns typography and controls inside this boundary (copy, links, images, checkboxes).
export const AgentMarkdown = memo(({ text, streaming = false }: { text: string; streaming?: boolean }) => <div className="lumo-native-content lumo-agent-markdown"><MarkdownText text={text} streaming={streaming} labels={labels} textInteractionSource /></div>)
export const UserChatMessage = ({ text, attachments, skills, files }: { text: string; attachments?: ChatAttachment[] | undefined; skills?: string[] | undefined; files?: string[] | undefined }) => <div className="lumo-chat-user"><PromptContextChips value={{ ...(skills ? { skills } : {}), ...(files ? { files } : {}) }} /><MessageAttachments files={attachments} />{text ? <div className="lumo-native-content"><UserMessageBubble>{text}</UserMessageBubble></div> : null}</div>
export const AgentThought = ({ text }: { text: string }) => {
  const [open, setOpen] = useState(false)
  return <div className="lumo-native-content"><DisclosureRow icon={null} title="思考过程" open={open} expandable onToggle={() => setOpen(!open)}><AgentMarkdown text={text} /></DisclosureRow></div>
}
/** Keep readers in place when they scroll up; follow new output only near the end. */
export const useChatScroll = (revision: unknown, key = '') => {
  const ref = useRef<HTMLDivElement>(null), following = useRef(true), restored = useRef('')
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    if (restored.current !== key) {
      const saved = readDraft<{top: number; following: boolean} | null>(key, 'scroll', null)
      restored.current = key; following.current = saved?.following ?? true
      element.scrollTop = following.current ? element.scrollHeight : saved?.top ?? 0
    } else if (following.current) element.scrollTop = element.scrollHeight
  }, [revision, key])
  const onScroll = () => {
    const el = ref.current
    if (el) { following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (key) writeDraft(key, 'scroll', { top: el.scrollTop, following: following.current }) }
  }
  return { ref, onScroll }
}
export const shouldSend = (event: KeyboardEvent<HTMLTextAreaElement>) => event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229
