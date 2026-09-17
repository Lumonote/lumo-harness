import { defaultExclude, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.spec.{ts,tsx}'],
    // `.build/deepseek-harness` 是覆盖层暂存的上游副本（见 dsh-overrides/prepare-runtime.mjs）。
    // 它带着上游自己的 939 个用例，且 node_modules 是软链回源树的 —— 在平台的 vitest
    // 配置下跑必然大面积失败。上游用例归上游跑，平台套件只管 platform 自己的代码。
    exclude: [...defaultExclude, '.build/**'],
    environment: 'node',
    // 活库 spec 的 DSN 名字归一：把统一的 `LUMO_TEST_PG_DSN` 兜底成各子系统名
    // （`SESSION_LOG_TEST_DSN` 等）。没有这一步，只设统一 DSN 会让这些 spec 静默
    // 跳过而验收链仍打印「通过」——理由见 vitest.setup.ts。
    setupFiles: ['./vitest.setup.ts'],
  },
})
