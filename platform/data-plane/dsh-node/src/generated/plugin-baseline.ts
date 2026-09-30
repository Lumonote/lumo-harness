/**
 * 本文件由 platform/tools/gen-plugin-baseline.mjs 生成，请勿手工编辑。
 *
 * 真相源：platform/shared/manifests/plugin-baseline.manifest.json
 * 重新生成：pnpm run codegen:plugin-baseline
 * 一致性：platform/shared/manifests/__tests__/plugin-baseline.spec.ts 的漂移锁
 *
 * 为什么是生成物而不是直接 import 清单：dsh-node 用 tsx 直跑源码，打包后的 runtime 里它位于
 * <runtime>/node_modules/@lumo/dsh-node/，按相对路径上溯到的是 node_modules 而非仓库，
 * 运行期读不到 platform/shared/。生成物落在包内、随包复制，运行期一定在。
 */

/** 一条基线插件 pin。 */
export interface BaselinePluginPin {
  /** npm 包名。 */
  name: string
  /** 精确版本；不接受范围写法，桌面构建不得因 registry 上的 tag 移动而改变行为。 */
  version: string
  /** `name@version`，安装时直接使用。 */
  spec: string
  /** 这个插件是什么、为什么钉这个版本。 */
  note: string
}

/** 桌面包固定安装的上游社区插件（顺序 = 清单顺序）。 */
export const BASELINE_PLUGIN_PINS: readonly BaselinePluginPin[] = [
  {
    name: 'dshmarket',
    version: '1.66.6',
    spec: 'dshmarket@1.66.6',
    note: '插件市场：浏览、搜索、安装和更新 DSH 社区插件。客户端依赖 locale、settings 和 theme。',
  },
  {
    name: '@liustack/modlens',
    version: '3.26.5',
    spec: '@liustack/modlens@3.26.5',
    note: '视觉理解：图片读取、OCR 与视觉证据；要求 Node >=22.19。',
  },
  {
    name: 'dsh-context',
    version: '0.60.0',
    spec: 'dsh-context@0.60.0',
    note: '上下文洞察：上下文组成、趋势、注入、压缩与每一步消息。',
  },
  {
    name: 'dsh-cost-meter',
    version: '1.7.45',
    spec: 'dsh-cost-meter@1.7.45',
    note: '费用统计：会话、当日与历史费用，含预算、模型价格与用量；支持 DSH 0.2 的凭证与 home-paths API。',
  },
  {
    name: 'dsh-dream-skin',
    version: '9.29.0',
    spec: 'dsh-dream-skin@9.29.0',
    note: '桌面换肤：主题、壁纸与每用户强调色，使用原生 theme、locale、slots 服务。',
  },
]

/** 曾被考虑但已移出基线的插件。保留是为了防止有人再把它加回来。 */
export const BASELINE_EXCLUDED_PLUGINS: readonly { name: string; reason: string }[] = [
  {
    name: '@anweat/dsh-browser',
    reason: '0.1.10（2026-08-29，最新版）仍 import dsh-settings 已被移除的 installSettingsSection 与 settingsNamespace，master 下无法通过 import 校验，且上游无更新版。已从桌面包基线移除；市场里装到其它 profile 的行为不受影响（那里的 dsh-settings 可能仍是旧 API）。',
  },
  {
    name: '@nanmicoder/dsh-agent-teams',
    reason: '0.1.15 调用了 master 已移除的 ctx.subagents.registerContinuableSetup，Loader 会直接拒绝整树启动。仍可通过 SkillHub 手动安装；dsh-node 的插件隔离会在失败时自动 quarantine 并重试。',
  },
  {
    name: 'dsh-univer-office',
    reason: '0.2.14 曾因只支持 DSH 0.1 的 peerDependencies 在浏览器半边激活失败，导致工作台无法启动，因此移出桌面基线。2026-09-30 查询到的新版本 0.3.5 仍未声明兼容当前 DSH 0.2.0-rc.2，暂不升级外置办公插件，也未授予版本风险豁免。客户端启动现按 Loader 最终状态跳过单个失败或 pending 条目，记录原因并继续挂载可用界面。',
  },
  {
    name: '@linxin666/dsh-client-ui-task-board',
    reason: '0.3.14（原 pin）与 0.3.20 的客户端硬依赖 settingsScope，曾在 Web 装配中一直 pending（waiting for service: settingsScope），因此移出桌面基线。2026-09-30 外置版已更新到 0.4.4，客户端代码已移除该直接依赖；本次没有进行浏览器功能测试，暂未重新纳入基线。客户端启动现按 Loader 最终状态跳过单个未激活插件，保留诊断和重试身份。',
  },
]

/** 首方模块中需要 symlink 进 DSH_HOME/profiles/node_modules 的那部分。 */
export const PACKAGED_FIRST_PARTY_MODULES: readonly string[] = [
  '@deepseek-ai/dsh-storage-sqlite',
  '@lumo/agent-teams',
  '@lumo/dsh-platform-ui',
  '@lumo/knowledge-vault',
  '@lumo/open-design',
  '@lumo/archify',
  '@lumo/creative-skills',
  '@lumo/ruflo-orchestration',
  '@lumo/web-fetch-fakeip',
]

/**
 * 打包 runtime 下需要 symlink 进 DSH_HOME/profiles/node_modules 的完整名单。
 * = 首方名单 + 基线包名。漏一个时 Loader 报 Cannot find package，整棵插件树挂载失败，
 * 因此这里由清单拼装而不是手抄。
 */
export const PACKAGED_PROFILE_MODULES: readonly string[] = [
  ...PACKAGED_FIRST_PARTY_MODULES,
  ...BASELINE_PLUGIN_PINS.map(pin => pin.name),
]
