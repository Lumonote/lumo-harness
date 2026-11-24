# dsh 兼容矩阵

Lumo Harness 不 fork、不修改 dsh（第一铁律）。为了让发布可以复现，正式发版、CI 和手动验收都**钉在一个不可变的 dsh commit 上**，只有夜间的 `cluster-acceptance`（schedule 触发）会跟着 `master` 跑，用来提前发现兼容问题。

- 唯一的钉版来源：[`platform/dsh-pin.json`](../platform/dsh-pin.json)
- 解析与升级入口：[`platform/tools/resolve-upstream-ref.mjs`](../platform/tools/resolve-upstream-ref.mjs)
- 发版产物会记录实际使用的上游 SHA：`source-evidence/upstream-commit.txt`、`dsh-commit.txt`

## 矩阵

| Lumo Harness | dsh tag | dsh commit | 验证状态 | 已知问题 |
|---|---|---|---|---|
| 1.2.3（2026-11-19）/ 当前 dev | `dsh-v0.2.3-alpha.2` | `4b399c39a6d1479cd84ca591b4d7c88e24d38a96` | ⚠️ 部分验证：这是本地 checkout 的 HEAD，等于 2026-11-24 的 `origin/master`；本次只跑了 `platform/tools` 的发布契约测试，全量 tsc/vitest、overlay 锚点检查和 CI 都还没在这个 pin 上跑过 | 1.2.3 已经适配过 `webserver/entry-url`、`ctx.root` 注入和 `dsh-host-authentication-token` 的变化，但全量 tsc/vitest 当时没有全绿（见 CHANGELOG 1.2.3） |
| ≤1.2.2 | 跟随 `master`（没有钉版） | 不可考 | — | 2026-10：本地停在 `dsh-v0.2.1-alpha.1`，CI 拉到的 master 改了 `stream-server.ts`，导致 Windows 打包时锚点失配 |

验证状态的含义：✅ 全量 CI、集群验收和桌面打包都通过；⚠️ 部分验证；❌ 已知不兼容。

## 升级流程（bump）

```sh
# 1. 拿到候选 commit（上游 master，或某个 dsh-v* tag 对应的 SHA）
node platform/tools/resolve-upstream-ref.mjs --latest
git -C deepseek-harness fetch --tags && git -C deepseek-harness checkout <sha>
# 2. 只读兼容检查，再跑平台测试
node platform/dsh-overrides/check-compatibility.mjs deepseek-harness
corepack pnpm -C deepseek-harness install && corepack pnpm -C deepseek-harness run build
corepack pnpm -C platform typecheck   # 以 platform/package.json 实际脚本为准
corepack pnpm -C platform test
# 3. 改写 pin，在上面的矩阵里加一行，然后提 PR（CI 会在新的 pin 上跑）
node platform/tools/resolve-upstream-ref.mjs --bump <sha> <tag>
# 4. 确认 dsh 树是干净的
git -C deepseek-harness status --porcelain -uno     # 必须没有输出
```

想临时用某个 commit 跑 CI：手动触发 workflow，在 `upstream_ref` 里填 `master` 或完整的 40 位 SHA。
