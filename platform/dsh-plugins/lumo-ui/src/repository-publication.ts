import { createHash } from 'node:crypto';
export interface RepositoryChange {
    path: string;
    before_sha256: string;
    after_sha256: string;
    before: string;
    after: string;
    patch: string;
}
export interface RepositoryPublicationPermit {
    id: string;
    manifest_digest: string;
    repository: string;
    base_commit: string;
    base_branch: string;
    status: string;
    changes: RepositoryChange[];
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function pathAllowed(path: string) { return /^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$/u.test(path) && path.split('/').every(p => !!p && !p.startsWith('.') && !['hooks', 'node_modules'].includes(p.toLowerCase())); }
function patchLines(text: string, prefix: string) { if (!text)
    return ''; return text.match(/[^\n]*\n|[^\n]+$/gu)!.map(line => prefix + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n')).join(''); }
export function repositoryPatch(path: string, before: string, after: string) { const count = (text: string) => text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0; return `--- a/${path}\n+++ b/${path}\n@@ -${before ? 1 : 0},${count(before)} +${after ? 1 : 0},${count(after)} @@\n` + patchLines(before, '-') + patchLines(after, '+'); }
export function validatePublicationPermit(value: RepositoryPublicationPermit) {
    if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.id) || !/^[a-f0-9]{64}$/u.test(value.manifest_digest) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) || !/^[a-f0-9]{40}$/u.test(value.base_commit) || !/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$/u.test(value.base_branch) || value.base_branch.includes('..') || value.status !== 'publishing' || !Array.isArray(value.changes) || !value.changes.length || value.changes.length > 8)
        throw new Error('Invalid authority repository publication permit');
    const seen = new Set<string>();
    for (const c of value.changes) {
        if (!c || !pathAllowed(c.path) || seen.has(c.path.toLowerCase()) || typeof c.before !== 'string' || typeof c.after !== 'string' || Buffer.byteLength(c.before) > 3072 || Buffer.byteLength(c.after) > 3072 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(c.before + c.after) || Buffer.from(c.before).toString('utf8') !== c.before || Buffer.from(c.after).toString('utf8') !== c.after || sha(c.before) !== c.before_sha256 || sha(c.after) !== c.after_sha256 || c.before === c.after || c.patch !== repositoryPatch(c.path, c.before, c.after))
            throw new Error('Repository change differs from its immutable reviewed bytes');
        seen.add(c.path.toLowerCase());
    }
}
type GitCall = (operation: string, path: Record<string, string>, body?: Record<string, unknown>) => Promise<unknown>;
export type RepositoryReadCall = (operation: string, path: Record<string, string>, body?: Record<string, unknown>, query?: Record<string, string>) => Promise<unknown>;
export interface RepositoryReconciliation {
    outcome: 'confirmed' | 'unknown';
    reason: 'confirmed' | 'provider_unavailable' | 'evidence_mismatch';
    url?: string;
}
function field(value: unknown, path: string): unknown { let current = value; for (const key of path.split('.'))
    current = typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined; return current; }
/** The permit and complete change set are authority responses, never browser
 * inputs. Publication creates a fresh branch and a draft; it cannot merge. */
