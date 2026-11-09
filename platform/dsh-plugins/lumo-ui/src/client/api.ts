/** One HTTP/error contract shared by workbench surfaces. */

export function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body !== '') return body
  if (typeof body === 'object' && body !== null) {
    const value = (body as { error?: unknown; message?: unknown }).error ?? (body as { message?: unknown }).message
    if (typeof value === 'string' && value !== '') return value
  }
  return fallback
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown, fallback: string) {
    super(errorMessage(body, fallback))
    this.name = 'ApiError'
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, {
    ...init,
    headers,
  })
  const text = await response.text()
  let body: unknown = null
  try { body = text === '' ? null : JSON.parse(text) } catch { body = text }
  if (!response.ok) throw new ApiError(response.status, body, `请求失败 (${response.status})`)
  return body as T
}

export async function apiText(path: string): Promise<string> {
  const response = await fetch(path, { headers: { Accept: 'text/plain' } })
  const text = await response.text()
  if (!response.ok) {
    let detail = text
    try { const body = JSON.parse(text) as unknown; detail = errorMessage(body, `请求失败 (${response.status})`) } catch { /* keep plain error body */ }
    throw new ApiError(response.status, detail, `请求失败 (${response.status})`)
  }
  return text
}

export async function apiBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(path, { headers: { Accept: 'application/pdf, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })
  if (!response.ok) {
    const text = await response.text()
    let detail: unknown = text
    try { detail = JSON.parse(text) as unknown } catch { /* keep plain error body */ }
    throw new ApiError(response.status, detail, `请求失败 (${response.status})`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

export function encodeHeaderJSON(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary)
}

export type OptionalApiResult<T> = { data: T; state: 'ok' | 'forbidden' | 'unsupported' | 'unavailable' | 'error'; error?: string }

export async function optionalApi<T>(path: string, fallback: T): Promise<OptionalApiResult<T>> {
  try { return { data: await api<T>(path), state: 'ok' } } catch (reason) {
    const error = reason instanceof Error ? reason.message : String(reason)
    const status = reason instanceof ApiError ? reason.status : 0
    const state = status === 401 || status === 403 ? 'forbidden' : status === 501 ? 'unsupported' : status === 502 || status === 503 || status === 504 ? 'unavailable' : 'error'
    return { data: fallback, state, error }
  }
}
