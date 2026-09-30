#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { readFile, writeFile, unlink } from 'node:fs/promises'

const pidFile = '/tmp/lumo-cluster-bundle-pids.json'
const clusterId = process.env.LUMO_BUNDLE_CLUSTER_ID
if (!['cluster-a', 'cluster-b'].includes(clusterId ?? '')) {
  console.error('cluster-bundle: LUMO_BUNDLE_CLUSTER_ID must be cluster-a or cluster-b')
  process.exit(64)
}

const suffix = clusterId.endsWith('-a') ? 'A' : 'B'
const nodeId = `${clusterId}-dsh-1`
const agentId = `${clusterId}-dsh-0`
const token = required('LUMO_CONTROL_PLANE_TOKEN')
const subagentToken = process.env.LUMO_SUBAGENT_HOST_TOKEN || 'dev-subagent-token'
const children = new Map()
let stopping = false

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function commonDshEnv() {
  return {
    ...process.env,
    LUMO_DEPLOYMENT_MODE: 'cluster',
    LUMO_CONTROL_PLANE_TOKEN: token,
    LUMO_CLUSTER_ID: clusterId,
    LUMO_CLUSTER_STATUS: 'ready',
    LUMO_CLUSTER_VERSION: process.env[`LUMO_CLUSTER_${suffix}_VERSION`] || 'dev',
    LUMO_REALM: process.env.LUMO_REALM || 'dev',
    LUMO_PG_DSN: process.env.LUMO_PG_DSN || 'postgres://lumo:lumo@postgres:5432/lumo',
    LUMO_REDIS_URL: process.env.LUMO_REDIS_URL || 'redis://redis:6379',
    LUMO_MINIO_ENDPOINT: process.env.LUMO_MINIO_ENDPOINT || 'minio',
    LUMO_MINIO_PORT: process.env.LUMO_MINIO_PORT || '9000',
    LUMO_MINIO_ACCESS_KEY: process.env.LUMO_MINIO_ACCESS_KEY || 'lumo',
    LUMO_MINIO_SECRET_KEY: process.env.LUMO_MINIO_SECRET_KEY || 'lumo-minio-123',
    LUMO_MINIO_BUCKET: process.env.LUMO_MINIO_BUCKET || 'lumo-objects',
    LUMO_CONNECTOR_GATEWAY_URL: process.env.LUMO_CONNECTOR_GATEWAY_URL || 'http://connector-gateway:8082',
    LUMO_SESSION_CONTROL_URL: process.env.LUMO_SESSION_CONTROL_URL || 'http://session-control:8092',
    // Keep the original DSH reporting target. The per-cluster Scheduler runs
    // beside these processes for local placement, while node health is still
    // reported to the global scheduler exactly as in the full topology.
    LUMO_SCHEDULER_URL: process.env.LUMO_SCHEDULER_URL || 'http://scheduler-0:8083',
    LUMO_NACOS_ADDR: process.env.LUMO_NACOS_ADDR || 'http://nacos:8848',
    LUMO_NACOS_SERVICE: process.env.LUMO_NACOS_SERVICE || 'lumo-dsh-node',
    LUMO_NACOS_GROUP: process.env.LUMO_NACOS_GROUP || 'DEFAULT_GROUP',
    PROVISIONER_ARTIFACT_NAME: process.env.PROVISIONER_ARTIFACT_NAME || '',
  }
}

function start(name, command, args, env) {
  const child = spawn(command, args, { cwd: '/workspace/platform', env, stdio: 'inherit' })
  children.set(name, child)
  child.once('error', error => {
    console.error(`cluster-bundle: ${name} failed to start: ${error.message}`)
    void stop(1)
  })
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`cluster-bundle: ${name} exited (code=${code ?? 'none'}, signal=${signal ?? 'none'})`)
      void stop(code && code !== 0 ? code : 1)
    }
  })
  return child
}

function checkTcp(port, timeoutMs = 700) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = ok => { socket.destroy(); resolve(ok) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function checkHttp(url, timeoutMs = 1200) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

function childAlive(child) {
  return child.exitCode === null && child.signalCode === null
}

async function waitFor(name, predicate, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stopping) throw new Error(`bundle is stopping while waiting for ${name}`)
    for (const [childName, child] of children) {
      if (!childAlive(child)) throw new Error(`${childName} exited while waiting for ${name}`)
    }
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`timed out waiting for ${name}`)
}

function schedulerEnv() {
  return {
    ...process.env,
    LUMO_INSTANCE: `scheduler-${clusterId}`,
    LUMO_LISTEN: ':8083',
    LUMO_CLUSTER_ENFORCE: 'true',
    LUMO_SCHEDULER_CLUSTER_ID: clusterId,
    LUMO_CLUSTER_VERSION_GATE: process.env.LUMO_CLUSTER_VERSION_GATE || 'false',
    LUMO_CLUSTER_VERSION: process.env[`LUMO_CLUSTER_${suffix}_VERSION`] || 'dev',
    LUMO_PLACEMENT_LOAD_WEIGHT: process.env.LUMO_PLACEMENT_LOAD_WEIGHT || '1',
    LUMO_PLACEMENT_AFFINITY_WEIGHT: process.env.LUMO_PLACEMENT_AFFINITY_WEIGHT || '0.25',
    LUMO_PG_DSN: process.env.LUMO_PG_DSN || 'postgres://lumo:lumo@postgres:5432/lumo',
    LUMO_CONTROL_PLANE_TOKEN: token,
    LUMO_NACOS_ADDR: process.env.LUMO_NACOS_ADDR || 'http://nacos:8848',
    LUMO_GOVERNANCE_URL: process.env.LUMO_GOVERNANCE_URL || 'http://governance:8089',
    LUMO_CORS_ORIGIN: process.env.LUMO_CORS_ORIGIN || 'http://127.0.0.1:4173',
  }
}