export async function publishReviewedRepository(permit: RepositoryPublicationPermit, call: GitCall): Promise<{
    url: string;
    branch: string;
    manifest_digest: string;
}> {
    validatePublicationPermit(permit);
    const [owner, repo] = permit.repository.split('/'), path = { owner: owner!, repo: repo! }, branch = `lumo/review-${permit.id}`;
    const current = await call('get_ref', { ...path, ref: `heads/${permit.base_branch}` });
    if (field(current, 'object.sha') !== permit.base_commit)
        throw new Error('Approved repository base has moved; a fresh snapshot and independent review are required');
    const base = await call('get_commit', { ...path, commit_sha: permit.base_commit }), baseTree = field(base, 'tree.sha');
    if (field(base, 'sha') !== permit.base_commit || typeof baseTree !== 'string' || !/^[a-f0-9]{40}$/u.test(baseTree))
        throw new Error('Repository provider did not confirm the approved immutable base tree');
    // No mutable branch exists while building the immutable Git objects. The
    // single-parent commit adds only the authority-enumerated complete texts.
    const tree = await call('create_tree', path, { base_tree: baseTree, tree: permit.changes.map(change => ({ path: change.path, mode: '100644', type: 'blob', content: change.after })) }), treeSHA = field(tree, 'sha');
    if (typeof treeSHA !== 'string' || !/^[a-f0-9]{40}$/u.test(treeSHA))
        throw new Error('Repository provider did not confirm the reviewed tree');
    const commit = await call('create_commit', path, { message: `Lumo independently reviewed changes ${permit.manifest_digest}`, tree: treeSHA, parents: [permit.base_commit] }), commitSHA = field(commit, 'sha'), parents = field(commit, 'parents');
    if (typeof commitSHA !== 'string' || !/^[a-f0-9]{40}$/u.test(commitSHA) || field(commit, 'tree.sha') !== treeSHA || !Array.isArray(parents) || parents.length !== 1 || field(parents[0], 'sha') !== permit.base_commit)
        throw new Error('Repository provider did not confirm the exact reviewed commit and parent');
    const created = await call('create_ref', path, { ref: `refs/heads/${branch}`, sha: commitSHA });
    if (field(created, 'object.sha') !== commitSHA)
        throw new Error('Repository branch differs from its reviewed commit');
    const latest = await call('get_ref', { ...path, ref: `heads/${permit.base_branch}` });
    if (field(latest, 'object.sha') !== permit.base_commit)
        throw new Error('Approved repository base moved during publication; reconcile the created branch');
    const result = await call('create_pull_request', path, { title: `Lumo reviewed changes ${permit.manifest_digest.slice(0, 12)}`, head: branch, base: permit.base_branch, draft: true, body: `Independent review manifest: ${permit.manifest_digest}\nApproved base: ${permit.base_commit}\n\nContains only the bounded UTF-8 file changes in the reviewed manifest. Automated tests were not executed by this restricted profile.` });
    const url = field(result, 'html_url'), prefix = `https://github.com/${permit.repository}/pull/`;
    if (field(result, 'draft') !== true || field(result, 'base.sha') !== permit.base_commit || field(result, 'head.sha') !== commitSHA || field(result, 'head.ref') !== branch || field(result, 'head.repo.full_name') !== permit.repository || typeof url !== 'string' || !url.startsWith(prefix) || !/^\d+$/u.test(url.slice(prefix.length)))
        throw new Error('Repository provider did not confirm the exact reviewed draft pull request');
    return { url, branch, manifest_digest: permit.manifest_digest };
}

class RepositoryEvidenceMismatch extends Error {}
function evidence(condition: unknown): asserts condition { if (!condition) throw new RepositoryEvidenceMismatch(); }
const gitSHA = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
function gitObject(kind: 'blob' | 'tree', content: Buffer) { return createHash('sha1').update(`${kind} ${content.length}\0`).update(content).digest('hex'); }
interface GitTreeEntry { path: string; mode: string; type: string; sha: string; }
function treeHash(entries: GitTreeEntry[]) {
    const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path + (a.type === 'tree' ? '/' : '')), Buffer.from(b.path + (b.type === 'tree' ? '/' : ''))));
    return gitObject('tree', Buffer.concat(sorted.map(entry => Buffer.concat([Buffer.from(`${entry.mode === '040000' ? '40000' : entry.mode} ${entry.path}\0`), Buffer.from(entry.sha, 'hex')]))));
}

/** Reconciliation never creates Git objects, refs or pull requests. Rebuilding
 * the expected tree hash from complete base trees proves that hidden and
 * unreviewed paths were retained byte-for-byte, without a truncated diff API. */
