/** Validate authorization facts before presenting them as editable authority. */
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
export function validActionCatalog(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => isRecord(item) && typeof item.action === 'string' && Boolean(item.action) && typeof item.name === 'string' && typeof item.description === 'string')
    && new Set(value.map(item => item.action)).size === value.length
}
export function validActionDecisions(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(item => isRecord(item) && typeof item.allowed === 'boolean' && typeof item.explicit_deny === 'boolean' && isStringList(item.matched_policies))
}
export function responseStatus(reason: unknown): number | undefined {
  return isRecord(reason) && typeof reason.status === 'number' ? reason.status : undefined
}
export const authorityDenied = (reason: unknown): boolean => responseStatus(reason) === 401 || responseStatus(reason) === 403
