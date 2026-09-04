/**
 * 单机知识库插件 bundle（src → lib/index.js）。
 *
 * 为什么用 tsdown 而不是 transpileModule：src 是跨模块的（index/provider/
 * vault-index/consumer 等 7 个文件），transpileModule 单文件语义搬不动。
 *
 * 两个关键纪律：
 * 1. **不 import 'tsdown'**（与 lumo-ui/tsdown.config.ts 一致）——tsdown 的
 *    config loader 从 config 所在包解析裸标识符，而 tsdown 不在本插件的
 *    node_modules；node: 内置模块允许。
 * 2. **本包必须自包含**：tsdown/rolldown 的 resolver 与 load 边界都不允许相对
 *    引用逃出包目录（root=config 所在包，跨包 `..` 是 UNRESOLVED_IMPORT /
 *    UNLOADABLE_DEPENDENCY）。shared seam-contracts、knowledge consumer 都以
 *    内嵌副本的形式放在 src/（见 consumer.ts / rerank.ts / seam-contracts.ts /
 *    seam-errors.ts 头注释），cordis / schemastery 是运行时单例（DI 身份），
 *    必须保持外部引用（deps.neverBundle）。
 */
export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: (specifier: string) =>
      ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'].includes(specifier),
  },
}
