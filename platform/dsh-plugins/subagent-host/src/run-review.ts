import type { GovernedExecution } from './governed-dispatch.ts';
import type { RuntimeReportConfig } from './runtime-report.ts';
import { createHash } from 'node:crypto'
import { CLOSED_FILES_PROFILE,CLOSED_TEXT_PROFILE,validateControlledFile } from './controlled-files.ts'
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
        output_profile: 'platform-closed-text-v1' | 'platform-closed-text-files-v1' | 'unknown';
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
}

async function boundedJSON(response:Response,maxBytes:number):Promise<unknown>{
 const reader=response.body?.getReader();if(!reader)throw new Error('Missing authority response body')
 const parts:Uint8Array[]=[];let bytes=0
 try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>maxBytes)throw new Error('Authority response exceeds bound');parts.push(next.value)}}finally{await reader.cancel().catch(()=>{})}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)))
}
/** Called before creating the Agent. The authority freezes the executed model;
 * current mutable preset metadata cannot substitute for this receipt. */
export async function prepareGovernedRun(config: RuntimeReportConfig, execution: GovernedExecution, fetcher: typeof fetch = fetch): Promise<PreparedRun> {
    const b = config.binding;
    const response = await fetcher(`${config.governanceUrl.replace(/\/+$/u, '')}/v1/runtime/task-runs/${encodeURIComponent(execution.runId)}/prepare`, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${config.token}`, 'x-lumo-realm': config.realm, 'content-type': 'application/json' }, body: JSON.stringify({ node_id: config.nodeId, session_ref: execution.sessionRef, preset_revision: b.presetRevision, provider: b.provider, model: b.model }) });
    if (!response.ok)
        throw new Error(`Execution snapshot refused: HTTP ${response.status}`);
    const value = await boundedJSON(response,1000000) as PreparedRun;
    // The authority does not get to pre-populate executor-only read evidence.
    delete value.reviewFileReceipts
    const s = value?.snapshot;
    for (const [key, expected] of Object.entries({ realm: config.realm, task_id: execution.task.id, run_id: execution.runId, worker_id: `agent:${b.agentId}`, node_id: config.nodeId, session_ref: execution.sessionRef, preset_id: b.agentId, preset_revision: b.presetRevision, provider: b.provider, model: b.model }))
        if (s?.[key as keyof typeof s] !== expected)
            throw new Error(`Execution snapshot ${key} mismatch`);
    if (![CLOSED_TEXT_PROFILE,CLOSED_FILES_PROFILE, 'unknown'].includes(s.output_profile))
        throw new Error('Unsupported execution output profile');
    const external=execution.preset.connector_ids.length>0||execution.preset.knowledge_space_ids.length>0||Boolean(execution.preset.system_prompt_ref)
    if(s.output_profile!==(external?'unknown':execution.preset.output_profile??CLOSED_TEXT_PROFILE))throw new Error('Execution output profile differs from its preset')
    if (value.review) {
        const r = value.review;
        if (typeof r.producer_intent !== 'string' || !r.producer_intent.trim() || s.output_profile !== CLOSED_TEXT_PROFILE || !r.manifest_digest?.match(/^[0-9a-f]{64}$/u) || !r.manifest || ![CLOSED_TEXT_PROFILE,CLOSED_FILES_PROFILE].includes(r.manifest.scope) || r.manifest.task_id !== r.producer_task_id || r.manifest.run_id !== r.producer_run_id || !Array.isArray(r.manifest.entries) || !r.manifest.entries.length || r.manifest.entries.some(e => typeof e.text !== 'string' || typeof e.id !== 'string' || !e.sha256?.match(/^[0-9a-f]{64}$/u)) || !(Date.parse(r.expires_at) > Date.now()))
            throw new Error('Invalid independent review context');
        delete r.read_files
        const files=r.manifest.files??[]
        if(!Array.isArray(files)||files.length>16||r.manifest.scope===CLOSED_FILES_PROFILE&&!files.length||r.manifest.scope===CLOSED_TEXT_PROFILE&&files.length)throw new Error('Invalid review file set')
        if(files.length){
          let total=0;const seen=new Set<string>();r.read_files=[];value.reviewFileReceipts=[]
          for(const file of files){
            if(!file||!/^file-[0-9]{4}$/u.test(file.id)||seen.has(file.id)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>32768||!file.sha256?.match(/^[a-f0-9]{64}$/u))throw new Error('Invalid review file identity')
            seen.add(file.id);total+=file.bytes;if(total>256*1024)throw new Error('Review files exceed byte limit')
            const opened=await fetcher(`${config.governanceUrl.replace(/\/+$/u,'')}/v1/runtime/task-runs/${encodeURIComponent(execution.runId)}/review-files/${encodeURIComponent(file.id)}`,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{authorization:`Bearer ${config.token}`,'x-lumo-realm':config.realm,'x-lumo-node-id':config.nodeId,'x-lumo-session-ref':execution.sessionRef}})
            if(!opened.ok)throw new Error(`Independent file read refused: HTTP ${opened.status}`)
            const actual=await boundedJSON(opened,256*1024) as ReviewFileEntry&{text:string;receipt:string}
            for(const key of ['id','name','media_type','bytes','sha256'] as const)if(actual[key]!==file[key])throw new Error('Independent file read differs from the exact manifest')
            validateControlledFile({name:actual.name,media_type:actual.media_type,text:actual.text})
            if(Buffer.byteLength(actual.text)!==file.bytes||createHash('sha256').update(actual.text).digest('hex')!==file.sha256||!actual.receipt?.match(/^[a-f0-9]{64}$/u))throw new Error('Independent file read failed complete-byte verification')
            r.read_files.push({...file,text:actual.text})
            value.reviewFileReceipts.push({id:file.id,receipt:actual.receipt})
          }
        }
    }
    return value;
}
