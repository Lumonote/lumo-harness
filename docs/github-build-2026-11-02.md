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

后续桌面日志显示 Host bundle 成功后，Client 编译仍缺 `session-controller/remote`。隔离快照刻意不复制被覆盖包的整个 lib，因此只检查未覆盖的 workspace-files 会误判投影齐全；Host bundle 阶段并不会重新生成它们，回拷 lib 还会把源树原有投影一起删掉。现检查所有 package exports 声明的 Typert 类型面，并在 Host bundle 之前为源树和快照分别补齐。新增回归用例覆盖「workspace-files 存在，但 session-controller 的 host/remote 面缺失」及产物被删除后的再次检测。

RocketMQ 门禁已在运行 `41405260712` 远端通过；下一项集群探针门禁暴露了 Bash 版本差异：没有 profile 后缀的拓扑会读取未赋值的 local `shape`。现在显式初始化为空串，保留未指定 profile 时采集全部服务的语义。

同次运行的 Host 编译已通过，Typecheck 的 7 条错误来自平台与上游公开接口的版本漂移：团队执行改用 `startActivation`，以 caller delivery 取回结果并保留 activation 的释放所有权；PG KV 补充单条 SQL 原子批量删除；远程子代理自行生成 one-shot 描述、不再返回已移除的 localAgent；认证代理只接受已经绑定的内部监听端口；抓取 provider 使用上游统一 dispatcher，不再传入已移除的 resolver 参数。回归测试覆盖 activation 参数及释放、批量删除的空集/失败/特殊键、未绑定端口和快照投影完整性。

全量单测随后检出 3 条旧夹具/运行入口失败：JSONL 持久化插件已改为命名导出的 apply、子代理服务新增 workingDirectory 依赖、工作流父代理夹具变为异步。夹具随公开接口更新。另一个实际构建缺口是 PTC 的 `process.js` 在包配置中由 `process-entry.js` 重命名，通用再导出会只加载实现、正常退出而不启动控制通道；CI host 准备入口现在使用该包自身 tsdown 配置生成真实 worker bundle。该路径的工作流与两种团队加载顺序的 12 条回归已通过。

全量测试还检出浏览器环境依赖缺失：`client.spec.tsx` 指定 jsdom，但平台的直接依赖和锁文件未包含 jsdom，Vitest 无法启动该 worker。即便其余 1233 条断言全部通过，进程仍以 1 退出，JSON 报告中的 success 不能代表进程成功。现为平台显式声明与上游一致的 jsdom 29.1.1。按用户要求，本地上游已快进到官方 master `ce7073d512`（0.2.2-alpha.2），保留未跟踪的 .omc 文件，后续检查使用 Node 24。

`3653974a` 的平台 CI 已通过类型检查，单测剩余 2 条失败均读取了被 gitignore 排除的 `platform/upstream/skills`。Archify 与 creative-skills 的单元测试现在通过已有 `config.root` 接口读取临时文件，验证 frontmatter 剥离、正文保留、来源 pin 与入库清单一致、资源路径、Lumo 扩展及释放行为；缺失或损坏的技能仍必须报错且不得注册。测试不再依赖开发机预装技能，实际固定提交的获取与完整资源装配仍由桌面安装/打包链验证。

同次桌面日志已完成 DSH Host/Client 构建及 386 包回拷，随后仅在 Lumo UI 报错：上游 InputState 新增 sending，但本地桥类型复制了旧 phase 联合。桥实际只读取 draft，发送及状态判断由上游 inputActions 完成；现用公开 slot 合同的 Pick<input, 'draft'> 定义消费面，避免未消费的枚举字段再次随上游变化而中断构建。

同次 `production-gates` 的 RocketMQ 与集群探针均已通过，剩余失败位于 Corepack pin 门禁：工作流直接执行 git 模式为 100644 的 Python 文件，触发 permission denied；平台 build.sh 已使用 python3 调用同一脚本。CI 现与其保持一致，经 python3 执行检查通过，三个 install 与两个运行入口均固定 pnpm 11.7.0。

## 2026-11-07：平台 CI 缺少原生文件锁模块

