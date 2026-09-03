import { describe, expect, it, vi } from 'vitest'
import {
  allowedAssetUrl, createUpstreamDemoService, OPEN_DESIGN_README_URL, parseOpenDesignShowcase, parsePptMasterExamples, proxiedAssetUrl,
} from '../src/upstream-demos.ts'

const manifest = {
  version: 1,
  projects: [
    {
      id: 'ppt169_pritzker_2026_quick', title: 'Pritzker 2026 (Quick)', description: '2026 普利兹克大师季 — 8 座新作深读', icon: '🏛️',
      style: 'editorial', styleName: 'Architecture Editorial', tags: ['Architecture', 'Quick Generate'], folder: 'ppt169_pritzker_2026_quick/svg_final', cover: '02_timeline.svg',
      slides: [
        { file: '01_cover.svg', title: 'cover', desc: '2026 普利兹克奖大师季' },
        { file: '02_timeline.svg', title: 'timeline', desc: '一年之内，八座大师新作接连揭幕' },
        { file: '../escape.svg', title: 'bad' },
      ],
      pptx: 'examples/ppt169_pritzker_2026_quick/exports/pritzker_2026_quick.pptx',
    },
    { id: 'ppt169_what_is_ppt', title: '什么是 PPT', style: 'general', slides: [{ file: '01_封面.svg', title: '封面' }], pptxNative: 'examples/ppt169_what_is_ppt/exports/native.pptx' },
    { id: 'empty', title: '没有页面', slides: [] },
    { id: '../evil', title: '越界', slides: [{ file: 'a.svg' }] },
  ],
}

const readme = `# OpenDesign

## 产品速览

<img src="../../docs/screenshots/product-tour/home.png" alt="Home" />

## 演示

四大核心产品类别，全部由笔记本电脑上运行的编码 Agent 渲染。点击缩略图查看实际示例。

### 1 · 原型——Web · 桌面 · 移动端

默认输出面。读取你的 \`DESIGN.md\` 并在沙箱 iframe 中渲染的单页 HTML 工件。

<table>
<tr>
<td width="50%" valign="top">
<img src="../../docs/screenshots/skills/dating-web.png" alt="Web 原型 dating-web" /><br/>
<sub><b>Web 原型</b>——带滚动条、KPI、图表的编辑类仪表盘。直接从 <code>design-templates/dating-web/</code> 渲染。</sub>
</td>
<td width="50%" valign="top">
<img src="../../docs/screenshots/skills/gamified-app.png" alt="游戏化应用" /><br/>
<sub><b>移动端应用原型</b>——三屏游戏化流程。</sub>
</td>
</tr>
</table>

### 4 · 图片——\`gpt-image-2\`、ImageRouter、自定义 API

<table>
<tr>
<td width="20%" valign="top"><img src="https://cms-assets.youmind.com/media/a.jpg" alt="城市美食地图插画" /><br/><sub><b>城市美食地图插画</b><br/>手绘编辑风格旅行海报</sub></td>
<td width="20%" valign="top"><img src="https://evil.example.com/x.jpg" alt="不在白名单" /><br/><sub><b>坏图</b></sub></td>
</tr>
</table>

### 6 · 没有图片的小节

只有文字。

## 为什么选择 OpenDesign

<img src="../../docs/screenshots/after.png" alt="不属于演示" />
`

