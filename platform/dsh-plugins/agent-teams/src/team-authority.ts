import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AgentTeamsService } from './service.ts';
/** Service-only current-state read. The team remains owned by its KV seam;
 * governance consumes this fact and never copies or writes team state. */
export function teamAuthorityHandler(options: {
    realm: string;
    token: string;
    service: AgentTeamsService;
    durable: () => boolean;
}) {
    return async (req: IncomingMessage, res: ServerResponse) => {
        const write = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
        const expected = Buffer.from(`Bearer ${options.token}`);
        const actual = Buffer.from(String(req.headers.authorization ?? ''));
        if (!options.token || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            write(401, { error: 'service authentication required' });
            return;
        }
        if (req.method !== 'GET' || req.headers['x-lumo-realm'] !== options.realm) {
            write(404, { error: 'not found' });
            return;
        }
        if (!options.durable()) {
            write(503, { error: 'durable team authority unavailable' });
            return;
        }
        const match = new URL(req.url ?? '/', 'http://lumo.local').pathname.match(/^\/lumo\/runtime\/teams\/([A-Za-z0-9_-]+)$/u);
        if (!match) {
            write(404, { error: 'not found' });
            return;
        }
        try {
            const t = await options.service.get(match[1]!);
            if (t.id !== match[1] || t.realm !== options.realm || !t.ownerUserId || !t.revision || !t.captainSessionId)
                throw new Error('unbound team');
            write(200, { realm: t.realm, id: t.id, owner_user_id: t.ownerUserId, captain_session_ref: t.captainSessionId, revision: t.revision });
        }
        catch {
            write(404, { error: 'team not found' });
        }
    };
}
