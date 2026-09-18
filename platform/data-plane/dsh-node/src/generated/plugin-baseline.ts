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
    version: '1.41.0',
    spec: 'dshmarket@1.41.0',
    note: '插件市场：浏览、搜索、安装和更新 DSH 社区插件。原钉 1.36.0，因 dsh-settings 0.1.2 移除旧 API 后在运行期 import 失败，随 master 升到 1.41.0。',
  },
  {
    name: '@liustack/modlens',
    version: '3.25.2',
    spec: '@liustack/modlens@3.25.2',
    note: '视觉理解：把图片、截图与附件转换成可追溯的视觉证据，为纯文本编码 agent 提供视觉桥接。',
  },
  {
    name: 'dsh-context',
    version: '0.41.3',
    spec: 'dsh-context@0.41.3',
    note: '上下文洞察：上下文组成、趋势、注入、压缩与每一步消息。原钉 0.38.1，与 dshmarket 同一原因随 master 升到 0.41.3。',
  },
  {
    name: 'dsh-cost-meter',
    version: '1.7.29',
    spec: 'dsh-cost-meter@1.7.29',
    note: '费用统计：会话、当日与历史费用，含预算、模型价格与用量。原钉 1.6.7，因 dsh e459e32637（2026-09-15，perf(typert): materialize generated schemas on first use）把 strict codec 由 `schema` 改成懒物化的 `create()` 工厂，1.6.7 的 16 处 codec 仍是旧形状，被 dsh-typert-loader 的 validateTypertManifest 在启动期拒绝；该拒绝会让 typert 注册面整体回滚，症状表现为 session/list 等端点「定义已撤回」、其余插件连带「未激活」，随 master 升到 1.7.29。',
  },
  {
    name: 'dsh-dream-skin',
    version: '8.30.1',
    spec: 'dsh-dream-skin@8.30.1',
    note: '桌面换肤：8 套 iOS / Linear 式清透冷调主题加弥散光壁纸，每用户可调强调色。纯原生 --dsw-* token 实现，经其 cordis.patch.yml 在 Web 壳激活。',
  },
  {
    name: '@linxin666/dsh-client-ui-task-board',
    version: '0.3.14',
    spec: '@linxin666/dsh-client-ui-task-board@0.3.14',
    note: '任务看板：dsh web GUI 的 Host 权威任务台帐，替换 Lumo 左侧菜单原「自动化」入口。',
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
    reason: '0.2.14（2026-09-18，最新版）的 peerDependencies 只声明 dsh-attachment/session/settings/llm/tools/skill 的 0.1.1-rc.2 || 0.1.2-rc.1，而 runtime 实际随 master 走 0.1.6-alpha.2（四个 alpha 代差）。失效发生在**浏览器半边**：它的 dsh.client 半边在 web 启动期激活失败，boot 页停在「web boot: 1 entry did not activate / dsh-univer-office: failed」，整块工作台打不开。这类失效构建期查不出来（只有真的在浏览器里装配才会撞上），上游也没有适配版本，故先从桌面基线移除；市场仍可自行安装（那里可以钉与插件同龄的 dsh）。2026-09-18 起客户端启动已改为尽力而为（apply.mjs 的 LUMO_BEST_EFFORT_BOOT），同类插件再坏只会被跳过并告警，不会再拖垮工作台。',
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
