#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { tsImport } from '../dsh-plugins/agent-teams/node_modules/tsx/dist/esm/api/index.mjs'

const help = `Usage: node platform/tools/migrate-agent-teams.mjs --inventory
       node platform/tools/migrate-agent-teams.mjs --mapping /absolute/mapping.json [--apply --writers-stopped]
PostgreSQL DSN comes from LUMO_TEAM_MIGRATION_DSN. Default is preview only.
Inventory emits identity and sourceHash; mapping must explicitly provide id, realm,
ownerUserId, captainSessionId, sourceHash. Stop old writers and drain pending work
before apply. Back up the database first. Never pass a DSN on the command line.`

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) { console.log(help); return }
  const allowed = new Set(['--inventory', '--mapping', '--apply', '--writers-stopped'])
  const flags = new Map()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (!allowed.has(flag) || flags.has(flag)) throw new Error('invalid arguments; use --help')
    if (flag === '--mapping') {
      const path = args[++i]
      if (!path || path.startsWith('--')) throw new Error('--mapping requires a file')
      flags.set(flag, path)
    } else flags.set(flag, true)
  }
  if (flags.has('--inventory') === flags.has('--mapping') || (flags.has('--inventory') && flags.has('--apply'))) throw new Error('select --inventory or --mapping; inventory cannot apply')
  if (flags.has('--apply') && !flags.has('--writers-stopped')) throw new Error('--apply requires --writers-stopped')
  const dsn = process.env.LUMO_TEAM_MIGRATION_DSN
  if (!dsn) throw new Error('LUMO_TEAM_MIGRATION_DSN is required')
  const { PgStorageBackend } = await tsImport('../dsh-plugins/storage/src/index.ts', import.meta.url)
  const { legacyTeamInventory, migrateLegacyTeams, parseLegacyMappings } = await tsImport('../dsh-plugins/agent-teams/src/migration.ts', import.meta.url)
  const mapping = flags.has('--mapping') ? parseLegacyMappings(JSON.parse(await readFile(flags.get('--mapping'), 'utf8'))) : undefined
  const backend = new PgStorageBackend(dsn)
  try {
    const unit = await backend.kv.open({ name: 'lumo_agent_teams', version: 1, tables: ['teams'], hasGlobal: false, layout: 'per-record' })
    const result = mapping === undefined ? { teams: await legacyTeamInventory(unit) }
      : await migrateLegacyTeams(unit, mapping, { apply: flags.has('--apply'), writersStopped: flags.has('--writers-stopped') })
    console.log(JSON.stringify(result, null, 2))
  } finally { await backend.close() }
}

main().catch(error => {
  // Never include connection details or a driver stack in console output.
  console.error(error?.name === 'Error' && !['ECONNREFUSED', 'ENOTFOUND'].includes(error.code)
    && !String(error.message).includes(process.env.LUMO_TEAM_MIGRATION_DSN ?? '\0')
    ? error.message : 'Team migration failed; check configuration, database availability and mapping.')
  process.exitCode = 1
})
