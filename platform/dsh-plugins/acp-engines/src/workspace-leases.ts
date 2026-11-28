import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** A physical workspace has one execution owner, even when reached through a symlink. */
export class WorkspaceLeases {
  private readonly leases = new Map<string, { owner: string; count: number }>()
  private key(cwd: string): string { try { return realpathSync(cwd) } catch { return resolve(cwd) } }
  busy(cwd: string, owner?: string): boolean {
    const lease = this.leases.get(this.key(cwd))
    return !!lease && lease.owner !== owner
  }
  reserve(cwd: string, owner: string): () => void {
    const key = this.key(cwd), current = this.leases.get(key)
    if (current && current.owner !== owner) throw new Error('此工作区正在执行其他对话，请等待完成或先停止')
    const lease = current ?? { owner, count: 0 }
    lease.count++; this.leases.set(key, lease)
    let released = false
    return () => {
      if (released) return
      released = true
      if (--lease.count === 0 && this.leases.get(key) === lease) this.leases.delete(key)
    }
  }
}
