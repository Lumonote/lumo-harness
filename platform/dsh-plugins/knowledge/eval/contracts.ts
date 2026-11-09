import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { EvalCase } from './metrics.ts'

export interface EvalCorpus {
  schema_version: 'lumo-knowledge-corpus/v1'
  id: string
  revision: number
  documents: Array<{ id: string; title: string; text: string }>
}
export interface EvalSuite {
  schema_version: 'lumo-knowledge-suite/v1'
  id: string
  revision: number
  corpus_digest: string
  cases: EvalCase[]
}
export interface EvalConfiguration {
  schema_version: 'lumo-knowledge-configuration/v1'
  embedding: { model: string; revision: string; dimension: number }
  rerank: { mode: 'off' | 'optional' | 'required'; model: string | null; revision: string | null }
  topK: number
  overfetch: number
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${path}: expected plain object`)
  return value as Record<string, unknown>
}
export function exact(value: Record<string, unknown>, fields: string[], path: string): void {
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new Error(`${path}: missing or unknown field`)
}
export function boundedText(value: unknown, path: string, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) throw new Error(`${path}: invalid bounded text`)
}
function id(value: unknown, path: string): void {
  boundedText(value, path, 256)
  if (value !== value.trim() || /[\x00-\x1f\x7f]/u.test(value)) throw new Error(`${path}: invalid identity`)
}
export function integer(value: unknown, path: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${path}: invalid integer`)
}
export function list(value: unknown, path: string, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new Error(`${path}: expected nonempty bounded array`)
}
function unique(values: unknown[], path: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${path}: duplicate identity`)
}
export function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('JSON nesting exceeds 32')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']'
  const object = record(value, 'JSON')
  return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonical(object[key], depth + 1)).join(',') + '}'
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

/** Only explicit local bundle files are read. Corpus content never names paths
 * or services. Reject links, traversal, devices and unbounded files. */
export function readBundleJSON(root: string, relative: string): unknown {
  if (isAbsolute(relative) || relative.includes('\\') || !relative || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Input path must be a relative bundle file')
  const base = realpathSync(root)
  let current = base
  for (const part of relative.split('/')) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error('Input symlinks are forbidden')
  }
  if (!lstatSync(current).isFile()) throw new Error('Input must be a regular JSON file')
  const path = resolve(current)
  if (!path.startsWith(base + sep)) throw new Error('Input path escaped bundle')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 2 || stat.size > 16 * 1024 * 1024) throw new Error('Input must be a regular JSON file of at most 16 MiB')
    // Bounded reads also cover a file growing after fstat; readFileSync could
    // allocate an arbitrarily large buffer before checking the result size.
    const bytes = Buffer.allocUnsafe(16 * 1024 * 1024 + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    if (length > 16 * 1024 * 1024) throw new Error('Input changed or exceeds 16 MiB')
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    return parseJSON(raw)
  } finally { closeSync(fd) }
}

/** JSON.parse accepts duplicate keys; evaluation identities must not depend on
 * which parser happened to select a duplicate. A small structural scanner
 * rejects duplicates before delegating syntax/value decoding to JSON.parse. */
export function parseJSON(raw: string): unknown {
  let at = 0
  const ws = () => { while (/\s/u.test(raw[at] ?? '') && at < raw.length) at++ }
  const string = (): string => {
    const start = at++
    while (at < raw.length) {
      const c = raw[at++]
      if (c === '\\') at++
      else if (c === '"') return JSON.parse(raw.slice(start, at)) as string
    }
    throw new Error('Unterminated JSON string')
  }
  function value(depth: number): void {
    if (depth > 32) throw new Error('JSON nesting exceeds 32')
    ws()
    if (raw[at] === '{') {
      at++; ws(); const seen = new Set<string>()
      if (raw[at] === '}') { at++; return }
      while (at < raw.length) {
        ws(); if (raw[at] !== '"') throw new Error('Invalid JSON object')
        const key = string()
        if (seen.has(key)) throw new Error('Duplicate JSON key')
        seen.add(key); ws()
        if (raw[at++] !== ':') throw new Error('Invalid JSON object')
        value(depth + 1); ws()
        const c = raw[at++]
        if (c === '}') return
        if (c !== ',') throw new Error('Invalid JSON object')
      }
    } else if (raw[at] === '[') {
      at++; ws(); if (raw[at] === ']') { at++; return }
      while (at < raw.length) { value(depth + 1); ws(); const c = raw[at++]; if (c === ']') return; if (c !== ',') throw new Error('Invalid JSON array') }
    } else if (raw[at] === '"') { string(); return }
    else {
      const start = at
      while (at < raw.length && !/[\s,\]}]/u.test(raw[at]!)) at++
      if (start === at) throw new Error('Invalid JSON value')
      const scalar = JSON.parse(raw.slice(start, at)) as unknown
      if (typeof scalar === 'number' && !Number.isFinite(scalar)) throw new Error('Nonfinite JSON number')
      return
    }
    throw new Error('Incomplete JSON')
  }
  value(0); ws(); if (at !== raw.length) throw new Error('Trailing JSON content')
  return JSON.parse(raw) as unknown
}

export function parseCorpus(input: unknown): EvalCorpus {
  const c = record(input, 'corpus')
  exact(c, ['schema_version', 'id', 'revision', 'documents'], 'corpus')
  if (c.schema_version !== 'lumo-knowledge-corpus/v1') throw new Error('Unsupported corpus schema')
  id(c.id, 'corpus.id'); integer(c.revision, 'corpus.revision', 1, 1_000_000)
  list(c.documents, 'corpus.documents', 10_000)
  for (const document of c.documents) {
    const d = record(document, 'document'); exact(d, ['id', 'title', 'text'], 'document')
    id(d.id, 'document.id'); boundedText(d.title, 'document.title', 1000); boundedText(d.text, 'document.text', 128_000)
  }
  unique(c.documents.map(d => (d as { id: string }).id), 'corpus.documents')
  if (Buffer.byteLength(canonical(c)) > 16 * 1024 * 1024) throw new Error('Corpus exceeds 16 MiB')
  return structuredClone(c) as unknown as EvalCorpus
}

export function parseSuite(input: unknown, corpus: EvalCorpus): EvalSuite {
  const s = record(input, 'suite')
  exact(s, ['schema_version', 'id', 'revision', 'corpus_digest', 'cases'], 'suite')
  if (s.schema_version !== 'lumo-knowledge-suite/v1' || s.corpus_digest !== digest(corpus)) throw new Error('Suite schema/corpus digest mismatch')
  id(s.id, 'suite.id'); integer(s.revision, 'suite.revision', 1, 1_000_000)
  list(s.cases, 'suite.cases', 10_000)
  const docs = new Set(corpus.documents.map(d => d.id))
  for (const entry of s.cases) {
    const c = record(entry, 'case'); exact(c, ['id', 'query', 'expectedDocIds', 'note'], 'case')
    id(c.id, 'case.id'); boundedText(c.query, 'case.query', 16_000); boundedText(c.note, 'case.note', 4000)
    list(c.expectedDocIds, 'case.expectedDocIds', 100)
    for (const expected of c.expectedDocIds) if (typeof expected !== 'string' || !docs.has(expected)) throw new Error('Expected document does not exist in corpus')
    unique(c.expectedDocIds, 'case.expectedDocIds')
  }
  unique(s.cases.map(c => (c as { id: string }).id), 'suite.cases')
  return structuredClone(s) as unknown as EvalSuite
}

export function parseConfiguration(input: unknown): EvalConfiguration {
  const c = record(input, 'configuration')
  exact(c, ['schema_version', 'embedding', 'rerank', 'topK', 'overfetch'], 'configuration')
  if (c.schema_version !== 'lumo-knowledge-configuration/v1') throw new Error('Unsupported configuration')
  const embedding = record(c.embedding, 'embedding'), rerank = record(c.rerank, 'rerank')
  exact(embedding, ['model', 'revision', 'dimension'], 'embedding'); exact(rerank, ['mode', 'model', 'revision'], 'rerank')
  boundedText(embedding.model, 'embedding.model', 256); boundedText(embedding.revision, 'embedding.revision', 256)
  integer(embedding.dimension, 'embedding.dimension', 1, 65536)
  if (!['off', 'optional', 'required'].includes(String(rerank.mode))) throw new Error('Invalid rerank mode')
  if (rerank.mode === 'off') { if (rerank.model !== null || rerank.revision !== null) throw new Error('Off rerank must not claim a model') }
  else { boundedText(rerank.model, 'rerank.model', 256); boundedText(rerank.revision, 'rerank.revision', 256) }
  integer(c.topK, 'topK', 5, 100); integer(c.overfetch, 'overfetch', 1, 20)
  if (c.topK * c.overfetch > 100) throw new Error('Requested candidates exceed provider limit 100')
  return structuredClone(c) as unknown as EvalConfiguration
}
