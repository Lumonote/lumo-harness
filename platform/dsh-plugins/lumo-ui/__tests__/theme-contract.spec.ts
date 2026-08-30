import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(fileURLToPath(new URL('../src/client/lumo.css', import.meta.url)), 'utf8')

describe('Lumo plugin theme contract', () => {
  it('consumes shared DSW tokens with a safe neutral fallback', () => {
    expect(stylesheet).toContain('--dsw-alias-brand-primary')
    expect(stylesheet).toContain('--dsw-specific-sidebar-fill')
    expect(stylesheet).toContain(':root, .lumo-click-spark')
    expect(stylesheet).toContain('--lumo-accent-80')
  })

  it('does not reintroduce the former green product accent', () => {
    expect(stylesheet).not.toContain('#42c8a6')
    expect(stylesheet).not.toContain('#43c8a5')
    expect(stylesheet).not.toContain('rgba(114, 227, 196')
    expect(stylesheet).not.toContain('#f1fffc')
  })
})
