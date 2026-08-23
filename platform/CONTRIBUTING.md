# platform/ 开发约定

## 第一铁律（最高优先，无例外）

**`deepseek-harness/` 只读。** 本仓库内的所有平台代码通过 dsh **公开扩展面**实现：

- Cordis 插件（独立 npm 包，import `@deepseek-ai/cordis` 公开 API）
- `ctx.*` 注册 service / event / seam provider
- `cordis.patch.yml` 配置覆盖
- preset / `isolate` realm 组合
- dsh 作为依赖引入（**绝不 fork / vendor / monkey-patch**）

合规复查（每个任务完成前必须执行）：

```sh
git -C deepseek-harness describe --tags --dirty   # 必须打印 dsh-v0.1.1-rc.2 无 -dirty
git -C deepseek-harness status --porcelain -uno   # 必须无输出
```

## 同引擎不同拓扑（铁律 21）

- Local-lite：PG（含 pgvector）+ 进程内队列/缓存 + 本地文件。**不承诺迁移**。
- Standalone / Cluster：与集群完全相同的引擎。
- 缺失能力**显式拒绝**（`CapabilityUnavailable`），严禁静默模拟。
- 业务代码**禁止** `if (standalone)` 分支；差异只允许存在于装配层与部署清单。

## 开发

```sh
pnpm install                       # workspace 内安装
pnpm run test                      # vitest 单元测试
pnpm run typecheck                 # tsc 严格模式
```

- ESLM，相对导入带上 `.ts` 后缀。
- 每个 seam 必须配契约测试（`platform/shared/seam-contracts/`），Local 与 Standalone Provider 双向通过。
