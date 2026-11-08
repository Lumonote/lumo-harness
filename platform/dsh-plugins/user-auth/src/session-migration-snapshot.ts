/** Exact, bounded native Session + workspace checkpoint. No archive parser,
 * path relocation, symlink following, or SessionEvent reconstruction. */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { assertContiguous, assertVersion, materializeCreateHeader, validateStoredEvents, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

export const MIGRATION_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024
export const MIGRATION_FILE_MAX_BYTES = 2 * 1024 * 1024
const MAX_FILES = 256, MAX_CONTENT_BYTES = 8 * 1024 * 1024
export const snapshotHash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
interface WorkspaceEntry { path: string; kind: 'file' | 'directory'; mode: number; bytes?: number; sha256?: string; base64?: string }
export interface MigrationSnapshot {
  version: 1; realm: string; ownerUserID: string; projectID: string; sessionRef: string
  modelPolicySHA: string; header: SessionHeader; inheritedEventCount: number; events: SessionEvent[]; workspace: WorkspaceEntry[]
}
const invalid = () => new Error('Session migration snapshot failed bounded integrity validation')
const safePath = (value: string) => value.length <= 1024 && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[\\\x00-\x1f\x7f:]/u.test(part) && !/[. ]$/u.test(part))

async function readBoundedFile(file: FileHandle, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  const data = Buffer.alloc(maximum + 1); let bytes = 0
  while (bytes < data.length) {
    signal?.throwIfAborted()
    const next = await file.read(data, bytes, data.length - bytes, bytes)
    if (!next.bytesRead) break
    bytes += next.bytesRead
  }
  if (bytes > maximum) throw invalid()
  return data.subarray(0, bytes)
}

/** Every ancestor is deployment-owned and must already be a real directory.
 * The leaf may be created exclusively, so competing imports cannot adopt it. */
export async function migrationDirectory(root: string, leaf: string, create = false): Promise<string> {
  if (!isAbsolute(root) || resolve(root) === '/' || !safePath(leaf) || leaf.includes('/')) throw invalid()
  let current = '/'
  for (const part of resolve(root).split('/').filter(Boolean)) {
    current = join(current, part)
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid()
  }
  const path = join(current, leaf)
  if (create) { try { await mkdir(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error } }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw invalid()
  return path
}

export async function captureWorkspace(directory: string, signal: AbortSignal): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = []; let bytes = 0
  async function visit(relative: string): Promise<void> {
    signal.throwIfAborted()
    const path = relative ? join(directory, relative) : directory
    const before = await lstat(path)
    if (!before.isDirectory() || before.isSymbolicLink()) throw invalid()
    const names = (await readdir(path)).sort()
    for (const name of names) {
      const child = relative ? `${relative}/${name}` : name
      if (!safePath(child) || entries.length >= MAX_FILES) throw invalid()
      const full = join(directory, child), stat = await lstat(full)
      if (stat.isSymbolicLink()) throw invalid()
      if (stat.isDirectory()) { entries.push({ path: child, kind: 'directory', mode: 0o700 }); await visit(child); continue }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MIGRATION_FILE_MAX_BYTES) throw invalid()
      bytes += stat.size; if (bytes > MAX_CONTENT_BYTES) throw invalid()
      const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const first = await file.stat()
        if (!first.isFile() || first.dev !== stat.dev || first.ino !== stat.ino || first.size !== stat.size || first.nlink !== 1) throw invalid()
        const data = await readBoundedFile(file, MIGRATION_FILE_MAX_BYTES, signal); signal.throwIfAborted(); const after = await file.stat()
        if (after.size !== first.size || after.mtimeMs !== first.mtimeMs || after.ctimeMs !== first.ctimeMs || data.length !== first.size) throw invalid()
        entries.push({ path: child, kind: 'file', mode: stat.mode & 0o100 ? 0o700 : 0o600, bytes: data.length, sha256: snapshotHash(data), base64: data.toString('base64') })
      } finally { await file.close() }
    }
    const after = await lstat(path)
    if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !isDeepStrictEqual(await readdir(path).then(rows => rows.sort()), names)) throw invalid()
  }
  await visit(''); return entries
}