export async function reconcileReviewedRepository(value: RepositoryPublicationPermit, call: RepositoryReadCall): Promise<RepositoryReconciliation> {
    if (!value || !['publishing', 'draft'].includes(value.status)) throw new Error('Invalid authority repository reconciliation permit');
    validatePublicationPermit({ ...value, status: 'publishing' });
    const permit = { ...value, changes: value.changes.map(change => ({ ...change })) };
    const [owner, repo] = permit.repository.split('/'), path = { owner: owner!, repo: repo! }, branch = `lumo/review-${permit.id}`;
    const readRef = async (name: string) => {
        const ref = await call('get_ref', { ...path, ref: `heads/${name}` });
        evidence(field(ref, 'ref') === `refs/heads/${name}` && field(ref, 'object.type') === 'commit' && gitSHA(field(ref, 'object.sha')));
        return field(ref, 'object.sha') as string;
    };
    try {
        evidence(await readRef(permit.base_branch) === permit.base_commit);
        const commitSHA = await readRef(branch);
        const base = await call('get_commit', { ...path, commit_sha: permit.base_commit }), baseTree = field(base, 'tree.sha');
        evidence(field(base, 'sha') === permit.base_commit && gitSHA(baseTree));
        const commit = await call('get_commit', { ...path, commit_sha: commitSHA }), parents = field(commit, 'parents');
        evidence(field(commit, 'sha') === commitSHA && field(commit, 'message') === `Lumo independently reviewed changes ${permit.manifest_digest}` && gitSHA(field(commit, 'tree.sha')) && Array.isArray(parents) && parents.length === 1 && field(parents[0], 'sha') === permit.base_commit);
        let treeReads = 0, entryCount = 0;
        const trees = new Map<string, GitTreeEntry[]>();
        const readTree = async (sha: string) => {
            const cached = trees.get(sha);
            if (cached) return cached.map(entry => ({ ...entry }));
            evidence(++treeReads <= 128);
            const result = await call('get_tree', { ...path, tree_sha: sha }), raw = field(result, 'tree');
            evidence(field(result, 'sha') === sha && field(result, 'truncated') === false && Array.isArray(raw) && raw.length <= 4096);
            entryCount += raw.length;
            evidence(entryCount <= 16384);
            const seen = new Set<string>(), entries: GitTreeEntry[] = [];
            for (const item of raw) {
                const name = field(item, 'path'), mode = field(item, 'mode'), type = field(item, 'type'), objectSHA = field(item, 'sha');
                evidence(typeof name === 'string' && !!name && name !== '.' && name !== '..' && !/[\0/]/u.test(name) && Buffer.byteLength(name) <= 1024 && Buffer.from(name).toString('utf8') === name && !seen.has(name) && gitSHA(objectSHA));
                evidence((mode === '040000' && type === 'tree') || (['100644', '100755', '120000'].includes(String(mode)) && type === 'blob') || (mode === '160000' && type === 'commit'));
                seen.add(name);
                entries.push({ path: name, mode: mode as string, type: type as string, sha: objectSHA });
            }
            evidence(treeHash(entries) === sha);
            trees.set(sha, entries);
            return entries.map(entry => ({ ...entry }));
        };
        const rebuild = async (sha: string, changes: { segments: string[]; before: string; after: string }[]): Promise<string> => {
            const entries = await readTree(sha), groups = new Map<string, typeof changes>();
            for (const change of changes) { const name = change.segments[0]!; const group = groups.get(name) ?? []; group.push(change); groups.set(name, group); }
            for (const [name, group] of groups) {
                const entry = entries.find(item => item.path === name);
                evidence(entry);
                if (group[0]!.segments.length === 1) {
                    evidence(group.length === 1 && entry.mode === '100644' && entry.type === 'blob' && entry.sha === gitObject('blob', Buffer.from(group[0]!.before)));
                    entry.sha = gitObject('blob', Buffer.from(group[0]!.after));
                } else {
                    evidence(group.every(change => change.segments.length > 1) && entry.mode === '040000' && entry.type === 'tree');
                    entry.sha = await rebuild(entry.sha, group.map(change => ({ ...change, segments: change.segments.slice(1) })));
                }
            }
            return treeHash(entries);
        };
        evidence(await rebuild(baseTree, permit.changes.map(change => ({ segments: change.path.split('/'), before: change.before, after: change.after }))) === field(commit, 'tree.sha'));
        // Two results suffice to detect ambiguity; one result on the first
        // page cannot hide additional pages under GitHub's pagination contract.
        const pulls = await call('list_pull_requests', path, undefined, { state: 'all', head: `${owner}:${branch}`, base: permit.base_branch, per_page: '2', page: '1' });
        evidence(Array.isArray(pulls) && pulls.length === 1);
        const number = field(pulls[0], 'number');
        evidence(typeof number === 'number' && Number.isSafeInteger(number) && number > 0);
        const url = `https://github.com/${permit.repository}/pull/${number}`;
        const checkPull = async () => {
            const pull = await call('get_pull_request', { ...path, pull_number: String(number) });
            evidence(field(pull, 'number') === number && field(pull, 'html_url') === url && field(pull, 'state') === 'open' && field(pull, 'draft') === true && field(pull, 'merged') === false && field(pull, 'merged_at') === null && field(pull, 'base.sha') === permit.base_commit && field(pull, 'base.ref') === permit.base_branch && field(pull, 'base.repo.full_name') === permit.repository && field(pull, 'head.sha') === commitSHA && field(pull, 'head.ref') === branch && field(pull, 'head.repo.full_name') === permit.repository);
        };
        await checkPull();
        evidence(await readRef(branch) === commitSHA && await readRef(permit.base_branch) === permit.base_commit);
        await checkPull();
        return { outcome: 'confirmed', reason: 'confirmed', url };
    } catch (error) {
        return { outcome: 'unknown', reason: error instanceof RepositoryEvidenceMismatch ? 'evidence_mismatch' : 'provider_unavailable' };
    }
}
