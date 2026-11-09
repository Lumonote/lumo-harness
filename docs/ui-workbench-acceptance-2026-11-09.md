# 工作台模块与浏览器验收

客户端入口按账户、资料库、工具目录拆分；请求、导航、共享视图、类型和焦点约束分别保留独立模块。
现有 ModuleLoader 继续消费单个 CJS bundle。本次没有引入其未支持的动态分块加载。

## 可运行入口

`platform/tools/ui-acceptance.mjs` 在 Chromium 中检查工具目录、资料库、项目运营和用户中心，
覆盖 1440×1000 与 390×844 视口边界、横向溢出、Tab/Shift+Tab、命令菜单空搜索、Esc、
打开者焦点恢复，以及资料来源读取失败后刷新的恢复。

工具只允许同源 GET/HEAD/OPTIONS；写入或跨源请求会被拦截并使验收失败。
它对一次资料来源 GET 在浏览器内注入 503，随后允许刷新抵达选定服务，不修改服务端配置。
需要当前权限下可读取的部署、现有登录 storage state 和独立的新证据目录：

```sh
LUMO_PLAYWRIGHT_MODULE=/absolute/path/node_modules/playwright/index.mjs \
  node platform/tools/ui-acceptance.mjs \
  --base-url https://your-lumo.example/ \
  --storage-state /absolute/path/private-storage-state.json \
  --output /absolute/path/new-ui-evidence
```

Playwright 及匹配的 Chromium 需预先安装；也可从平台依赖解析 `playwright`。
默认使用可见浏览器，自动化环境可显式加 `--headless`。storage state 包含登录凭据，
不应提交到仓库。截图和 `report.json` 输出到新目录，已有目录直接拒绝，避免遗留 PASS 混入失败运行。

隔离源码回归先运行以下命令，使用其输出的随机本机 URL 执行上面的验收命令，测试结束后停止进程：

```sh
node platform/tools/ui-acceptance-fixture.mjs
```

也可用一个进程启动、验收并关闭 fixture，成功和失败都会关闭服务：

```sh
LUMO_PLAYWRIGHT_MODULE=/absolute/path/node_modules/playwright/index.mjs \
  node platform/tools/ui-acceptance-fixture.mjs \
  --output /absolute/path/new-source-ui-evidence --headless
```

CI 可将 `playwright@1.58.2` 安装在独立临时 prefix，使用该包的 `cli.js install --with-deps chromium`
安装匹配浏览器，再将 `LUMO_PLAYWRIGHT_MODULE` 指向同一包的 `index.mjs`。
此版本匹配 Chromium revision 1208（145.0.7632.6）；不要混用系统缓存中另一版 Playwright 的浏览器路径。

fixture 使用真实工作台源码、样式和 React，在本机提供固定只读 API 数据。
响应标识会将报告环境记为 `isolated-source-fixture`；PDF/Excel 预览边界为替身。
部署验收和隔离源码结果不能互相替代，也不覆盖写操作、真实模型、原生电脑操作或文档渲染。

## 本次验证

2026-11-09 的可见 Chromium 源码 fixture 运行完成 10 项检查，全部通过；
未出现页面未处理异常、写入尝试、跨源请求或横向溢出。
本机证据位于 `/private/tmp/lumo-ui-finish-acceptance-20261109-r2/`，临时目录不作为持久发布附件。
同版本的单命令 headless fixture 随后也完成 10 项检查，全部通过，报告位于
`/private/tmp/lumo-ui-finish-headless-20261109/report.json`；该结果来自本机 macOS，尚不是 GitHub Ubuntu runner 执行证明。
桌面与 UI 专属回归共 93 文件、898 项通过，0 失败、0 跳过；客户端 TypeScript 和 Host/Client bundle 构建通过。

同一构建配置测得客户端 bundle 从 1,346,640 字节变为 1,347,970 字节（+0.10%），
gzip 从 261,590 变为 263,525 字节（+0.74%）；入口从 4,436 行减为 3,255 行。
本次改善模块边界与交互约束，尚未得到网络加载时间或运行时性能改善的测量结论。
