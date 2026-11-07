import { threadRoundRunId } from './thread-runner.ts';
import type { ThreadRoundRunner } from './threads.ts';
import type { ThreadRegistryLike } from './thread-registry.ts';
import type { ThreadRow } from './thread.ts';
type Input = Parameters<ThreadRoundRunner['start']>[0];
function snapshotInput(input: Input): Input { return { ...input, thread: structuredClone(input.thread), round: { ...input.round } }; }
export interface ThreadCommand {
    id: string;
    realm: string;
    thread_id: string;
    owner_user_id: string;
    node_id: string;
    coordinator_session_ref: string;
    task_id: string;
    attempt: number;
    prompt: string;
    state: 'waiting' | 'pending' | 'claimed' | 'completed' | 'failed' | 'expired';
    wake_key: string;
    wake_deadline?: string;
    event_id: string;
    run_id: string;
    summary: string;
    claim_token?: string;
}
export interface ThreadDispatchOptions {
    baseUrl: string;
    token: string;
    realm: string;
    userId: string;
    nodeId: string;
    registry: ThreadRegistryLike;
    local: ThreadRoundRunner;
    authorize(input: Input): Promise<unknown>;
    fetch?: typeof fetch;
    pollMs?: number;
    warn?: (error: unknown) => void;
}
/** Private object identity is the capability, never a wire parent.id. */
export function createThreadDispatch(options: ThreadDispatchOptions) {
    const parents = new WeakMap<object, ThreadCommand>();
    const fetcher = options.fetch ?? fetch;
    const pollMs = options.pollMs ?? 1000;
    if (![options.token, options.realm, options.userId, options.nodeId].every(v => v.trim()) || pollMs < 10)
        throw new Error('Thread dispatch requires authenticated node identity');
    const call = async (path: string, body?: unknown): Promise<unknown> => {
        const response = await fetcher(`${options.baseUrl.replace(/\/+$/u, '')}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${options.token}`, 'x-lumo-realm': options.realm, 'x-lumo-user': options.userId, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok)
            throw new Error(`Thread mailbox refused: HTTP ${response.status}`);
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('Thread mailbox returned an empty response');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done)
                    break;
                bytes += part.value.byteLength;
                if (bytes > 384 * 1024)
                    throw new Error('Thread mailbox response exceeds bound');
                chunks.push(part.value);
            }
        }
        finally {
            await reader.cancel().catch(() => { });
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    function parse(raw: unknown): ThreadCommand {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error('Invalid Thread command');
        const c = raw as ThreadCommand;
        if (c.realm !== options.realm || c.owner_user_id !== options.userId || ![c.id, c.thread_id, c.node_id, c.coordinator_session_ref, c.task_id].every(v => typeof v === 'string' && v.trim()) || !Number.isSafeInteger(c.attempt) || c.attempt < 1 || typeof c.prompt !== 'string' || Buffer.byteLength(c.prompt) > 256000 || !['waiting', 'pending', 'claimed', 'completed', 'failed', 'expired'].includes(c.state) || typeof c.summary !== 'string')
            throw new Error('Thread mailbox identity mismatch');
        return c;
    }
    const path = (id: string) => `/thread-commands/${encodeURIComponent(id)}`;
    async function enqueue(input: Input, wake?: {
        key: string;
        deadline: string;
    }): Promise<ThreadCommand> {
        input = snapshotInput(input);
        wake = wake ? { ...wake } : undefined;
        input.signal.throwIfAborted();
        await options.authorize(input);
        input.signal.throwIfAborted();
        const c = parse(await call(`/threads/${encodeURIComponent(input.thread.id)}/commands`, { id: threadRoundRunId(input.thread.id, input.round, options.realm), node_id: input.thread.node_id, coordinator_session_ref: input.thread.coordinator_session_ref, task_id: input.thread.task_id, attempt: input.round.attempt, prompt: input.prompt, ...wake ? { wake_key: wake.key, wake_deadline: wake.deadline } : {} }));
        if (c.thread_id !== input.thread.id || c.node_id !== input.thread.node_id || c.task_id !== input.round.task_id || c.coordinator_session_ref !== input.thread.coordinator_session_ref || c.attempt !== input.round.attempt || c.prompt !== input.prompt)
            throw new Error('Thread mailbox command differs from submitted round');
        return c;
    }
    let closing = false;
    let busy: Promise<void> | undefined;
    const stop = new AbortController();
    const active = new Map<string, AbortController>();
    async function tick() {
        if (closing || busy)
            return;
        busy = (async () => {
            const raw = await call('/thread-commands/claim', { node_id: options.nodeId }) as {
                command?: unknown;
            };
            if (!raw.command)
                return;
            const c = parse(raw.command);
            if (c.node_id !== options.nodeId || c.state !== 'claimed' || !c.claim_token || !/^[a-f0-9]{64}$/u.test(c.claim_token))
                throw new Error('Invalid fixed-node Thread claim');
            const thread = await options.registry.get(c.thread_id);
            if (!thread || thread.realm !== c.realm || thread.task_id !== c.task_id || thread.node_id !== c.node_id || thread.coordinator_session_ref !== c.coordinator_session_ref)
                throw new Error('Claim no longer matches its registered Thread');
            const parent = {};
            parents.set(parent, c);
            const controller = new AbortController();
            active.set(c.id, controller);
            try {
                const result = await options.local.start({ thread, round: { task_id: c.task_id, attempt: c.attempt }, prompt: c.prompt, parent, signal: AbortSignal.any([stop.signal, controller.signal]) });
                await call(`${path(c.id)}/finish`, { node_id: options.nodeId, claim_token: c.claim_token, state: 'completed', run_id: result.runId, summary: result.summary ?? '' });
            }
            catch (error) {
                // A lost response or uncertain runner is never taken over or re-executed.
                options.warn?.(error);
                const uncertain = error && typeof error === 'object' && 'receipt' in error && (error as {
                    receipt: {
                        state?: string;
                    };
                }).receipt?.state === 'uncertain';
                if (!uncertain)
                    await call(`${path(c.id)}/finish`, { node_id: options.nodeId, claim_token: c.claim_token, state: 'failed', run_id: threadRoundRunId(c.thread_id, { task_id: c.task_id, attempt: c.attempt }, options.realm), summary: 'Thread execution failed; inspect its durable round receipt' }).catch(options.warn);
            }
            finally {
                parents.delete(parent);
                active.delete(c.id);
            }
        })().catch(error => options.warn?.(error)).finally(() => { busy = undefined; });
        await busy;
    }
    return {
        /** Called only by the local control adapter, in addition to current governance. */
        authorizeClaim(input: Input): boolean {
            const c = input.parent && typeof input.parent === 'object' ? parents.get(input.parent) : undefined;
            return !!c && c.thread_id === input.thread.id && c.node_id === input.thread.node_id && c.task_id === input.round.task_id && c.attempt === input.round.attempt && c.prompt === input.prompt;
        },
        runner: { canStart: () => true, async start(request: Input) {
                const input = snapshotInput(request);
                let c = await enqueue(input);
                while (!['completed', 'failed', 'expired'].includes(c.state)) {
                    input.signal.throwIfAborted();
                    await new Promise<void>((resolve, reject) => { const timer = setTimeout(done, pollMs); function done() { input.signal.removeEventListener('abort', abort); resolve(); } function abort() { clearTimeout(timer); reject(input.signal.reason); } input.signal.addEventListener('abort', abort, { once: true }); });
                    c = parse(await call(path(c.id)));
                }
                if (c.state !== 'completed')
                    throw new Error(`Thread command ${c.id}: ${c.state}`);
                const expected = threadRoundRunId(input.thread.id, input.round, options.realm);
                if (c.run_id !== expected)
                    throw new Error('Thread result run identity mismatch');
                return { runId: c.run_id, summary: c.summary };
            } } satisfies ThreadRoundRunner,
        async schedule(input: Input, wake: {
            key: string;
            deadline: string;
        }) { return enqueue(input, wake); },
        async wake(id: string, key: string, eventId: string) { return parse(await call(`${path(id)}/wake`, { wake_key: key, event_id: eventId })); },
        tick,
        start() { const timer = setInterval(() => void tick(), pollMs); timer.unref(); void tick(); return () => clearInterval(timer); },
        async close() { closing = true; stop.abort(); for (const c of active.values())
            c.abort(); await busy; },
    };
}
