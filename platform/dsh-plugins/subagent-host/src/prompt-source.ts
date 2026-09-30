import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/** Operator-installed prompt; the governance preset names it but cannot supply its contents or path. */
export interface PromptSource {
  ref: string
  file: string
}

const MAX_PROMPT_BYTES = 64 * 1024

export async function loadPromptReference(ref: string | undefined, source: PromptSource | undefined): Promise<string | undefined> {
  if (ref === undefined || ref === '') return undefined
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 256 || !source || source.ref !== ref ||
      !isAbsolute(source.file)) {
    throw new Error('worker preset prompt reference has no matching protected file on this node')
  }
  const file = await open(source.file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_PROMPT_BYTES || (stat.mode & 0o022) !== 0) {
      throw new Error('worker preset prompt file must be a nonempty, protected regular file within 64 KiB')
    }
    const bytes = await file.readFile()
    if (bytes.length < 1 || bytes.length > MAX_PROMPT_BYTES) throw new Error('worker preset prompt exceeds 64 KiB')
    const prompt = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!prompt.trim()) throw new Error('worker preset prompt file is blank')
    return prompt
  } finally {
    await file.close()
  }
}
