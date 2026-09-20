import { describe, expect, it } from 'vitest'

import {
  AllowlistClassifier,
  classifyByAllowlist,
  releaseClassifierOf,
  type ClassifierRules,
} from '../src/classifier.ts'
import { DEFAULT_TOOL_FACTS, toolRelease } from '../src/release.ts'
import { classifyAction } from '../../../shared/seam-contracts/coordinator.ts'

/**
 * §24.5 分类器的**落地形态**测试（`src/classifier.ts`）。
 *
 * 这份用例要证明的不是「名单判得准」，而是四件与安全有关的事：
 *
 *   1. **默认装配不改变既有行为**——没配就没有分类器（`releaseClassifierOf(undefined)`）；
 *   2. **它不能放宽**——命中名单也翻不动 OPA 的否，也翻不动工具事实给出的 DENY；
 *   3. **它只会说 allow / review**——没有第三个值，配置错误（空名单、空前缀）在装配时炸；
 *   4. **它坏掉时是 fail-closed**——抛错落 `classifier-unavailable`，不是「判定为危险」。
 *
 * 第 2 条的用例写在这里而不是 `coordinator.spec.ts`：那里测的是**规则顺序**，
 * 这里测的是「一个具体实现有没有绕过那条规则」——同一个性质的两个不同证法。
 */

const RULES: ClassifierRules = { allowPrefixes: ['write', 'connector_'] }

describe('§24.5 名单判据（纯函数）', () => {
  it('命中前缀即 allow，未命中一律 review', () => {
    expect(classifyByAllowlist('write', RULES.allowPrefixes)).toBe('allow')
    expect(classifyByAllowlist('connector_github', RULES.allowPrefixes)).toBe('allow')
    expect(classifyByAllowlist('bash', RULES.allowPrefixes)).toBe('review')
    expect(classifyByAllowlist('', RULES.allowPrefixes)).toBe('review')
  })

  it('返回值只有两个值，永远没有 deny', () => {
    // 拒绝由事实与 OPA 给出，不由判定器给出——这条在类型上成立（返回值是两个字面量），
    // 这里把它钉成运行时断言，免得将来有人「顺手」加第三个。
    for (const tool of ['write', 'bash', 'connector_x', 'read', '']) {
      expect(['allow', 'review']).toContain(classifyByAllowlist(tool, RULES.allowPrefixes))
    }
  })

  it('空前缀会匹配一切工具名 —— 所以名单校验必须拦住它', () => {
    // 这条断言记录的是**危险的形状本身**：它解释下面为什么要在构造时炸掉空名单。
    expect(classifyByAllowlist('anything_at_all', [''])).toBe('allow')
  })

  it('前缀匹配宽的那一侧是安全侧：近似串多要一次人审，不会漏放', () => {
    expect(classifyByAllowlist('writer', RULES.allowPrefixes)).toBe('allow')
    expect(classifyByAllowlist('readwrite', RULES.allowPrefixes)).toBe('review')
  })
})

describe('§24.5 AllowlistClassifier —— 装配期就把配置错误炸掉', () => {
  it('可用的名单：available 恒 true，判定只来自判据函数', () => {
    const classifier = new AllowlistClassifier(RULES)
    expect(classifier.available()).toBe(true)
    expect(classifier.verdict('write')).toBe('allow')
    expect(classifier.verdict('bash')).toBe('review')
  })

  it('空名单直接抛 —— 「永远 review 的分类器」会把故障伪装成判定', () => {
    expect(() => new AllowlistClassifier({ allowPrefixes: [] })).toThrow()
  })

  it('空前缀直接抛 —— 它等于放行全部副作用工具', () => {
    for (const blank of ['', '   ']) {
      expect(() => new AllowlistClassifier({ allowPrefixes: ['write', blank] })).toThrow()
    }
  })

  it('名单在构造时被复制：外部数组后来的改动不影响已装配的判定器', () => {
    // 否则一个「运行期改了配置对象」的调用点会静默改写放行策略——这类放宽没有任何记录。
    const mutable: string[] = ['write']
    const classifier = new AllowlistClassifier({ allowPrefixes: mutable })
    mutable.push('bash')
    expect(classifier.verdict('bash')).toBe('review')
  })
})

describe('§24.5 releaseClassifierOf —— 默认装配下不改变既有行为', () => {
  it('没配就没有分类器（这正是「与接线前逐字节一致」的全部内容）', () => {
    expect(releaseClassifierOf(undefined)).toBeUndefined()
  })

  it('配了就有分类器', () => {
    expect(releaseClassifierOf(RULES)).toBeInstanceOf(AllowlistClassifier)
  })
})

describe('§24.5 装进闸门后：只收窄，不放宽', () => {
  it('名单命中 → 只读档下放行（AUTO / classifier-allow）', async () => {
    const release = await toolRelease('paused', 'write', new AllowlistClassifier(RULES))
    expect(release).toEqual({ allow: true, band: 'AUTO', reason: 'classifier-allow' })
  })

  it('未命中 → 进人审队列（REVIEW / classifier-review），不是拒绝', async () => {
    const release = await toolRelease('paused', 'bash', new AllowlistClassifier(RULES))
    expect(release.allow).toBe(false)
    expect(release.band).toBe('REVIEW')
    expect(release.reason).toBe('classifier-review')
  })

  it('工具事实给出的 DENY，分类器说 allow 也翻不动', async () => {
    const classifier = new AllowlistClassifier(RULES)
    const irreversible = await toolRelease('paused', 'write', classifier, {
      ...DEFAULT_TOOL_FACTS, reversible: false,
    })
    expect(irreversible).toMatchObject({ allow: false, reason: 'irreversible' })

    const crossRealm = await toolRelease('paused', 'write', classifier, {
      ...DEFAULT_TOOL_FACTS, crossRealm: true,
    })
    expect(crossRealm.reason).toBe('cross-realm')

    const credentials = await toolRelease('paused', 'write', classifier, {
      ...DEFAULT_TOOL_FACTS, touchesCredentials: true,
    })
    expect(credentials.reason).toBe('credentials')
  })

  it('OPA 判否时分类器的 allow 不产生任何影响（判定域在 OPA 之后）', () => {
    // 闸门传给判据的 `opaAllowed` 恒为 true（那一层没有第二份 OPA 输入，见 release.ts），
    // 所以这一条只能在契约层验证：它是「分类器不能翻 OPA」这条不变量的证法，
    // 而分类器的实现再怎么换，都改变不了 `classifyAction` 里的规则顺序。
    const decision = classifyAction({
      sideEffect: true, reversible: true, crossRealm: false, touchesCredentials: false,
      opaAllowed: false, classifierAvailable: true, classifierVerdict: 'allow',
    })
    expect(decision).toEqual({ band: 'DENY', reason: 'opa-denied' })
  })

  it('running 档与只读工具根本不会走到分类器（装配了也不多判一次）', async () => {
    const classifier = new AllowlistClassifier(RULES)
    expect(await toolRelease('running', 'bash', classifier)).toMatchObject({ band: null, reason: 'state-running' })
    expect(await toolRelease('paused', 'read', classifier)).toMatchObject({ band: null, reason: 'read-only-tool' })
  })

  it('判定器抛错 → fail-closed 落「不可用」，不是「判定为危险」', async () => {
    const broken = new (class extends AllowlistClassifier {
      override verdict(): 'allow' | 'review' {
        throw new Error('classifier impl blew up')
      }
    })(RULES)
    const release = await toolRelease('paused', 'write', broken)
    expect(release.allow).toBe(false)
    expect(release.reason).toBe('classifier-unavailable')
  })
})