export function parseMigrationSnapshot(data: Buffer, expected: { realm: string; ownerUserID: string; projectID: string; sessionRef: string; cwd: string; eventCount: number; modelPolicySHA: string }): MigrationSnapshot {
  if (data.length > MIGRATION_SNAPSHOT_MAX_BYTES) throw invalid()
  const value = JSON.parse(data.toString('utf8')) as MigrationSnapshot
  if (!value || value.version !== 1 || value.modelPolicySHA !== expected.modelPolicySHA || value.realm !== expected.realm || value.ownerUserID !== expected.ownerUserID || value.projectID !== expected.projectID || value.sessionRef !== expected.sessionRef || !value.header || value.header.id !== expected.sessionRef || value.header.cwd !== expected.cwd || !Array.isArray(value.events) || value.events.length !== expected.eventCount || value.events.length > 10000 || !Number.isSafeInteger(value.inheritedEventCount) || value.inheritedEventCount < 0 || value.inheritedEventCount > value.events.length || (!!value.header.isSeeded !== (value.inheritedEventCount > 0)) || !Array.isArray(value.workspace) || value.workspace.length > MAX_FILES) throw invalid()
  assertVersion(value.header); materializeCreateHeader(value.header); assertContiguous(SessionId(expected.sessionRef), value.events, 0); validateStoredEvents(value.header, value.events)
  let lastStart = -1, lastEnd = -1
  for (const event of value.events) { if (event.type === 'turn/start') lastStart = event.seq; if (event.type === 'turn/end') lastEnd = event.seq }
  if (lastStart > lastEnd) throw invalid()
  const seen = new Map<string, string>(); let bytes = 0
  for (const entry of value.workspace) {
    if (!entry || typeof entry.path !== 'string' || !safePath(entry.path) || seen.has(entry.path) || !['file', 'directory'].includes(entry.kind) || (entry.kind === 'directory' ? entry.mode !== 0o700 : ![0o600, 0o700].includes(entry.mode))) throw invalid()
    const parent = entry.path.slice(0, entry.path.lastIndexOf('/'))
    if (entry.path.includes('/') && seen.get(parent) !== 'directory') throw invalid()
    seen.set(entry.path, entry.kind)
    if (entry.kind === 'directory') { if (entry.base64 !== undefined || entry.bytes !== undefined || entry.sha256 !== undefined) throw invalid(); continue }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes! < 0 || entry.bytes! > MIGRATION_FILE_MAX_BYTES || typeof entry.base64 !== 'string' || entry.base64.length > 4 * Math.ceil(MIGRATION_FILE_MAX_BYTES / 3) || typeof entry.sha256 !== 'string') throw invalid()
    const body = Buffer.from(entry.base64, 'base64')
    if (body.toString('base64') !== entry.base64 || body.length !== entry.bytes || snapshotHash(body) !== entry.sha256) throw invalid()
    bytes += body.length; if (bytes > MAX_CONTENT_BYTES) throw invalid()
  }
  return value
}

/** A trusted, fsynced local marker is written before any import and never
 * placed in the model's workspace. Only a matching marker permits continuing
 * an interrupted import; existing unrelated Sessions are never adopted. */
export async function restoreMigrationSnapshot(persistence: SessionPersistence, root: string, id: string, digest: string, snapshot: MigrationSnapshot, signal: AbortSignal): Promise<void> {
  if (!/^mig_[a-f0-9]{48}$/u.test(id) || !/^[a-f0-9]{64}$/u.test(digest) || !/^session-[a-f0-9]{32}$/u.test(snapshot.sessionRef)) throw invalid()
  // A new target may have no Sessions yet; its dedicated deployment volume
  // parent must exist, and only this configured root leaf may be created.
  await migrationDirectory(dirname(root), basename(root), true)
  const markers = await migrationDirectory(root, '.lumo-migrations', true)
  // Independent target processes may import the same Session concurrently.
  // This deployment-owned per-Session lock covers the marker and directory
  // ownership protocol too, before the native Session writer lock exists.
  await withFileLock(join(markers, snapshot.sessionRef), () => restoreLocked(persistence, root, markers, id, digest, snapshot, signal), { signal, waitMs: 5000 })
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try { await handle.sync() } finally { await handle.close() }
}

