import { defaultExclude, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.spec.{ts,tsx}'],
    // `.build/deepseek-harness` 是覆盖层暂存的上游副本（见 dsh-overrides/prepare-runtime.mjs）。
    // 它带着上游自己的 939 个用例，且 node_modules 是软链回源树的 —— 在平台的 vitest
    // 配置下跑必然大面积失败。上游用例归上游跑，平台套件只管 platform 自己的代码。
    exclude: [...defaultExclude, '.build/**'],
    environment: 'node',
  },
})
