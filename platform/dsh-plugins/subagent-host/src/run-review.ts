import type { GovernedExecution } from './governed-dispatch.ts';
import type { RuntimeReportConfig } from './runtime-report.ts';
import { createHash } from 'node:crypto'
import { CLOSED_FILES_PROFILE,CLOSED_TEXT_PROFILE,validateControlledFile } from './controlled-files.ts'
import { CLOSED_REPOSITORY_PROFILE,loadRepositorySnapshot,validateRepositorySnapshot,type RepositorySnapshot } from './controlled-repository.ts'
export interface ReviewFileEntry {id:string;name:string;media_type:string;bytes:number;sha256:string}
export interface PreparedRun {
    snapshot: {
        realm: string;
        task_id: string;
        run_id: string;
        worker_id: string;
        node_id: string;
        session_ref: string;
        preset_id: string;
        preset_revision: number;
        provider: string;
        model: string;
        output_profile: 'platform-closed-text-v1' | 'platform-closed-text-files-v1' | 'platform-closed-repository-v1' | 'unknown';
    };
    review?: {
        producer_task_id: string;
        producer_run_id: string;
        producer_intent: string;
        producer_contract?: {objective: string; root_objective: string; constraints: string[]; acceptance_criteria: string[]; depth: number; parent_task_id?: string};
        manifest_digest: string;
        manifest: {
            scope: string;
            task_id: string;
            run_id: string;
            summary: string;
            entries: {
                id: string;
                sha256: string;
                text: string;
            }[];
            files?:ReviewFileEntry[]
        };
        read_files?: (ReviewFileEntry&{text:string})[];
        expires_at: string;
    };
    /** Executor-owned server receipts are never included in the model prompt. */
    reviewFileReceipts?: {id:string;receipt:string}[];
    repository_snapshot?:RepositorySnapshot
}

const REVIEW_FILE_CONCURRENCY = 4
const REVIEW_PREPARE_TIMEOUT_MS = 30_000

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason) }
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
}
async function boundedJSON(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing authority response body')
    const parts: Uint8Array[] = []
    let bytes = 0
    try {
        for (;;) {
            const next = await abortable(reader.read(), signal)
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > maxBytes) throw new Error('Authority response exceeds bound')
            parts.push(next.value)
        }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
    signal.throwIfAborted()
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
}
async function authorityJSON(fetcher: typeof fetch, url: string, init: RequestInit, active: AbortSignal, maxBytes: number, failure: string): Promise<unknown> {
    const signal = AbortSignal.any([active, AbortSignal.timeout(5000)])
    signal.throwIfAborted()
    const pending = fetcher(url, { ...init, redirect: 'error', signal }).then(response => {
        if (signal.aborted) void response.body?.cancel().catch(() => {})
        return response
    })
    const response = await abortable(pending, signal)
    if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new Error(`${failure}: HTTP ${response.status}`)
    }
    return boundedJSON(response, maxBytes, signal)
}
/** Called before creating the Agent. All independent file reads must finish
 * and match the frozen manifest before any review evidence becomes usable. */