async function replaceMarker(marker: string, body: string): Promise<void> {
  const temporary = `${marker}.${randomBytes(12).toString('hex')}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(body); await handle.sync() } finally { await handle.close() }
    await rename(temporary, marker)
    await syncDirectory(dirname(marker))
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
}

async function restoreLocked(persistence: SessionPersistence, root: string, markers: string, id: string, digest: string, snapshot: MigrationSnapshot, signal: AbortSignal): Promise<void> {
  const marker = join(markers, id)
  let fresh = false
  try {
    await lstat(marker)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await replaceMarker(marker, JSON.stringify({ digest, sessionRef: snapshot.sessionRef, phase: 'prepared' })); fresh = true
  }
  const markerFile = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW)
  let phase: string
  try {
    const stat = await markerFile.stat()
    if (!stat.isFile() || stat.size > 512 || stat.nlink !== 1) throw invalid()
    const value = JSON.parse((await readBoundedFile(markerFile, 512, signal)).toString('utf8')) as { digest: string; sessionRef: string; phase: string }
    if (!isDeepStrictEqual(value, { digest, sessionRef: snapshot.sessionRef, phase: value.phase }) || !['prepared', 'workspace'].includes(value.phase)) throw invalid()
    phase = value.phase
  } finally { await markerFile.close() }
  const stored = await persistence.stat(SessionId(snapshot.sessionRef), { signal })
  if (fresh && stored) { await unlink(marker); throw invalid() }
  if (phase === 'prepared') {
    // A crash between mkdir and its ownership marker is deliberately refused:
    // without durable proof this import must not adopt an existing directory.
    try { await mkdir(join(root, snapshot.sessionRef), { mode: 0o700 }) } catch { throw invalid() }
    await syncDirectory(root)
    await replaceMarker(marker, JSON.stringify({ digest, sessionRef: snapshot.sessionRef, phase: 'workspace' }))
  }
  const directory = await migrationDirectory(root, snapshot.sessionRef)
  if (directory !== snapshot.header.cwd) throw invalid()
  // The native public kernel writer lock also serializes staged workspace
  // imports across target processes. Check the stored prefix before touching
  // files; an already advanced Session must never be reset to a checkpoint.
  const handle = stored ? await persistence.open(SessionId(snapshot.sessionRef), 'write', { signal }) : await persistence.create(snapshot.header, { inheritedEventCount: SessionLogOffset(snapshot.inheritedEventCount), signal })
  try {
    if (!isDeepStrictEqual(handle.header, snapshot.header) || handle.inheritedEventCount !== snapshot.inheritedEventCount) throw invalid()
    const current = (await handle.read(0, undefined, { signal })).events
    if (current.length > snapshot.events.length || !isDeepStrictEqual(current, snapshot.events.slice(0, current.length))) throw invalid()
    for (const entry of snapshot.workspace) {
      signal.throwIfAborted(); const path = join(directory, entry.path)
      if (entry.kind === 'directory') {
        try { await mkdir(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid(); await chmod(path, 0o700); continue
      }
      let file
      try { file = await open(path, 'wx', 0o600) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      if (file) { try { await file.writeFile(Buffer.from(entry.base64!, 'base64')); await file.chmod(entry.mode); await file.sync() } finally { await file.close() } }
      else {
        const original = await open(path, constants.O_RDWR | constants.O_NOFOLLOW)
        try {
          const stat = await original.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > MIGRATION_FILE_MAX_BYTES) throw invalid()
          if (stat.size !== entry.bytes || snapshotHash(await readBoundedFile(original, MIGRATION_FILE_MAX_BYTES, signal)) !== entry.sha256) {
            // Only this unactivated import owns the directory. Repair a torn
            // staging file from its exact authenticated immutable checkpoint.
            await original.truncate(0); await original.write(Buffer.from(entry.base64!, 'base64'), 0, entry.bytes!, 0)
          }
          // A crash can leave complete bytes before their executable mode was
          // committed. Restore the mode even when the content already matches.
          await original.chmod(entry.mode); await original.sync()
        } finally { await original.close() }
      }
    }
    const actual = await captureWorkspace(directory, signal)
    if (!isDeepStrictEqual(actual.map(({ mode: _mode, ...entry }) => entry), snapshot.workspace.map(({ mode: _mode, ...entry }) => entry))) throw invalid()
    // File fsync alone does not durably install the directory entries.
    for (const path of [...snapshot.workspace.filter(entry => entry.kind === 'directory').map(entry => join(directory, entry.path)).reverse(), directory, markers, root]) {
      const directoryHandle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    }
    await handle.append(snapshot.events.slice(current.length), { signal }); await handle.flush({ signal })
    if (!isDeepStrictEqual((await handle.read()).events, snapshot.events)) throw invalid()
  } finally { await handle.close() }
}
