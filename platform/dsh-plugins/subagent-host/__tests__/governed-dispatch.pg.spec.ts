import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecutionConflictError, PgGovernedDispatch } from '../src/governed-dispatch.ts'
import { config, execution, resultFor } from './governed-fixtures.ts'

const dsn = process.env['LUMO_TEST_PG_DSN']
describe.skipIf(!dsn)('governed dispatch PostgreSQL transactions', () => {
  const schema = 'lumo_governed_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString: dsn })
  const pool = new pg.Pool({ connectionString: dsn, options: '-c search_path=' + schema, max: 8,
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 })
  const store = new PgGovernedDispatch(pool, config, 'original')

  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema)
    // Use the authorities' real DDL so column/type changes break this suite.
    for (const module of ['governance', 'scheduler']) {
      const source = readFileSync(new URL('../../../control-plane/' + module + '/internal/store/store.go', import.meta.url), 'utf8')
      const ddl = source.match(/const DDL = \x60([\s\S]*?)\x60/)?.[1]
      if (!ddl) throw new Error('missing authority DDL: ' + module)
      await pool.query(ddl)
    }
    await store.init()
    await store.init()
  })
  afterEach(() => { vi.unstubAllGlobals() })
  afterAll(async () => {
    await pool.end()
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
    await admin.end()
  })
  beforeEach(async () => {
    await pool.query(`TRUNCATE lumo_governed_executions,scheduler_tasks,scheduler_task_attempts,
      scheduler_dispatch_outbox,scheduler_control_commands,governance_task_runs,
      governance_delegation_tasks,governance_worker_heartbeats,governance_agent_presets,governance_users CASCADE`)
    await pool.query(`INSERT INTO governance_users(realm,id,display_name) VALUES('realm','owner','Owner')`)
    await pool.query(`INSERT INTO governance_agent_presets(realm,id,project_id,name,owner_user_id,revision,
      provider,model_ref,max_concurrency,timeout_seconds,max_delegation_depth)
      VALUES('realm','writer','project','Writer','owner',7,'mock','mock',2,30,2)`)
    await pool.query(`INSERT INTO governance_worker_heartbeats
      (realm,worker_id,node_id,instance_id,preset_revision,max_concurrency,status)
      VALUES('realm','agent:writer','node-1','original',7,2,'active')`)
  })

  async function seed(id = 'run-1') {
    const item = execution(id)
    await pool.query(`INSERT INTO governance_delegation_tasks
      (id,realm,title,intent,project_id,requester_user_id,assignee_user_id,assignee_worker_id,
       state,business_state,scheduler_task_id,intent_contract)
      VALUES($1,'realm','Task','Deliver text','project','owner','owner','agent:writer','ASSIGNED','ASSIGNED',$2,$3)`,
    [item.task.id, id, JSON.stringify(item.task.intent_contract)])
    await pool.query(`INSERT INTO governance_task_runs(id,realm,task_id,attempt,worker_id,scheduler_task_id,state)
      VALUES($1,'realm',$2,1,'agent:writer',$1,'ASSIGNED')`, [id, item.task.id])
    await pool.query(`INSERT INTO scheduler_tasks(task_id,realm,cluster_id,requires,state,attempt,node_id,
      created_at,updated_at,worker_id,project_id)
      VALUES($1,'realm','cluster','[]','PLACED',1,'node-1',1,1,'agent:writer','project')`, [id])
    await pool.query(`INSERT INTO scheduler_task_attempts(task_id,attempt,realm,cluster_id,node_id,state,fencing_token,updated_at)
      VALUES($1,1,'realm','cluster','node-1','PLACED',1,1)`, [id])
    await pool.query(`INSERT INTO scheduler_dispatch_outbox(task_id,attempt,node_id,payload,created_at)
      VALUES($1,1,'node-1','{}',1)`, [id])
    return item
  }
  async function state(id = 'run-1') {
    return (await pool.query(`SELECT s.state AS scheduler,r.state AS run,t.state AS task,
      r.session_ref,o.delivered_at,e.result,e.delivery_token,e.last_error,e.delivery_attempts,
      e.delivered_at AS result_delivered_at
      FROM scheduler_tasks s JOIN governance_task_runs r ON r.id=s.task_id
      JOIN governance_delegation_tasks t ON t.id=r.task_id
      JOIN scheduler_dispatch_outbox o ON o.task_id=s.task_id AND o.attempt=s.attempt
      LEFT JOIN lumo_governed_executions e ON e.run_id=s.task_id WHERE s.task_id=$1`, [id])).rows[0]
  }

  it('admits once under concurrent consumption and commits both projections with a stable session', async () => {
    await seed()
    const claimed = (await Promise.all([store.take(), store.take(), store.take()])).filter(Boolean)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.sessionRef).toMatch(/^gov-[a-f0-9]{64}$/)
    expect(await state()).toMatchObject({ scheduler: 'RUNNING', run: 'RUNNING', task: 'RUNNING',
      session_ref: claimed[0]?.sessionRef })
    expect((await state()).delivered_at).not.toBeNull()
    expect(await store.take()).toBeUndefined()
    expect(await store.shouldStop(claimed[0]!)).toBe(false)
  })

  it('enforces replica capacity in the database under concurrent admission', async () => {
    await seed(); await seed('run-2')
    const single = new PgGovernedDispatch(pool, { ...config, capacity: 1 }, 'original')
    const claimed = (await Promise.all([single.take(), single.take()])).filter(Boolean)
    expect(claimed).toHaveLength(1)
    await single.save(claimed[0]!, resultFor(claimed[0]!))
    expect(await single.take()).toBeDefined()
  })

  it.each(['realm', 'project', 'instance', 'worker', 'revision'] as const)('does not admit a mismatched %s', async kind => {
    await seed()
    const changed = structuredClone(config)
    if (kind === 'realm') changed.realm = 'other'
    if (kind === 'project') changed.binding.projectId = 'other'
    if (kind === 'worker') changed.binding.agentId = 'other'
    if (kind === 'revision') changed.binding.presetRevision = 8
    const other = new PgGovernedDispatch(pool, changed, kind === 'instance' ? 'other' : 'original')
    expect(await other.take()).toBeUndefined()
    expect((await state()).scheduler).toBe('PLACED')
  })

  it('rolls back admission when the installed model does not match the preset', async () => {
    await seed()
    await pool.query("UPDATE governance_agent_presets SET model_ref='uninstalled'")
    await expect(store.take()).rejects.toThrow('installed execution identity')
    expect((await state()).scheduler).toBe('PLACED')
    expect((await pool.query('SELECT count(*)::int AS n FROM lumo_governed_executions')).rows[0].n).toBe(0)
  })

  it.each(['PLACED', 'CANCELLING'])('settles cancellation before admission from %s without resurrecting RUNNING', async status => {
    await seed()
    await pool.query('UPDATE scheduler_tasks SET state=$1', [status])
    await pool.query(`INSERT INTO scheduler_control_commands(task_id,command,attempt,node_id,status,requested_at,updated_at)
      VALUES('run-1','CANCEL',1,'node-1','REQUESTED',1,1)`)
    const item = (await store.take())!
    expect(item.cancelled).toBe(true)
    expect(await state()).toMatchObject({ scheduler: 'CANCELLING', run: 'CANCELLING', task: 'CANCELLING' })
    expect(await store.shouldStop(item)).toBe(true)
    await store.save(item, { ...resultFor(item), state: 'CANCELLED' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    await store.deliver()
    expect((await state()).scheduler).toBe('ABORTED')
  })

  it('requires fresh runtime ownership and stops execution after revocation', async () => {
    await seed()
    await pool.query("UPDATE governance_worker_heartbeats SET updated_at=now()-interval '31 seconds'")
    expect(await store.take()).toBeUndefined()
    await pool.query('UPDATE governance_worker_heartbeats SET updated_at=now()')
    const item = (await store.take())!
    await pool.query("UPDATE governance_users SET status='disabled'")
    expect(await store.shouldStop(item)).toBe(true)
  })

  it('recovers only a replaced instance and preserves already persisted results', async () => {
    await seed(); await seed('run-2')
    const lost = (await store.take())!
    const saved = (await store.take())!
    await store.save(saved, resultFor(saved))
    const replacement = new PgGovernedDispatch(pool, config, 'replacement')
    expect(await replacement.recover()).toBe(0)
    await pool.query("UPDATE governance_worker_heartbeats SET instance_id='replacement'")
    expect(await replacement.recover()).toBe(1)
    expect(await replacement.recover()).toBe(0)
    expect(await store.shouldStop(lost)).toBe(true)
    await expect(store.save(lost, resultFor(lost))).rejects.toBeInstanceOf(ExecutionConflictError)
    expect((await state(lost.runId)).result).toMatchObject({ state: 'FAILED', session_ref: lost.sessionRef })
    expect((await state(saved.runId)).result).toEqual(resultFor(saved))
    expect(await replacement.take()).toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    await replacement.deliver(); await replacement.deliver()
    expect((await state(lost.runId)).scheduler).toBe('FAILED')
    expect((await state(saved.runId)).scheduler).toBe('COMPLETED')
  })

  it('keeps immutable receipts through delivery failure and retries after restart', async () => {
    await seed()
    const item = (await store.take())!
    const result = resultFor(item)
    await store.save(item, result)
    await store.save(item, { ...result, output: { b: 2, a: 1 } })
    await expect(store.save(item, { ...result, summary: 'changed' })).rejects.toBeInstanceOf(ExecutionConflictError)
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual(result)
      expect(init.headers).toMatchObject({ authorization: 'Bearer service', 'x-lumo-realm': 'realm' })
      expect(init.redirect).toBe('error')
      return new Response('{}', { status: 503 })
    })
    vi.stubGlobal('fetch', fetch)
    await store.deliver()
    expect(await state()).toMatchObject({ scheduler: 'RUNNING', result_delivered_at: null, delivery_attempts: 1 })
    expect((await state()).last_error).toContain('503')
    await store.deliver()
    expect(fetch).toHaveBeenCalledTimes(1)
    await pool.query("UPDATE lumo_governed_executions SET next_delivery_at=now()-interval '1 second'")
    fetch.mockResolvedValue(new Response('{}'))
    await new PgGovernedDispatch(pool, config, 'restart').deliver()
    expect((await state()).scheduler).toBe('COMPLETED')
    expect((await state()).result_delivered_at).not.toBeNull()
  })

  it('fences a late delivery acknowledgment after another consumer reclaims it', async () => {
    await seed()
    const item = (await store.take())!
    await store.save(item, resultFor(item))
    let respond!: (value: Response) => void
    let started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve; started() })))
    const delivery = store.deliver()
    await began
    await pool.query("UPDATE lumo_governed_executions SET delivery_token='new-owner'")
    respond(new Response('{}'))
    await delivery
    expect(await state()).toMatchObject({ scheduler: 'RUNNING', delivery_token: 'new-owner', result_delivered_at: null })
  })

  it('never lets a stale receipt overwrite a newer Scheduler attempt', async () => {
    await seed()
    const item = (await store.take())!
    await store.save(item, resultFor(item))
    await pool.query('UPDATE scheduler_tasks SET attempt=2')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    await store.deliver()
    const row = (await pool.query('SELECT state,attempt FROM scheduler_tasks')).rows[0]
    expect(row).toEqual({ state: 'RUNNING', attempt: 2 })
    expect((await pool.query('SELECT delivered_at,last_error FROM lumo_governed_executions')).rows[0])
      .toMatchObject({ delivered_at: null, last_error: 'scheduler attempt changed before result settlement' })
  })
})