`platform-ci` 运行 [42374380844](https://github.com/Lumonote/lumo-harness/actions/runs/42374380844)，提交 `0b932dd`，失败于 Unit tests；其余 Go 与生产门禁 job 均通过。用户日志中的 35 条失败分布在 7 个团队执行、动态 owner 和附件/知识库测试文件，涉及 JSONL 持久化时缺少 `native/system/packages/linux-x64/bin/glibc/system.node`。原生 flock 延迟加载，因此 import 成功或 host TypeScript 构建成功不能证明持久化可用。

上游测试脚本在 Vitest 前执行 `build:native-system`，平台测试直接调用 Vitest，没有经过该步骤。共享的 `build-host.mjs` 现依次准备 Typert/host/lib、通过官方 `build.ts --host-addon-only` 补齐宿主 addon、构建 PTC worker；平台 CI 和集群验收均消费此入口。原有桌面准备入口也复用增强后的检查：从 `prebuilds.json` 选择当前平台与 libc 的 Node-API 文件，校验文件非空，并在编译后再次检查，避免已有 Landlock、另一种 libc 产物或空文件造成误判。Windows 保持原有非 flock 路径。

回归证据：真实构建入口测试修复前 4 失败、2 通过，修复后 6 项全通过；本机完整平台单测 1819 通过、0 失败、313 跳过（未配置数据库等外部依赖的现有门控），类型检查与实际 host 构建通过。Docker Debian 12 / Node 24 的 Linux arm64 环境先复现缺件，再由官方脚本编译真实 addon，验证独占锁、第二 fd 的 EAGAIN，以及关闭首 fd 后重获锁。Linux x64 路径有入口回归覆盖；远端 x64 实际结果以修复提交对应的 Actions 为准。上游源码与锁文件保持干净。

修复提交 `9008360` 的远端运行 [42376294108](https://github.com/Lumonote/lumo-harness/actions/runs/42376294108) 已真实编出 `linux-x64/bin/glibc/system.node`，Typecheck 与完整 Unit tests 通过（1819 通过、313 跳过）。随后独立的数据库门禁首次走到知识库配额用例，暴露平台 job 的服务仍是普通 `postgres:16-alpine`，缺少 `vector.control`，两项知识库测试报 `0A000: extension "vector" is not available`；共享 DDL 的 34 项通过。平台 job 现与 Compose 和恢复演练统一采用 `pgvector/pgvector:pg16`，提供知识库实际依赖的 vector/HNSW，不删除或跳过这些测试。

`a01182e` 的远端运行 [42376830186](https://github.com/Lumonote/lumo-harness/actions/runs/42376830186) 已通过上述数据库门禁，后续归档测试的 7 条失败来自写死的 macOS `/private/tmp` 路径。测试现使用 `node:os.tmpdir()`，并解析真实路径以保留归档拒绝符号链接的契约。真实 Linux Node 24 容器验证由 7 失败转为 12 项全通过，本机同样全通过。独立 PG16 + pgvector 验收中，配额/DDL 36 项、后续治理/恢复 61 项、含真实 PG 的归档 13 项和 Python 恢复演练 13 项均通过；最终 Ubuntu 结果仍由对应修复提交的 Actions 确认。

## 2026-11-07：桌面插件的共享模块漏编译

桌面 release 运行 [42375268299](https://github.com/Lumonote/lumo-harness/actions/runs/42375268299) 在 Vite 构建后、Rust 编译前失败：`@lumo/agent-teams/lib/index.js` 引用的 `../../../shared/session-owners.js` 不存在。原编译步骤只遍历插件 `src/`，而 `transpileModule` 不追踪依赖图；会话 owner 新增的跨目录值导入以及它继续引用的 `session-execution` 因此都没有生成。原缺件检查正确地阻止了不完整产物发包。

现将同一编译步骤抽成 `desktop/packaged-typescript.mjs`，以转译后的 JavaScript AST 追踪相对运行导入与导出，递归编译依赖并重写路径。跨目录模块放入插件自身 `lib/__lumo_runtime__/`，保留插件的 ESM 与裸包依赖解析范围；原 `src → lib` 入口及资源相对路径保持稳定。类型导入由 TypeScript 擦除，不把类型引用的 pg 等依赖带入运行闭包。缺件检查继续执行。

同一真实 TS/Node 回归修复前 4 失败、1 通过；补齐当前源码验收后 12 项通过，包括多层 shared、循环、多行 re-export、字面量动态导入、缺件拒绝、删除测试源码后加载产物，以及实际 `SessionOwnerClient → boundedJSON` 调用。六个实际插件共编译 25 个模块（23 个 src 模块、2 个 shared 模块），桌面相关 46 项通过；完整平台单测 1831 通过、0 失败、313 跳过。该验证覆盖此次失败的 emit 阶段，完整 macOS/Windows 安装包仍需对应 release 运行确认。

## 2026-11-07：调度器首次注册时间的偶发分歧

`de9011a` 的运行 [42377621301](https://github.com/Lumonote/lumo-harness/actions/runs/42377621301) 中，平台 job 已通过全部步骤；剩余 scheduler 集成测试发现初次注册的 `registered_at` 和 `last_seen_at` 偶发相差 1 毫秒。两列分别求值 `clock_timestamp()`，同一 INSERT 内数据库时钟也会前进，因此断言揭示的是实际数据分歧。

`RegisterCluster` 现用物化 CTE 采样一次数据库时钟供两列复用；心跳仅更新 `last_seen_at`、注册时间不可变、读取年龄继续使用实时数据库时钟，共享 `nowMS` 与其他租约语义未变。确定性真实 PG 回归在第一列 domain 赋值时延迟 50ms，旧实现稳定产生不同时间（实测差 56ms），新实现两列相同，且返回年龄仍包含该延迟。带独立 PG16 测试库的 `go test ./... -count=1`（含 integration）与 `go build ./...` 均通过，没有放宽原有断言。

最终平台验收：提交 `024a2f9` 的 [platform-ci 42378487671](https://github.com/Lumonote/lumo-harness/actions/runs/42378487671) 已全部成功，19/19 个 job 通过。Linux x64 / Node 24 实际产出 flock addon；平台单测 1831 通过、313 按现有依赖门控跳过，后续带 PG 的配额/DDL 36 项、治理/恢复 61 项、归档 13 项和 Python 演练 13 项全部通过。所有 Go 模块（含 scheduler 确定性回归）、生产门禁及上游洁净度检查均通过。

## 2026-11-07：dsh-node 启动器的跨目录值依赖

桌面修复 `0c74a27` 的 [release 42378083637](https://github.com/Lumonote/lumo-harness/actions/runs/42378083637) 已通过插件编译、裁剪、官方 Node 下载与 shim 生成，随后被 `assertDshNodeSelfContained` 拦截：启动器新增四个 user-auth 会话配置模块，以及 `shared/nacos-registration` 的值导入，打包目录不包含这些源码。ONNX 原生 binding 的提示已使用 WASM fallback，不是本次退出原因。

启动器现由 `stage-dsh-node.mjs` 使用同一运行依赖闭包编译器暂存：保留 `dsh-node/src/index.ts` 入口作为 `import './index.js'` 的薄 shim，编译后的启动器仍位于原 `src` 深度，跨目录模块放入 `src/__lumo_runtime__/`。macOS/Windows 启动器及 Rust 入口无需变化，`import.meta.url` 的目录语义保持不变，共享类的参数属性在构建时转译。构建继续检查产物中每条相对运行导入是否存在且位于包内，不是删除缺件门禁。

真实运行图为 13 个 src 模块加 8 个跨目录模块，仅使用已打包的 `@lumo/web-fetch-fakeip` 和 Node 内置依赖。旧暂存实现的同一组回归 2 失败、1 通过；修复后启动器与插件回归 15 项全通过。隔离临时 runtime 使用实际 Node `--experimental-strip-types src/index.ts` 加载当前启动器源码的完整静态图，成功到达原有角色校验，没有模块缺失或 TypeScript 参数属性错误。完整平台回归 1834 通过、0 失败、313 按既有门控跳过，类型检查、语法检查和独立审阅通过；完整安装包结果以新 release 运行确认。
