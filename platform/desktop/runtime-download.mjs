import { spawnSync } from 'node:child_process'

/** Match SkillHub's bounded retry policy for transient download failures. */
export function curl(url, destination) {
  const result = spawnSync('curl', [
    '-fsSL', '--retry', '4', '--retry-connrefused', '--retry-delay', '5', '--retry-max-time', '240',
    '--connect-timeout', '20', '--max-time', '300', '-o', destination, url,
  ], { encoding: 'utf8', timeout: 360_000 })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`下载失败：${url}\n${result.stderr || result.error?.message || ''}`.trim())
  }
}
