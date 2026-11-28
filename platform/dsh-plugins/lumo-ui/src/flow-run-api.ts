/** Only the two run operations exposed by the browser BFF. */
export function flowRunTarget(pathname: string, method: string): { path: string; method: string } | { error: string; status: number } | undefined {
  const match = /^\/lumo\/api\/flows\/([^/]+)\/runs\/([^/]+)\/(result|replay)$/u.exec(pathname)
  if (!match) return undefined
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(match[1]!) || !/^[1-9]\d*$/u.test(match[2]!) || match[2]!.length > 19 || BigInt(match[2]!) > 9223372036854775807n) return { error: 'invalid flow/run id', status: 400 }
  const expected = match[3] === 'result' ? 'GET' : 'POST'
  if (method !== expected) return { error: 'method not allowed', status: 405 }
  return { path: `/v1/flows/${match[1]}/runs/${match[2]}/${match[3]}`, method }
}

/** Preserve the durable receipt without exposing an upstream host or arbitrary headers. */
export function flowRunHeaders(path: string, response: Headers): Record<string, string> {
  const match = /^\/v1\/flows\/([A-Za-z0-9._-]{1,128})\/run$/u.exec(path)
  const run = response.get('x-lumo-flow-run')
  return match && run && /^[1-9]\d{0,18}$/u.test(run) && BigInt(run) <= 9223372036854775807n
    ? { 'X-Lumo-Flow-Run': run, Location: `/lumo/api/flows/${match[1]}/runs/${run}/result` } : {}
}
