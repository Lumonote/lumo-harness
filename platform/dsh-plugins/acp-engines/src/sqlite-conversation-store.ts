import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConversationStore, BranchReceipt, HistoryPage, PromptReceipt, StoredEvent } from './conversation-store.ts'
import type { SessionSummary } from './engine-host.ts'
import type { SessionScope } from './session-scope.ts'

/** Local durable adapter. WAL transaction accepts the user message and receipt together. */
export class SqliteConversationStore implements ConversationStore {
  private readonly db: DatabaseSync
  constructor(path?: string) {
    if (path) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path ?? ':memory:')
    if (path) chmodSync(path, 0o600)
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, realm TEXT NOT NULL, user_id TEXT NOT NULL, project_id TEXT NOT NULL, metadata TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS conversation_scope ON conversations(realm,user_id,project_id);
      CREATE TABLE IF NOT EXISTS conversation_events (session_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, seq INTEGER NOT NULL, body TEXT NOT NULL, visible_text TEXT NOT NULL, PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS conversation_branches (parent_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, request_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(parent_id,request_id));
      CREATE TABLE IF NOT EXISTS prompt_receipts (session_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, client_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id,client_id));`)
  }
  list(scope?: SessionScope, query = ''): SessionSummary[] {
    const filter = scope ? 'WHERE c.realm=? AND c.user_id=? AND c.project_id=?' : 'WHERE 1=1'
    const values = scope ? [scope.realm, scope.userId, scope.projectId ?? ''] : []
    const search = query.trim().slice(0, 500)
    if (search) values.push(search, search)
    const textFilter = search ? "AND (instr(lower(c.metadata),lower(?))>0 OR instr(lower((SELECT group_concat(visible_text,'') FROM (SELECT visible_text FROM conversation_events e WHERE e.session_id=c.id ORDER BY e.seq))),lower(?))>0)" : ''
    const rows = this.db.prepare(`SELECT c.metadata FROM conversations c ${filter} ${textFilter}`).all(...values)
    return rows.map(row => JSON.parse(row.metadata as string) as SessionSummary)
  }
  get(id: string): SessionSummary | undefined { const row = this.db.prepare('SELECT metadata FROM conversations WHERE id=?').get(id); return row ? JSON.parse(row.metadata as string) as SessionSummary : undefined }
  put(summary: SessionSummary): void {
    // Exact public projection: no spawn env, MCP credentials or expanded prompt.
    const { id, realm, userId, projectId, engineId, engineSessionId, cwd, title, modelId, models, modes, commands, state, createdAt, updatedAt, capabilities, archived, pinned, historyIncomplete, storageError, handoff } = summary
    const metadata = { id, realm, userId, projectId, engineId, engineSessionId, cwd, title, modelId, models, modes, commands, state, createdAt, updatedAt, capabilities, archived, pinned, historyIncomplete, storageError, handoff }
    this.db.prepare('INSERT INTO conversations(id,realm,user_id,project_id,metadata) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata').run(id, realm, userId, projectId ?? '', JSON.stringify(metadata))
  }
  append(summary: SessionSummary, events: StoredEvent[], receipt?: PromptReceipt): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.put(summary)
      const insert = this.db.prepare('INSERT INTO conversation_events(session_id,seq,body,visible_text) VALUES(?,?,?,?)')
      for (const { seq, event } of events) insert.run(summary.id, seq, JSON.stringify(event), event.type === 'message.chunk' ? event.text : '')
      if (events.length) this.db.prepare('UPDATE conversations SET seq=? WHERE id=?').run(events[events.length - 1]!.seq, summary.id)
      if (events.some(e => e.event.type === 'turn.ended')) {
        const interrupted = events.some(e => e.event.type === 'turn.ended' && e.event.stopReason === 'error')
        this.db.prepare("UPDATE prompt_receipts SET body=json_set(body,'$.status',?) WHERE session_id=? AND json_extract(body,'$.status')='accepted'").run(interrupted ? 'interrupted' : 'completed', summary.id)
      }
      if (receipt) this.db.prepare('INSERT INTO prompt_receipts(session_id,client_id,body) VALUES(?,?,?)').run(summary.id, receipt.clientMessageId, JSON.stringify(receipt))
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  page(id: string, before = Number.MAX_SAFE_INTEGER, limit = 200): HistoryPage | undefined {
    const session = this.get(id)
    if (!session) return undefined
    const cap = Math.min(1000, Math.max(1, Math.floor(limit)))
    const rows = this.db.prepare('SELECT seq,body FROM conversation_events WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id, before, cap + 1)
    const hasMore = rows.length > cap
    const events = rows.slice(0, cap).reverse().map(row => ({ seq: row.seq as number, event: JSON.parse(row.body as string) as StoredEvent['event'] }))
    return { session, events, hasMore, ...(events[0] ? { before: events[0].seq } : {}), seq: this.sequence(id) }
  }
  sequence(id: string): number { return Number(this.db.prepare('SELECT seq FROM conversations WHERE id=?').get(id)?.seq ?? 0) }
  receipt(id: string, clientMessageId: string): PromptReceipt | undefined { const row = this.db.prepare('SELECT body FROM prompt_receipts WHERE session_id=? AND client_id=?').get(id, clientMessageId); return row ? JSON.parse(row.body as string) as PromptReceipt : undefined }
  finish(id: string, clientMessageId: string, status: PromptReceipt['status'], error?: string): void {
    const receipt = this.receipt(id, clientMessageId)
    if (receipt) this.db.prepare('UPDATE prompt_receipts SET body=? WHERE session_id=? AND client_id=?').run(JSON.stringify({ ...receipt, status, ...(error ? { error } : {}) }), id, clientMessageId)
  }
  branch(id: string, requestId: string): BranchReceipt | undefined { const row = this.db.prepare('SELECT body FROM conversation_branches WHERE parent_id=? AND request_id=?').get(id, requestId); return row ? JSON.parse(row.body as string) as BranchReceipt : undefined }
  saveBranch(id: string, requestId: string, receipt: BranchReceipt): void { this.db.prepare('INSERT INTO conversation_branches(parent_id,request_id,body) VALUES(?,?,?)').run(id, requestId, JSON.stringify(receipt)) }
  remove(id: string): void { this.db.prepare('DELETE FROM conversations WHERE id=?').run(id) }
  close(): void { this.db.close() }
}
