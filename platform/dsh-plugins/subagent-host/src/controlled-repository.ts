import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
const exec = promisify(execFile);
export const CLOSED_REPOSITORY_PROFILE = 'platform-closed-repository-v1';
export const REPOSITORY_TOOLS = ['repository_snapshot_read', 'repository_snapshot_write'] as const;
export interface RepositoryFile {
    path: string;
    text: string;
}
export interface RepositorySnapshot {
    repository: string;
    base_commit: string;
    base_branch: string;
    files: RepositoryFile[];
}
/** Deployment-owned capability. No path, commit or repository is accepted from
 * a task, model tool, browser request or final model output. */
export interface RepositorySource {
    root: string;
    repository: string;
    baseCommit: string;
    baseBranch: string;
    paths: string[];
}
export function repositoryPathAllowed(path: string): boolean {
    return /^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$/u.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('.') && !['hooks', 'node_modules'].includes(part.toLowerCase()));
}
function textAllowed(text: string): boolean { return Buffer.byteLength(text) <= 3072 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) && Buffer.from(text).toString('utf8') === text; }
export function validateRepositorySnapshot(value: RepositorySnapshot): void {
    if (!value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) || !/^[a-f0-9]{40}$/u.test(value.base_commit) || !/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$/u.test(value.base_branch) || value.base_branch.includes('..') || !Array.isArray(value.files) || !value.files.length || value.files.length > 8)
        throw new Error('Repository execution requires a bounded approved base snapshot');
    const seen = new Set<string>();
    for (const file of value.files) {
        if (!file || !repositoryPathAllowed(file.path) || seen.has(file.path.toLowerCase()) || typeof file.text !== 'string' || !textAllowed(file.text))
            throw new Error('Unsafe repository snapshot file');
        seen.add(file.path.toLowerCase());
    }
}
export async function loadRepositorySnapshot(source: RepositorySource | undefined, signal: AbortSignal): Promise<RepositorySnapshot> {
    if (!source || !isAbsolute(source.root) || !Array.isArray(source.paths))
        throw new Error('Deployment repository snapshot source is unavailable');
    const initial: RepositorySnapshot = { repository: source.repository, base_commit: source.baseCommit, base_branch: source.baseBranch, files: source.paths.map(path => ({ path, text: '' })) };
    validateRepositorySnapshot(initial);
    const root = await realpath(source.root), active = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    const git = async (args: string[], maxBuffer = 8192) => { active.throwIfAborted(); const result = await exec('git', ['--no-pager', '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', ...args], { cwd: root, shell: false, encoding: 'buffer', maxBuffer, signal: active, timeout: 5000, env: { PATH: process.env['PATH'], GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C' } }); return result.stdout; };
    const commit = (await git(['rev-parse', '--verify', `${source.baseCommit}^{commit}`])).toString('ascii').trim();
    if (commit !== source.baseCommit)
        throw new Error('Approved repository commit is unavailable');
    for (const file of initial.files) {
        const entry = (await git(['ls-tree', '-z', source.baseCommit, '--', file.path])).toString('utf8');
        if (!/^100644 blob [a-f0-9]{40}\t/u.test(entry) || entry.split('\t')[1] !== file.path + '\0')
            throw new Error('Only existing regular non-executable repository files are supported');
        const size = Number((await git(['cat-file', '-s', `${source.baseCommit}:${file.path}`])).toString('ascii').trim());
        if (!Number.isSafeInteger(size) || size > 3072 || size < 0)
            throw new Error('Approved repository file exceeds 3 KiB');
        const bytes = await git(['cat-file', 'blob', `${source.baseCommit}:${file.path}`], 4096);
        file.text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    }
    validateRepositorySnapshot(initial);
    active.throwIfAborted();
    return initial;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export class ControlledRepository {
    private readonly files: Map<string, string>;
    private sealed = false;
    constructor(readonly snapshot: RepositorySnapshot) { validateRepositorySnapshot(snapshot); this.files = new Map(snapshot.files.map(file => [file.path, file.text])); }
    read(path: unknown) { if (typeof path !== 'string' || !this.files.has(path))
        throw new Error('Path is outside the approved snapshot'); const text = this.files.get(path)!; return { path, text, sha256: digest(text) }; }
    write(value: unknown) { if (this.sealed || !value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Repository snapshot is sealed'); const args = value as Record<string, unknown>; if (Object.keys(args).some(key => !['path', 'text', 'expected_sha256'].includes(key)) || typeof args.text !== 'string' || !textAllowed(args.text))
        throw new Error('Repository writes require complete bounded UTF-8 text'); const before = this.read(args.path); if (args.expected_sha256 !== before.sha256)
        throw new Error('Repository snapshot revision changed'); this.files.set(before.path, args.text); return { path: before.path, sha256: digest(args.text), bytes: Buffer.byteLength(args.text) }; }
    seal(): RepositoryFile[] { this.sealed = true; return [...this.files].map(([path, text]) => ({ path, text })); }
    install(ctx: Context, session: string): void {
        for (const name of REPOSITORY_TOOLS)
            ctx.tools.register({ name, description: name.endsWith('_read') ? 'Read a complete file from the deployment-approved immutable base snapshot. Only the listed paths exist; no host filesystem or network access.' : 'Replace one approved file in the private in-memory snapshot. Supply its current SHA256 and entire UTF-8 text (at most 3 KiB). No live repository is changed; all final changes require independent review.', parameters: { type: 'object', additionalProperties: false, required: name.endsWith('_read') ? ['path'] : ['path', 'text', 'expected_sha256'], properties: { path: { type: 'string' }, ...(name.endsWith('_write') ? { text: { type: 'string', maxLength: 3072 }, expected_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } } : {}) } }, output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args, execution) => { execution.signal.throwIfAborted(); if (String(execution.agent?.session.id) !== session)
                    throw new Error('Repository tool requires its exact live execution Session'); return name.endsWith('_read') ? this.read((args as Record<string, unknown>)?.path) : this.write(args); } });
    }
}
