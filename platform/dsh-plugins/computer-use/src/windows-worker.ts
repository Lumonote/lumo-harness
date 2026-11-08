/** Runs only under the Windows Job Object supervisor, never in the Host process. */
import { createInterface } from 'node:readline'
import type { CuaDriver as NativeDriver } from '@trycua/cua-driver'

if (process.platform !== 'win32') throw Error('WINDOWS_CUA_PLATFORM_REQUIRED')
const { CuaDriver } = await import('@trycua/cua-driver')
const driver = CuaDriver.create(undefined) as NativeDriver
const send = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
// EOF/Host death is additionally enforced by the native supervisor's parent handle and job.
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
try {
  send({ kind: 'catalog', value: JSON.parse(await driver.listToolsJson()) })
  for await (const line of input) {
    const message: unknown = JSON.parse(line)
    if (message === null || typeof message !== 'object' || Array.isArray(message)) throw Error('INVALID_COMMAND')
    const request = message as { id?: unknown; name?: unknown; args?: unknown }
    if (typeof request.id !== 'string' || typeof request.name !== 'string') throw Error('INVALID_COMMAND')
    try {
      // The parent never treats a cancelled UniFFI Future as quiet. It terminates and joins this job.
      const result = await driver.callTool(request.name, JSON.stringify(request.args))
      send({ kind: 'result', id: request.id, value: JSON.parse(result.rawJson) })
    } catch { throw Error('WINDOWS_CUA_CALL_FAILED') }
  }
} finally {
  input.close()
  await driver.shutdown()
  driver.uniffiDestroy()
}
