import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverSkillDemos, resolveSkillDemoAsset } from '../src/skill-demos.ts'

describe('skill demos', () => {
  let root: string
  let skill: string
  let outside: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lumo-skill-demos-'))
    skill = join(root, 'ppt-master')
    outside = join(root, 'secret.svg')
    mkdirSync(join(skill, 'templates', 'decks', '中国电信', 'templates'), { recursive: true })
    mkdirSync(join(skill, 'templates', 'decks', '无封面'), { recursive: true })
    mkdirSync(join(skill, 'examples'), { recursive: true })
    mkdirSync(join(skill, 'assets'), { recursive: true })
    writeFileSync(join(skill, 'templates', 'decks', 'decks_index.json'), JSON.stringify({
      '中国电信': { summary: '克制的红灰品牌视觉', canvas_format: 'ppt169' },
      '无封面': { summary: '缺少封面，不应出现' },
      '../escape': { summary: '越界名称' },
    }))
    writeFileSync(join(skill, 'templates', 'decks', '中国电信', 'templates', '01_cover.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(skill, 'examples', 'dataflow-product-analytics.html'), '<!doctype html><title>demo</title>')
    writeFileSync(join(skill, 'examples', 'notes.json'), '{}')
    writeFileSync(join(skill, 'assets', 'city-life-system-map.png'), 'png')
    writeFileSync(join(skill, 'assets', 'README.md'), '# assets')
    writeFileSync(outside, '<svg/>')
    symlinkSync(outside, join(skill, 'assets', 'leak.svg'))
  })

  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('discovers deck covers, html examples and image assets in source order', () => {
    const demos = discoverSkillDemos('ppt-master', skill)
    expect(demos.map(demo => [demo.id, demo.kind, demo.path])).toEqual([
      ['ppt-master:deck:中国电信', 'image', 'templates/decks/中国电信/templates/01_cover.svg'],
      ['ppt-master:example:dataflow-product-analytics.html', 'html', 'examples/dataflow-product-analytics.html'],
      ['ppt-master:asset:city-life-system-map.png', 'image', 'assets/city-life-system-map.png'],
    ])
    // 符号链接在发现阶段就被丢弃（Dirent.isFile 对链接为 false），资源出口再做第二道 realpath 校验。
    expect(demos[0]!.title).toBe('中国电信')
    expect(demos[0]!.summary).toBe('克制的红灰品牌视觉')
    expect(demos[1]!.title).toBe('dataflow product analytics')
  })

  it('returns nothing for a missing or empty directory', () => {
    expect(discoverSkillDemos('gone', join(root, 'missing'))).toEqual([])
    mkdirSync(join(root, 'empty'))
    expect(discoverSkillDemos('empty', join(root, 'empty'))).toEqual([])
  })

  it('serves only whitelisted files that really live inside the skill directory', () => {
    const cover = resolveSkillDemoAsset(skill, 'templates/decks/中国电信/templates/01_cover.svg')
    expect(cover?.contentType).toBe('image/svg+xml')
    expect(cover?.file.endsWith('01_cover.svg')).toBe(true)
    expect(resolveSkillDemoAsset(skill, 'examples/dataflow-product-analytics.html')?.contentType).toBe('text/html; charset=utf-8')

    expect(resolveSkillDemoAsset(skill, '../secret.svg')).toBeUndefined()
    expect(resolveSkillDemoAsset(skill, 'assets/leak.svg')).toBeUndefined()
    expect(resolveSkillDemoAsset(skill, 'assets/README.md')).toBeUndefined()
    expect(resolveSkillDemoAsset(skill, 'templates/decks/decks_index.json')).toBeUndefined()
    expect(resolveSkillDemoAsset(skill, 'assets')).toBeUndefined()
    expect(resolveSkillDemoAsset(skill, '')).toBeUndefined()
    expect(resolveSkillDemoAsset(skill, 'assets/nope.png')).toBeUndefined()
  })
})
