# GitHub 构建失败分析与 Superagent 默认插件

失败运行：[release #47](https://github.com/Lumonote/lumo-harness/actions/runs/41276171863)，主项目提交 `280d3da`。

三个桌面目标均在 `beforeBuildCommand → build-runtime.mjs → prepare-runtime.mjs → applyLumoDshOverrides` 失败，未进入 Rust 编译。直接原因是 `WorkspaceBrowser.tsx` 的 section header 从 `css.sectionHeader` 改为含搜索间距动画的 `clsx(...)`，覆盖层的逐字锚点已不匹配。原生依赖降级警告与 runner 排队提示不是这次退出原因。

对 CI 同代干净上游源码做完整诊断后还发现第二处失配：`stream-server.ts` 的 `socket.send` 增加了压缩选项对象。第一处错误会遮住第二处。补丁现保留上游原有 header 类名和 send 参数，只插入自己的控件与 flush 超时。

深层原因是 CI 每次拉取上游 `master`，而本地 checkout 停在较旧提交；本地锚点测试与远端构建没有使用同一份源码。新增无依赖兼容性预检，在 release 安装 Rust/Python 之前、CI 安装上游依赖之前一次报告全部锚点失配。回归用例同时覆盖旧 header、新动画 header 和带压缩参数的 send。未知布局仍报错，不静默漏掉产品功能。

Superagent 加入同一份默认插件基线：`dsh-superagent@0.1.0`，官方源码提交 `6337fc823ce20251c8de8085948165c81aaa701e`。该包标记 private，未提供可直接使用的 npm 发布产物，因此构建时从固定提交安装锁定依赖并编译 host/client，随后只安装生产依赖。桌面包包含产物与生产闭包，首次启动无需下载或编译。

Web profile 默认配置持久化状态目录 `<DSH_HOME>/profiles/web/superagent`；可用 `LUMO_SUPERAGENT_STATE_DIR` 指定其他目录。首次启动在 Superagent 面板配置仓库、专用 GitHub CLI 账号和策略，未配置前保持等待设置。上游原型使用 POSIX 路径、shell shim 与 Web 服务，因此 Windows 和 headless 默认安装但停用宿主条目。Feishu 仍按上游默认关闭。

GitHub Actions 最终验证结果以修复提交对应的远端运行记录为准。

## 平台 CI 后续失败（运行 41403261552）

该运行是 `platform-ci`，提交 `34057a88`。`Build upstream dsh host outputs` 仍直接执行 4 GiB 的 `tsc -b`，没有先生成 Typert 投影，因此出现大量 `*/remote` 模块缺失及 `ClientRemote` 成员缺失的级联错误，随后在约 4 GiB 处 V8 堆耗尽，退出码 134。CI 现改为调用 `dsh-overrides/build-host.mjs`，复用桌面构建的 `ensureLibEntriesReexport`：先 Typert、再 8 GiB host 编译、最后合成 lib 入口。构建前后均检查上游源码洁净度。

同次运行的 `production-gates` 失败在 RocketMQ 入口顺序检查。替身脚本放在临时 `bin` 并加入 PATH，但运行入口时仍位于仓库根；macOS 的 `/bin/sh` 会搜索 PATH，Ubuntu 的 dash 对 `sh mqnamesrv` 则从当前目录打开文件。检查脚本现先进入临时 `bin` 再启动入口，复现真实容器的工作目录。topic 必须先于 proxy 的生产契约保持原样，反例与失败路径检查继续执行。
