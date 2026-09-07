import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Hold a cross-process lock until release, process exit, or a handled signal. */
export function acquireBuildLock(directory) {
  mkdirSync(dirname(directory), { recursive: true })
  try {
    mkdirSync(directory)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let owner = '进程信息尚未写入'
    try {
      owner = readFileSync(join(directory, 'owner.txt'), 'utf8').trim()
    } catch (readError) {
      // mkdir publishes the lock before its owner information is written.
      if (readError.code !== 'ENOENT') throw readError
    }
    throw new Error(`桌面 runtime 构建锁已被占用（${owner}）：${directory}。请等待现有构建结束；若构建曾被强制终止，请确认已无构建进程后删除此锁目录再重试。`)
  }

  let released = false
  const signals = new Map([
    ['SIGINT', () => process.exit(130)],
    ['SIGTERM', () => process.exit(143)],
    ['SIGHUP', () => process.exit(129)],
  ])
  const release = () => {
    if (released) return
    rmSync(directory, { recursive: true, force: true })
    released = true
    process.removeListener('exit', release)
    for (const [signal, handler] of signals) process.removeListener(signal, handler)
  }
  try {
    writeFileSync(join(directory, 'owner.txt'), `PID ${process.pid}, started ${new Date().toISOString()}\n`)
  } catch (error) {
    release()
    throw error
  }
  process.once('exit', release)
  for (const [signal, handler] of signals) process.once(signal, handler)
  return release
}
