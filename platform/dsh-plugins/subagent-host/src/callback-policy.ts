import { invalid } from '../../../shared/seam-contracts/errors.ts'

const CALLBACK_PATH = /^\/subagent\/result\/([A-Za-z0-9._:-]{1,128})\/([A-Za-z0-9._:-]{16,128})$/u

export function normalizeCallbackOrigins(values: readonly string[]): ReadonlySet<string> {
  if (values.length === 0) {
    throw new Error('subagent-host: callbackOrigins 不能为空；承载节点不得向任意请求目标回调')
  }
  const origins = new Set<string>()
  for (const value of values) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error(`subagent-host: callbackOrigins 含非法 URL: ${JSON.stringify(value)}`)
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== ''
      || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new Error(`subagent-host: callbackOrigins 只接受无凭证、无路径的 http(s) origin: ${JSON.stringify(value)}`)
    }
    origins.add(url.origin)
  }
  return origins
}

export function assertAllowedCallback(urlValue: string, childId: string, origins: ReadonlySet<string>): void {
  let url: URL
  try {
    url = new URL(urlValue)
  } catch {
    throw invalid('subagent-host: callbackUrl 不是合法绝对 URL')
  }
  if (!origins.has(url.origin)) {
    throw invalid('subagent-host: callbackUrl origin 不在承载节点允许列表')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw invalid('subagent-host: callbackUrl 不得包含凭证、查询参数或片段')
  }
  const match = CALLBACK_PATH.exec(url.pathname)
  if (match === null || match[1] !== childId) {
    throw invalid('subagent-host: callbackUrl 必须是与 childId 同核的回执路径')
  }
}
