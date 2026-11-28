import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { RoleRoomStore } from '../src/role-room-store.ts'
import { planRoomTurn, type RoleRoom } from '../src/role-room-model.ts'
import { SqliteConversationStore } from '../src/sqlite-conversation-store.ts'
import type { SessionSummary } from '../src/engine-host.ts'
import type { StoredEvent } from '../src/conversation-store.ts'

const scope = { realm: 'benchmark', userId: 'benchmark', projectId: 'benchmark' }
const time = (operation: () => unknown, samples = 7) => {
  operation()
  const results = Array.from({ length: samples }, () => { const start = performance.now(); operation(); return performance.now() - start }).sort((a, b) => a - b)
  return { p50Ms: +results[Math.floor(results.length / 2)]!.toFixed(2), p95Ms: +results[Math.ceil(results.length * 0.95) - 1]!.toFixed(2) }
}

/** Opt-in reproducible storage benchmark; UI responsiveness and network delay require browser measurements. */
it.skipIf(process.env.LUMO_RUN_SCALE_REVIEW !== '1')('measures fixed large-topic summaries, full bodies, paging and search', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-scale-review-')), file = join(dir, 'rooms.json'), store = new RoleRoomStore(file)
  const journal = new SqliteConversationStore(join(dir, 'history.sqlite')), now = '2026-11-28T00:00:00.000Z'
  try {
    const rooms: RoleRoom[] = Array.from({ length: 200 }, (_, index) => {
      const room: RoleRoom = { ...scope, id: `topic-${index}`, name: `Topic ${index}`, cwd: dir, coordinatorId: 'helper', createdAt: now, updatedAt: now, revision: 1, archived: index >= 2,
        roles: ['helper', 'engineer', 'reviewer'].map(id => ({ id, name: id, engineId: 'test', instruction: `Perform ${id} work` })), turns: [] }
      room.turns = Array.from({ length: 24 }, (_, turn) => {
        const input = { id: `turn-${turn}`, text: `Review task ${turn}`, mode: 'relay' as const }
        return { ...input, createdAt: now, state: 'completed', steps: planRoomTurn(room, input).map(step => ({ ...step, state: 'completed', text: `${'Evidence '.repeat(220)}${index === 199 && turn === 23 ? ' NEEDLE-0199' : ''}` })) }
      })
      return room
    })
    store.putMany(rooms)
    const roomBytes = Buffer.byteLength(JSON.stringify(rooms)), last = rooms[0]!
    const samples = {
      roomSummaryIndex: time(() => store.summaries(scope, { includeArchived: true }), 25),
      roomFullBodies: time(() => store.list()),
      roomFullTextSearch: time(() => store.summaries(scope, { includeArchived: true, q: 'NEEDLE-0199' })),
    }
    const ids: string[] = []
    for (let index = 0; index < 200; index++) {
      const id = randomUUID(); ids.push(id)
      const session: SessionSummary = { ...scope, id, engineId: 'test', engineSessionId: `engine-${index}`, cwd: dir, state: 'closed', createdAt: now }
      const events: StoredEvent[] = Array.from({ length: 1200 }, (_, n) => ({ seq: n + 1, event: { type: 'message.chunk', role: n % 3 === 0 ? 'user' : 'agent', sessionId: id,
        text: `${'saved output '.repeat(16)}${index === 199 && n === 1199 ? ' NEEDLE-0199' : ''}`, at: now } }))
      journal.append(session, events)
    }
    const historyPage = time(() => journal.page(ids[199]!, undefined, 200), 25), historySearch = time(() => journal.list(scope, 'NEEDLE-0199'))
    expect(store.summaries(scope, { includeArchived: true, q: 'NEEDLE-0199' })).toHaveLength(1)
    expect(journal.list(scope, 'NEEDLE-0199')).toHaveLength(1)
    expect(journal.page(ids[199]!, undefined, 200)?.events).toHaveLength(200)
    const report = { environment: { node: process.version, platform: process.platform, arch: process.arch },
      fixture: { rooms: 200, turnsPerRoom: 24, roles: 3, roomBytes, conversations: 200, eventsPerConversation: 1200, totalEvents: 240000 },
      measurements: { ...samples, historyPage200: historyPage, historyFullTextSearch: historySearch },
      payload: { fullRoomBytes: Buffer.byteLength(JSON.stringify(last)), currentTurnBytes: Buffer.byteLength(JSON.stringify(last.turns.at(-1))) },
      budgetsMs: { roomSummaryP95: 16, historyPageP95: 20, historySearchP95: 250, roomSearchP95: 250 },
      observedBudgetPass: { summaries: samples.roomSummaryIndex.p95Ms <= 16, historyPage: historyPage.p95Ms <= 20, historySearch: historySearch.p95Ms <= 250, roomSearch: samples.roomFullTextSearch.p95Ms <= 250 },
      processMemory: process.memoryUsage() }
    process.stdout.write(`LUMO_SCALE_REVIEW ${JSON.stringify(report)}\n`)
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }) }
}, 120000)
