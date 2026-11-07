import { boundedJSON } from '../../../shared/session-execution.ts'

const failures = {
  session_attachment_invalid: [400, 'Attachment filename or binary metadata is invalid', false],
  session_attachment_unsupported: [415, 'Only supported safe UTF-8 text and image media types are accepted', false],
  session_attachment_too_large: [413, 'Attachment exceeds the upload byte limit', false],
  session_attachment_busy: [429, 'Attachment transfer capacity reached', true],
  session_attachment_denied: [403, 'Attachment ownership or execution lease is unavailable', false],
  session_attachment_unavailable: [503, 'Attachment dependency or integrity verification is unavailable', true],
  session_connector_denied: [403, 'Connector request was refused by current authorization', false],
  session_connector_changed: [409, 'Connector approval changed or expired; review its audit before trying again', false],
  session_connector_busy: [429, 'Connector request capacity reached', true],
  session_connector_unavailable: [503, 'Connector dependency is unavailable', true],
  connector_outcome_unknown: [502, 'Connector external outcome is unknown; do not retry, review its audit', false],
  storage_quota_exceeded: [507, 'Project storage quota exceeded', false],
} as const

export type SessionRequestErrorCode = keyof typeof failures

/** Only fixed, public descriptors cross an HTTP/node boundary. Never accept a
 * downstream message, arbitrary status, or arbitrary Error.code here. */
export class SessionRequestError extends Error {
  readonly status: number
  readonly retryable: boolean
  readonly retryAfter: number
  constructor(readonly code: SessionRequestErrorCode, retryAfter = 2) {
    const [status, message, retryable] = failures[code]
    super(message)
    this.name = 'SessionRequestError'
    this.status = status
    this.retryable = retryable
    this.retryAfter = status === 429 ? Math.min(60, Math.max(1, Math.ceil(Number.isFinite(retryAfter) ? retryAfter : 2))) : 0
  }
}

export function publicSessionRequestError(code: unknown, status: number, retryAfter?: string | null): SessionRequestError | undefined {
  if (typeof code !== 'string' || !Object.hasOwn(failures, code)) return
  const error = new SessionRequestError(code as SessionRequestErrorCode, retryAfter && /^\d{1,9}$/u.test(retryAfter) ? Number(retryAfter) : 2)
  return error.status === status ? error : undefined
}

/** A failed execution response can follow a committed external operation.
 * Its receipt is one-use, so a 5xx or unreadable response must never invite a
 * replay even when a dependency calls the failure "unavailable". */
export async function sessionUpstreamError(response: Response, kind: 'attachment' | 'connector', mayHaveExecuted = false): Promise<SessionRequestError> {
  let code: unknown
  try { const value = await boundedJSON(response, 4096); code = value.error ?? value.code } catch { /* untrusted body is discarded */ }
  const status = response.status
  const prefix = kind === 'attachment' ? 'session_attachment' : 'session_connector'
  if (kind === 'connector' && (code === 'connector_outcome_unknown' || mayHaveExecuted && status >= 500)) return new SessionRequestError('connector_outcome_unknown')
  if (status === 507 && code === 'storage_quota_exceeded') return new SessionRequestError('storage_quota_exceeded')
  if (status === 401 || status === 403 || status === 404) return new SessionRequestError(`${prefix}_denied`)
  if (status === 429) {
    const raw = response.headers.get('retry-after') ?? ''
    return new SessionRequestError(`${prefix}_busy`, /^\d{1,9}$/u.test(raw) ? Number(raw) : 2)
  }
  if (kind === 'attachment' && status === 400) return new SessionRequestError('session_attachment_invalid')
  if (kind === 'attachment' && status === 413) return new SessionRequestError('session_attachment_too_large')
  if (kind === 'attachment' && status === 415) return new SessionRequestError('session_attachment_unsupported')
  if (kind === 'connector' && status === 409) return new SessionRequestError('session_connector_changed')
  return new SessionRequestError(`${prefix}_unavailable`)
}
