/** Local human decisions never reuse control-plane or Bot credentials. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { RemoteComputerLocalRequest } from './remote-computer-types.ts'
export interface RemoteComputerLocalService {
  list(): RemoteComputerLocalRequest[] | Promise<RemoteComputerLocalRequest[]>
  decide(id: string, input: { digest: string; approve: boolean }): Promise<unknown>
  revoke(id: string, digest: string): Promise<unknown>
}
interface Services { get(name: string): unknown }
const PREFIX = '/lumo/api/remote-computer'
const idPattern = /^[A-Za-z0-9_-]{43}$/u
function json(res: ServerResponse, status: number, value: unknown): void {
  res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff'); res.writeHead(status); res.end(JSON.stringify(value))
}
export function remoteComputerHandler(ctx: Services, local: boolean) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!local) { json(res,404,{error:'remote_computer_local_only'}); return }
    const connection = ctx.get('connection') as { browserPeer: object; admit(req: IncomingMessage): {peer:object}|{rejection:number} } | undefined
    if (!connection) { json(res,503,{error:'browser_auth_unavailable'}); return }
    const admission = connection.admit(req)
    if ('rejection' in admission || admission.peer !== connection.browserPeer) { json(res,'rejection' in admission ? admission.rejection : 403,{error:'browser_auth_required'}); return }
    const path = new URL(req.url ?? '/','http://local.invalid').pathname
    const match = path.match(/^\/lumo\/api\/remote-computer\/([A-Za-z0-9_-]{43})\/(decide|revoke)$/u)
    if (path !== PREFIX && !match) { json(res,404,{error:'unknown_remote_computer_endpoint'}); return }
    if (req.method !== (match ? 'POST' : 'GET')) { res.setHeader('allow',match ? 'POST' : 'GET'); json(res,405,{error:'method_not_allowed'}); return }
    const service = ctx.get('lumoRemoteComputerUse') as RemoteComputerLocalService | undefined
    if (!service) { json(res,503,{error:'remote_computer_unavailable'}); return }
    try {
      if (!match) { json(res,200,{requests:await service.list()}); return }
      const protocol = (ctx.get('webServer') as {protocol?:string}|undefined)?.protocol
      let origin: string | undefined
      try { if (protocol === 'http:' || protocol === 'https:') origin = new URL(`${protocol}//${req.headers.host ?? ''}`).origin } catch { /* refuse invalid origin */ }
      if (!origin || req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') { json(res,403,{error:'same_origin_required'}); return }
      if (!/^application\/json(?:\s*;|\s*$)/iu.test(req.headers['content-type'] ?? '')) { json(res,415,{error:'json_required'}); return }
      const chunks: Buffer[] = []; let size=0
      for await (const chunk of req) { const data=Buffer.from(chunk); size+=data.length; if(size>1024){json(res,413,{error:'body_too_large'});return} chunks.push(data) }
      let input: unknown
      try { input=JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { json(res,400,{error:'invalid_json'});return }
      if (!input || typeof input !== 'object' || Array.isArray(input)) { json(res,400,{error:'invalid_decision'}); return }
      const data=input as Record<string,unknown>, keys=Object.keys(data)
      if (!idPattern.test(match[1]!) || typeof data.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(data.digest)
        || (match[2] === 'decide' ? keys.length !== 2 || typeof data.approve !== 'boolean' : keys.length !== 1)) { json(res,400,{error:'invalid_decision'}); return }
      if (match[2] === 'decide') await service.decide(match[1]!,{digest:data.digest,approve:data.approve as boolean})
      else await service.revoke(match[1]!,data.digest)
      json(res,200,{requests:await service.list()})
    } catch { json(res,409,{error:'remote_computer_decision_uncertain'}) }
  }
}
export function registerRemoteComputerRoutes(ctx: Context, local: boolean): void {
  ctx.effect(() => ctx.webServer.register({kind:'prefix',path:PREFIX,handler:remoteComputerHandler(ctx,local)}),'lumo-ui: local remote-computer decisions')
}