describe('upstream demo galleries', () => {
  it('turns the PPT Master manifest into full-deck collections behind the same-origin proxy', () => {
    const collections = parsePptMasterExamples(manifest)
    expect(collections.map(item => item.id)).toEqual(['ppt169_pritzker_2026_quick', 'ppt169_what_is_ppt'])
    const [pritzker, what] = collections
    expect(pritzker!.category).toBe('Architecture Editorial')
    expect(pritzker!.tags).toEqual(['editorial', 'Architecture', 'Quick Generate'])
    expect(pritzker!.pages.map(page => page.title)).toEqual(['timeline', 'cover'])
    expect(pritzker!.pages[0]!.url).toBe(proxiedAssetUrl('https://hugohe3.github.io/ppt-master-examples/examples/ppt169_pritzker_2026_quick/svg_final/02_timeline.svg'))
    expect(pritzker!.cover).toBe(proxiedAssetUrl('https://hugohe3.github.io/ppt-master-examples/examples/_thumbs/ppt169_pritzker_2026_quick.webp'))
    expect(pritzker!.downloads).toEqual([{ label: '下载 PPTX', url: 'https://hugohe3.github.io/ppt-master-examples/examples/ppt169_pritzker_2026_quick/exports/pritzker_2026_quick.pptx' }])
    expect(what!.category).toBe('general')
    expect(what!.pages[0]!.url).toContain(encodeURIComponent('svg_final/01_%E5%B0%81%E9%9D%A2.svg'))
    expect(what!.downloads[0]!.label).toBe('下载原生图表 / 表格版 PPTX')
    expect(parsePptMasterExamples({ nope: true })).toEqual([])
  })

  it('reads only the 演示 chapter of the OpenDesign README and keeps whitelisted screenshots', () => {
    const collections = parseOpenDesignShowcase(readme)
    expect(collections.map(item => item.title)).toEqual(['原型——Web · 桌面 · 移动端', '图片——`gpt-image-2`、ImageRouter、自定义 API'.replace(/`/gu, '')])
    const [prototype, images] = collections
    expect(prototype!.description).toBe('默认输出面。读取你的 DESIGN.md 并在沙箱 iframe 中渲染的单页 HTML 工件。')
    expect(prototype!.pages).toEqual([
      { title: 'Web 原型', description: '带滚动条、KPI、图表的编辑类仪表盘。直接从 design-templates/dating-web/ 渲染。', url: proxiedAssetUrl('https://raw.githubusercontent.com/nexu-io/open-design/main/docs/screenshots/skills/dating-web.png') },
      { title: '移动端应用原型', description: '三屏游戏化流程。', url: proxiedAssetUrl('https://raw.githubusercontent.com/nexu-io/open-design/main/docs/screenshots/skills/gamified-app.png') },
    ])
    expect(images!.pages.map(page => page.title)).toEqual(['城市美食地图插画'])
    expect(images!.pages[0]!.description).toBe('手绘编辑风格旅行海报')
    expect(parseOpenDesignShowcase('# nothing here')).toEqual([])
  })

  it('only proxies https assets from the allow-list', () => {
    expect(allowedAssetUrl('https://hugohe3.github.io/ppt-master-examples/examples/a.svg')?.hostname).toBe('hugohe3.github.io')
    expect(allowedAssetUrl('http://hugohe3.github.io/a.svg')).toBeUndefined()
    expect(allowedAssetUrl('https://user:pw@raw.githubusercontent.com/x.png')).toBeUndefined()
    expect(allowedAssetUrl('https://evil.example.com/x.png')).toBeUndefined()
    expect(allowedAssetUrl('not a url')).toBeUndefined()
  })

  it('caches galleries, falls back to stale data and refuses oversized or non-image assets', async () => {
    let clock = 1_000
    let failManifest = false
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('examples/examples.json')) {
        if (failManifest) return new Response('nope', { status: 503 })
        return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === OPEN_DESIGN_README_URL) return new Response(readme, { status: 200, headers: { 'content-type': 'text/plain' } })
      if (url.endsWith('.webp')) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/webp' } })
      if (url.endsWith('.html')) return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      if (url.endsWith('huge.png')) return new Response(new Uint8Array(16), { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024 * 1024) } })
      return new Response('missing', { status: 404 })
    })
    const service = createUpstreamDemoService({ fetch: fetchImpl as unknown as typeof fetch, now: () => clock })

    const first = await service.gallery('ppt-master')
    expect(first.available).toBe(true)
    if (first.available) expect(first.gallery.collections).toHaveLength(2)
    await service.gallery('ppt-master')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock += 11 * 60 * 1000
    failManifest = true
    const stale = await service.gallery('ppt-master')
    expect(stale.available).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const design = await service.gallery('open-design')
    expect(design.available).toBe(true)
    if (design.available) expect(design.gallery.source).toContain('README.zh-CN.md')

    const fresh = createUpstreamDemoService({ fetch: fetchImpl as unknown as typeof fetch, now: () => clock })
    const unavailable = await fresh.gallery('ppt-master')
    expect(unavailable).toEqual({ available: false, skill: 'ppt-master', error: expect.stringContaining('503') })

    const thumb = await service.asset(new URL('https://hugohe3.github.io/ppt-master-examples/examples/_thumbs/a.webp'))
    expect(thumb?.contentType).toBe('image/webp')
    expect([...thumb!.body]).toEqual([1, 2, 3])
    await service.asset(new URL('https://hugohe3.github.io/ppt-master-examples/examples/_thumbs/a.webp'))
    expect(fetchImpl.mock.calls.filter(call => String(call[0]).endsWith('a.webp'))).toHaveLength(1)
    expect(await service.asset(new URL('https://hugohe3.github.io/x.html'))).toBeUndefined()
    expect(await service.asset(new URL('https://hugohe3.github.io/huge.png'))).toBeUndefined()
    expect(await service.asset(new URL('https://hugohe3.github.io/missing.png'))).toBeUndefined()
  })
})
