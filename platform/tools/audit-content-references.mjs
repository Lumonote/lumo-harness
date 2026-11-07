#!/usr/bin/env node
import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { auditContentReferences, validateRealm } from './content-reference-audit.mjs'

const help = `Usage: node platform/tools/audit-content-references.mjs --realm REALM [--inventory /path/objects.jsonl | --minio]
       [--page-size 500] [--max-rows 100000] [--max-objects 100000]
Read-only JSON report; no objects or database rows are modified. Zero known
references always means protected, never eligible for deletion.

DSNs come from LUMO_CONTENT_AUDIT_PG_DSN, with optional per-database overrides:
LUMO_CONTENT_AUDIT_KNOWLEDGE_DSN, LUMO_CONTENT_AUDIT_GOVERNANCE_DSN,
LUMO_CONTENT_AUDIT_SESSION_LOG_DSN. Never pass credentials on the command line.
--minio uses explicit LUMO_MINIO_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET plus
optional LUMO_MINIO_PORT/SSL/REGION. It lists keys only, without GET or DELETE.
--inventory reads JSONL strings or {"key":"realm/content/<sha256>","size":123}.
Missing sources, truncated scans and unscanned history are recorded as gaps.
Exit 2 means a configured source failed; a partial report is still printed.`

function argumentsFor(args) {
  const options = { pageSize: 500, maxRows: 100_000, maxObjects: 100_000 }
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (seen.has(flag)) throw new Error('duplicate flag; use --help')
    seen.add(flag)
    if (flag === '--minio') { options.minio = true; continue }
    const names = { '--realm': 'realm', '--inventory': 'inventoryFile', '--page-size': 'pageSize', '--max-rows': 'maxRows', '--max-objects': 'maxObjects' }
    const name = names[flag]
    const value = args[++index]
    if (name === undefined || value === undefined || value.startsWith('--')) throw new Error('invalid arguments; use --help')
    if (['pageSize', 'maxRows', 'maxObjects'].includes(name)) {
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > (name === 'pageSize' ? 1000 : 1_000_000)) throw new Error(`invalid ${flag}`)
      options[name] = Number(value)
    } else options[name] = value
  }
  validateRealm(options.realm)
  if (options.minio && options.inventoryFile !== undefined) throw new Error('choose --minio or --inventory')
  return options
}

async function* fileInventory(path) {
  const input = createReadStream(path, { encoding: 'utf8' })
  const parseLine = line => {
    if (line.length > 16 * 1024) throw new Error('invalid inventory')
    const value = JSON.parse(line)
    if (typeof value !== 'string' && (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.key !== 'string')) throw new Error('invalid inventory')
    return value
  }
  let pending = ''
  try {
    for await (const chunk of input) {
      pending += chunk
      let newline
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.trim() !== '') yield parseLine(line)
      }
      if (pending.length > 16 * 1024) throw new Error('invalid inventory')
    }
    if (pending.trim() !== '') yield parseLine(pending)
  } finally { input.destroy() }
}

function minioInventory(env, realm) {
  for (const key of ['LUMO_MINIO_ENDPOINT', 'LUMO_MINIO_ACCESS_KEY', 'LUMO_MINIO_SECRET_KEY', 'LUMO_MINIO_BUCKET']) if (!env[key]) throw new Error(`${key} is required for --minio`)
  if (env.LUMO_MINIO_SSL !== undefined && !['true', 'false', '1', '0'].includes(env.LUMO_MINIO_SSL)) throw new Error('LUMO_MINIO_SSL must be true/false/1/0')
  const port = env.LUMO_MINIO_PORT === undefined ? undefined : Number(env.LUMO_MINIO_PORT)
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('invalid LUMO_MINIO_PORT')
  const require = createRequire(new URL('../dsh-plugins/object-store/package.json', import.meta.url))
  const { Client } = require('minio')
  const client = new Client({ endPoint: env.LUMO_MINIO_ENDPOINT, port, useSSL: ['true', '1'].includes(env.LUMO_MINIO_SSL),
    accessKey: env.LUMO_MINIO_ACCESS_KEY, secretKey: env.LUMO_MINIO_SECRET_KEY, region: env.LUMO_MINIO_REGION })
  return (async function* () {
    const stream = client.listObjectsV2(env.LUMO_MINIO_BUCKET, `${realm}/content/`, true)
    const timer = setTimeout(() => stream.destroy(Object.assign(new Error('inventory timeout'), { code: 'ETIMEDOUT' })), 30_000)
    timer.unref()
    try { for await (const item of stream) {
      timer.refresh()
      if (typeof item.name === 'string') yield { key: item.name, size: item.size }
    } } finally { clearTimeout(timer); stream.destroy() }
  })()
}

export async function runContentAudit(args, env = process.env) {
  const options = argumentsFor(args)
  const dsns = {
    knowledge: env.LUMO_CONTENT_AUDIT_KNOWLEDGE_DSN || env.LUMO_CONTENT_AUDIT_PG_DSN,
    governance: env.LUMO_CONTENT_AUDIT_GOVERNANCE_DSN || env.LUMO_CONTENT_AUDIT_PG_DSN,
    sessionLog: env.LUMO_CONTENT_AUDIT_SESSION_LOG_DSN || env.LUMO_CONTENT_AUDIT_PG_DSN,
  }
  if (!Object.values(dsns).some(Boolean) && options.inventoryFile === undefined && !options.minio) throw new Error('configure an audit DSN, --inventory or --minio')
  const connections = []
  const clients = {}
  try {
    for (const [name, dsn] of Object.entries(dsns)) {
      if (!dsn) continue
      // Defer loading pg so an offline inventory requires no database package.
      const require = createRequire(new URL('../dsh-plugins/knowledge/package.json', import.meta.url))
      const { Client } = require('pg')
      const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 5000, query_timeout: 15_000, statement_timeout: 10_000,
        // Preserve connection-string options such as an explicit search_path.
        // Every scan starts its own READ ONLY transaction before issuing SELECT.
        application_name: 'lumo-content-reference-audit' })
      client.on('error', () => {}) // query failures are reported as coverage gaps
      // A failed connection is still passed to the scanner to produce a gap.
      let failure
      try { await client.connect() } catch (error) { failure = error }
      connections.push(client)
      clients[name] = failure === undefined ? client : { query: async () => { throw failure } }
    }
    const inventory = options.inventoryFile !== undefined ? fileInventory(options.inventoryFile) : options.minio ? minioInventory(env, options.realm) : undefined
    return await auditContentReferences({ realm: options.realm, clients, inventory,
      inventorySource: options.inventoryFile !== undefined ? 'jsonl' : options.minio ? 'minio' : 'not_configured',
      pageSize: options.pageSize, maxRows: options.maxRows, maxObjects: options.maxObjects })
  } finally { await Promise.allSettled(connections.map(client => client.end())) }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.slice(2).includes('--help')) console.log(help)
  else runContentAudit(process.argv.slice(2)).then(report => {
    console.log(JSON.stringify(report, null, 2))
    if ([...Object.values(report.sources), report.inventory].some(source => source.status === 'failed')) process.exitCode = 2
  }).catch(() => {
    // Never print driver errors, environment values, SQL or arbitrary arguments.
    console.error('Content reference audit failed; check --help, configuration and read-only access.')
    process.exitCode = 1
  })
}