export async function prepareGovernedRun(config: RuntimeReportConfig, execution: GovernedExecution,
    fetcher: typeof fetch = fetch, stop?: AbortSignal): Promise<PreparedRun> {
    const remaining = Math.min(REVIEW_PREPARE_TIMEOUT_MS, execution.preset.timeout_seconds * 1000,
        execution.deadlineMS > 0 ? execution.deadlineMS - Date.now() : Infinity)
    if (execution.cancelled || remaining <= 0 || !Number.isFinite(remaining)) throw new Error('Execution preparation cancelled or timed out')
    const cancel = new AbortController()
    const active = AbortSignal.any([cancel.signal, AbortSignal.timeout(Math.ceil(remaining)), ...(stop ? [stop] : [])])
    try {
        active.throwIfAborted()
        const b = config.binding
        const repository=execution.preset.output_profile===CLOSED_REPOSITORY_PROFILE?await loadRepositorySnapshot(config.repositorySource,active):undefined
        const base = `${config.governanceUrl.replace(/\/+$/u, '')}/v1/runtime/task-runs/${encodeURIComponent(execution.runId)}`
        const value = await authorityJSON(fetcher, `${base}/prepare`, {
            method: 'PUT', headers: { authorization: `Bearer ${config.token}`, 'x-lumo-realm': config.realm, 'content-type': 'application/json' },
            body: JSON.stringify({ node_id: config.nodeId, session_ref: execution.sessionRef, preset_revision: b.presetRevision, provider: b.provider, model: b.model,...(repository?{repository_snapshot:repository}:{}) }),
        }, active, 1_000_000, 'Execution snapshot refused') as PreparedRun
        // The authority cannot pre-populate executor-only read evidence.
        delete value.reviewFileReceipts
        const s = value?.snapshot
        for (const [key, expected] of Object.entries({ realm: config.realm, task_id: execution.task.id, run_id: execution.runId, worker_id: `agent:${b.agentId}`, node_id: config.nodeId, session_ref: execution.sessionRef, preset_id: b.agentId, preset_revision: b.presetRevision, provider: b.provider, model: b.model }))
            if (s?.[key as keyof typeof s] !== expected) throw new Error(`Execution snapshot ${key} mismatch`)
        if (![CLOSED_TEXT_PROFILE, CLOSED_FILES_PROFILE,CLOSED_REPOSITORY_PROFILE, 'unknown'].includes(s.output_profile)) throw new Error('Unsupported execution output profile')
        if(repository){if(!value.repository_snapshot)throw new Error('Authority did not freeze the repository base');validateRepositorySnapshot(value.repository_snapshot);if(JSON.stringify(value.repository_snapshot)!==JSON.stringify(repository))throw new Error('Authority repository snapshot differs from the approved base')}
        else if(value.repository_snapshot)throw new Error('Unexpected repository snapshot')
        const external = execution.preset.connector_ids.length > 0 || execution.preset.knowledge_space_ids.length > 0 || Boolean(execution.preset.system_prompt_ref)
        if (s.output_profile !== (external ? 'unknown' : execution.preset.output_profile ?? CLOSED_TEXT_PROFILE)) throw new Error('Execution output profile differs from its preset')
        if (value.review) {
            const r = value.review
            if (typeof r.producer_intent !== 'string' || !r.producer_intent.trim() || s.output_profile !== CLOSED_TEXT_PROFILE || !r.manifest_digest?.match(/^[0-9a-f]{64}$/u) || !r.manifest || ![CLOSED_TEXT_PROFILE, CLOSED_FILES_PROFILE,CLOSED_REPOSITORY_PROFILE].includes(r.manifest.scope) || r.manifest.task_id !== r.producer_task_id || r.manifest.run_id !== r.producer_run_id || !Array.isArray(r.manifest.entries) || !r.manifest.entries.length || r.manifest.entries.some(e => typeof e.text !== 'string' || typeof e.id !== 'string' || !e.sha256?.match(/^[0-9a-f]{64}$/u)) || !(Date.parse(r.expires_at) > Date.now()))
                throw new Error('Invalid independent review context')
            delete r.read_files
            const files = r.manifest.files ?? []
            if (!Array.isArray(files) || files.length > 16 || [CLOSED_FILES_PROFILE,CLOSED_REPOSITORY_PROFILE].includes(r.manifest.scope) && !files.length || r.manifest.scope === CLOSED_TEXT_PROFILE && files.length) throw new Error('Invalid review file set')
            // Validate the entire enumeration before opening even its first file.
            let total = 0
            const seen = new Set<string>()
            for (const file of files) {
                if (!file || !/^file-[0-9]{4}$/u.test(file.id) || seen.has(file.id) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 32768 || !file.sha256?.match(/^[a-f0-9]{64}$/u)) throw new Error('Invalid review file identity')
                validateControlledFile({ name: file.name, media_type: file.media_type, text: file.media_type === 'application/json' ? '{}' : 'x' })
                seen.add(file.id)
                total += file.bytes
                if (total > 256 * 1024) throw new Error('Review files exceed byte limit')
            }
            if (files.length) {
                const reads = new Array<{ file: ReviewFileEntry & { text: string }; receipt: { id: string; receipt: string } }>(files.length)
                let cursor = 0
                await Promise.all(Array.from({ length: Math.min(REVIEW_FILE_CONCURRENCY, files.length) }, async () => {
                    try {
                        for (;;) {
                            active.throwIfAborted()
                            const index = cursor++
                            const file = files[index]
                            if (!file) return
                            const actual = await authorityJSON(fetcher, `${base}/review-files/${encodeURIComponent(file.id)}`, {
                                headers: { authorization: `Bearer ${config.token}`, 'x-lumo-realm': config.realm, 'x-lumo-node-id': config.nodeId, 'x-lumo-session-ref': execution.sessionRef },
                            }, active, 256 * 1024, 'Independent file read refused') as ReviewFileEntry & { text: string; receipt: string }
                            for (const key of ['id', 'name', 'media_type', 'bytes', 'sha256'] as const)
                                if (actual[key] !== file[key]) throw new Error('Independent file read differs from the exact manifest')
                            validateControlledFile({ name: actual.name, media_type: actual.media_type, text: actual.text })
                            if (Buffer.byteLength(actual.text) !== file.bytes || createHash('sha256').update(actual.text).digest('hex') !== file.sha256 || !actual.receipt?.match(/^[a-f0-9]{64}$/u)) throw new Error('Independent file read failed complete-byte verification')
                            active.throwIfAborted()
                            reads[index] = { file: { ...file, text: actual.text }, receipt: { id: file.id, receipt: actual.receipt } }
                        }
                    } catch (error) { cancel.abort(error); throw error }
                }))
                active.throwIfAborted()
                if (!(Date.parse(r.expires_at) > Date.now())) throw new Error('Independent review context expired during file reads')
                // Preserve manifest order regardless of completion order. No partial
                // evidence escapes when any sibling fails, expires or is cancelled.
                r.read_files = reads.map(read => read.file)
                value.reviewFileReceipts = reads.map(read => read.receipt)
            }
        }
        active.throwIfAborted()
        return value
    } finally { cancel.abort() }
}
