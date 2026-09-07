import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireBuildLock } from '../build-lock.mjs'

const roots: string[] = []
const releases: Array<() => void> = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function lockPath() {
  const root = mkdtempSync(join(tmpdir(), 'lumo-build-lock-'))
  roots.push(root)
  return join(root, '.build', 'desktop-runtime.lock')
}

const moduleUrl = new URL('../build-lock.mjs', import.meta.url).href
const childSource = (path: string) => `import { acquireBuildLock } from ${JSON.stringify(moduleUrl)}; acquireBuildLock(${JSON.stringify(path)});`

describe('desktop build lock', () => {
  it('rejects another process without changing the owner, then allows a new build', () => {
    const path = lockPath()
    const release = acquireBuildLock(path)
    releases.push(release)
    const owner = readFileSync(join(path, 'owner.txt'), 'utf8')
    const contender = spawnSync(process.execPath, ['--input-type=module', '-e', childSource(path)], { encoding: 'utf8' })
    expect(contender.status).toBe(1)
    expect(contender.stderr).toContain(`PID ${process.pid}`)
    expect(readFileSync(join(path, 'owner.txt'), 'utf8')).toBe(owner)

    release()
    const next = acquireBuildLock(path)
    releases.push(next)
    release()
    expect(existsSync(path)).toBe(true)
  })

  it.each(['', 'throw new Error("build failed")'])('releases on process exit: %s', (ending) => {
    const path = lockPath()
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', childSource(path) + ending], { encoding: 'utf8' })
    expect(result.status).toBe(ending ? 1 : 0)
    expect(existsSync(path)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('releases on an interrupt', async () => {
    const path = lockPath()
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource(path) + 'console.log("ready"); setInterval(() => {}, 1000);'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    try {
      await once(child.stdout!, 'data')
      child.kill('SIGINT')
      expect((await exited)[0]).toBe(130)
      expect(existsSync(path)).toBe(false)
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
  })

  it('does not remove a lock whose owner has not finished writing metadata', () => {
    const path = lockPath()
    mkdirSync(path, { recursive: true })
    expect(() => acquireBuildLock(path)).toThrow('构建锁已被占用')
    expect(existsSync(path)).toBe(true)
  })
})
