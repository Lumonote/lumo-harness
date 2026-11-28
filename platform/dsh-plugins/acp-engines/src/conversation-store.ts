import type { SessionEvent, SessionSummary } from './engine-host.ts'
import type { SessionScope } from './session-scope.ts'

export interface StoredEvent { seq: number; event: SessionEvent }
export interface BranchReceipt { id: string; digest: string }
export interface PromptReceipt { clientMessageId: string; digest: string; status: 'accepted' | 'completed' | 'interrupted'; at: string; error?: string }
export interface HistoryPage { events: StoredEvent[]; hasMore: boolean; before?: number; seq: number; session: SessionSummary }
/** Storage seam; host lifecycle only depends on this contract. */
export interface ConversationStore {
  list(scope?: SessionScope, query?: string): SessionSummary[]
  get(id: string): SessionSummary | undefined
  put(summary: SessionSummary): void
  append(summary: SessionSummary, events: StoredEvent[], receipt?: PromptReceipt): void
  page(id: string, before?: number, limit?: number): HistoryPage | undefined
  sequence(id: string): number
  receipt(id: string, clientMessageId: string): PromptReceipt | undefined
  finish(id: string, clientMessageId: string, status: PromptReceipt['status'], error?: string): void
  branch(id: string, requestId: string): BranchReceipt | undefined
  saveBranch(id: string, requestId: string, receipt: BranchReceipt): void
  remove(id: string): void
  close(): void
}
