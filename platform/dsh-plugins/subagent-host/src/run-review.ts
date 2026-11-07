import type { GovernedExecution } from './governed-dispatch.ts';
import type { RuntimeReportConfig } from './runtime-report.ts';
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
        output_profile: 'platform-closed-text-v1' | 'unknown';
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
        };
        expires_at: string;
    };
}
/** Called before creating the Agent. The authority freezes the executed model;
 * current mutable preset metadata cannot substitute for this receipt. */
export async function prepareGovernedRun(config: RuntimeReportConfig, execution: GovernedExecution, fetcher: typeof fetch = fetch): Promise<PreparedRun> {
    const b = config.binding;
    const response = await fetcher(`${config.governanceUrl.replace(/\/+$/u, '')}/v1/runtime/task-runs/${encodeURIComponent(execution.runId)}/prepare`, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${config.token}`, 'x-lumo-realm': config.realm, 'content-type': 'application/json' }, body: JSON.stringify({ node_id: config.nodeId, session_ref: execution.sessionRef, preset_revision: b.presetRevision, provider: b.provider, model: b.model }) });
    if (!response.ok)
        throw new Error(`Execution snapshot refused: HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 1000000)
        throw new Error('Execution snapshot response exceeds bound');
    const value = JSON.parse(text) as PreparedRun;
    const s = value?.snapshot;
    for (const [key, expected] of Object.entries({ realm: config.realm, task_id: execution.task.id, run_id: execution.runId, worker_id: `agent:${b.agentId}`, node_id: config.nodeId, session_ref: execution.sessionRef, preset_id: b.agentId, preset_revision: b.presetRevision, provider: b.provider, model: b.model }))
        if (s?.[key as keyof typeof s] !== expected)
            throw new Error(`Execution snapshot ${key} mismatch`);
    if (!['platform-closed-text-v1', 'unknown'].includes(s.output_profile))
        throw new Error('Unsupported execution output profile');
    if (value.review) {
        const r = value.review;
        if (typeof r.producer_intent !== 'string' || !r.producer_intent.trim() || s.output_profile !== 'platform-closed-text-v1' || !r.manifest_digest?.match(/^[0-9a-f]{64}$/u) || !r.manifest || r.manifest.scope !== 'platform-closed-text-v1' || r.manifest.task_id !== r.producer_task_id || r.manifest.run_id !== r.producer_run_id || !Array.isArray(r.manifest.entries) || !r.manifest.entries.length || r.manifest.entries.some(e => typeof e.text !== 'string' || typeof e.id !== 'string' || !e.sha256?.match(/^[0-9a-f]{64}$/u)) || !(Date.parse(r.expires_at) > Date.now()))
            throw new Error('Invalid independent review context');
    }
    return value;
}
