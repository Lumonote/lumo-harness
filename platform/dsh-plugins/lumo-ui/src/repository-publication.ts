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
