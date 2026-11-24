# 工程守卫（tools/guards）

纯 Node、零依赖的静态检查，借鉴 gugu `scripts/*-check.mjs`。在 `platform/` 下运行：

```bash
pnpm guard                 # 跑全部守卫，有 error 退出码 1（warning 不影响）
pnpm guard -- --only css-vars,file-size
pnpm guard -- --verbose    # 展开全部告警
pnpm guard:baseline        # 按当前代码重写 baselines/*.json（需评审 diff）
pnpm test:guards           # node --test 守卫自测
```

| 守卫 | 级别 | 规则 | baseline |
|---|---|---|---|
| file-size | error | .ts/.tsx/.js/.mjs/.go/.css/.rs 单文件 ≤ 60 KiB；存量超大文件只许变小 | `baselines/file-size.json`：文件→字节数 |
| dsh-boundary | error | 禁止相对路径进入 `deepseek-harness/`、禁止深引 `@deepseek-ai/<pkg>/{src,lib,dist,internal,test(s),node_modules}`；CI 中 `deepseek-harness/` 检出不得有改动 | `baselines/dsh-boundary.json`：文件→允许的越界次数（只降不升） |
| no-backup-files | error | 仓库内禁止 `*.bak*`、`*.orig[N]`、`*.rej`、`*~` | 无 |
| css-vars | error | CSS 中 `var(--lumo-*)` 必须在 `lumo.css` 定义 | `baselines/css-vars.json`：`runtimeVars`（由 style 注入，人工登记）、`legacy`（存量缺失，只删不加） |
| migrations-append-only | error | `deploy/migrations` 已登记迁移 sha256 不可变、不可删；新迁移编号必须大于最大已登记编号且不重复 | `baselines/migrations-append-only.json`：文件→sha256 |
| hardcoded-colors | warning | `dsh-plugins/**`、`console/**` 的 .tsx（非测试）字符串里写死 #hex/rgb()/hsl() | 无 |

**更新 baseline**：拆小文件、清理越界引用或新增迁移后运行 `pnpm guard:baseline`，与代码一起提交；
评审时 baseline 中数字只应变小、迁移只应新增条目。禁止用它“放行”变大的文件或被改动的旧迁移。