function nodeEnv() {
  return {
    ...commonDshEnv(),
    LUMO_NODE_ID: nodeId,
    LUMO_ROLE: 'node',
    LUMO_SEAM_MODE: 'host',
    LUMO_SEAM_BIND: '0.0.0.0',
    LUMO_SEAM_PORT: '8090',
    LUMO_SUBAGENT_HOST_BIND: '0.0.0.0',
    LUMO_SUBAGENT_HOST_PORT: '8091',
    LUMO_SUBAGENT_CALLBACK_PORT: '8092',
    LUMO_SUBAGENT_CALLBACK_ALLOWED_ORIGINS: `http://dsh-web:8092,http://${agentId}:8093`,
    LUMO_NODE_ADVERTISE_HOST: nodeId,
    LUMO_NODE_CAPACITY: process.env[`LUMO_CLUSTER_${suffix}_NODE_CAPACITY`] || '8',
    LUMO_NODE_CAPABILITIES: process.env[`LUMO_CLUSTER_${suffix}_NODE_CAPABILITIES`] || 'subagent',
    LUMO_NODE_RESIDENCY: suffix === 'A' ? 'cn-east' : 'cn-north',
    LUMO_USER_ID: process.env[`LUMO_CLUSTER_${suffix}_AGENT_OWNER`] || '',
    LUMO_PROJECT_ID: process.env[`LUMO_CLUSTER_${suffix}_AGENT_PROJECT`] || '',
    LUMO_AGENT_ID: process.env[`LUMO_CLUSTER_${suffix}_AGENT_ID`] || '',
    LUMO_AGENT_PRESET_REVISION: process.env[`LUMO_CLUSTER_${suffix}_AGENT_PRESET_REVISION`] || '',
    LUMO_AGENT_PROVIDER: process.env[`LUMO_CLUSTER_${suffix}_AGENT_PROVIDER`] || '',
    LUMO_AGENT_MODEL: process.env[`LUMO_CLUSTER_${suffix}_AGENT_MODEL`] || '',
    LUMO_AGENT_SYSTEM_PROMPT_REF: process.env[`LUMO_CLUSTER_${suffix}_AGENT_SYSTEM_PROMPT_REF`] || '',
    LUMO_AGENT_SYSTEM_PROMPT_FILE: process.env[`LUMO_CLUSTER_${suffix}_AGENT_SYSTEM_PROMPT_FILE`] || '',
  }
}

function agentEnv() {
  return {
    ...commonDshEnv(),
    LUMO_NODE_ID: agentId,
    LUMO_ROLE: 'agent',
    LUMO_SEAM_MODE: 'proxy',
    LUMO_SEAM_ENDPOINTS: 'http://127.0.0.1:8090',
    LUMO_SUBAGENT_HOST_TOKENS: JSON.stringify({ [nodeId]: subagentToken }),
    LUMO_SUBAGENT_HOST_TOKEN: subagentToken,
    LUMO_SUBAGENT_CALLBACK_BIND_HOST: '0.0.0.0',
    LUMO_SUBAGENT_CALLBACK_PORT: '8093',
    LUMO_SUBAGENT_CALLBACK_HOST: agentId,
    LUMO_SUBAGENT_NODE_URLS: JSON.stringify({ [nodeId]: 'http://127.0.0.1:8091' }),
  }
}

async function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode
  try { await unlink(pidFile) } catch { /* no pid file during startup */ }
  const active = [...children.values()].filter(childAlive)
  for (const child of active) child.kill('SIGTERM')
  const timer = setTimeout(() => {
    for (const child of active) if (childAlive(child)) child.kill('SIGKILL')
  }, 10_000)
  timer.unref()
}

async function healthcheck() {
  try {
    const entries = JSON.parse(await readFile(pidFile, 'utf8'))
    if (!Array.isArray(entries) || entries.length !== 3) return process.exit(1)
    if (!entries.every(pid => { try { process.kill(pid, 0); return true } catch { return false } })) return process.exit(1)
    if (!await checkHttp('http://127.0.0.1:8083/healthz')) return process.exit(1)
    for (const port of [8090, 8091, 8093]) if (!await checkTcp(port)) return process.exit(1)
  } catch {
    process.exit(1)
  }
}

// Register handlers before spawning children so `docker stop` during a slow
// startup still reaches every process in the bundle.
process.once('SIGTERM', () => { void stop(0) })
process.once('SIGINT', () => { void stop(0) })

if (process.argv[2] === 'healthcheck') {
  await healthcheck()
} else {
  try {
    const scheduler = start('scheduler', '/usr/local/bin/scheduler', [], schedulerEnv())
    await waitFor('scheduler health', () => checkHttp('http://127.0.0.1:8083/healthz'))
    const node = start('node', 'pnpm', ['--filter', '@lumo/dsh-node', 'start'], nodeEnv())
    await waitFor('node seam and host listeners', async () => (await checkHttp('http://127.0.0.1:8090/healthz')) && await checkTcp(8091))
    const agent = start('agent', 'pnpm', ['--filter', '@lumo/dsh-node', 'start'], agentEnv())
    await waitFor('agent callback listener', () => checkTcp(8093))
    await writeFile(pidFile, JSON.stringify([scheduler.pid, node.pid, agent.pid]), { mode: 0o600 })
    console.info(`cluster-bundle: ${clusterId} scheduler, node and agent are ready`)
  } catch (error) {
    console.error(`cluster-bundle: ${error instanceof Error ? error.message : String(error)}`)
    await stop(1)
  }
}
