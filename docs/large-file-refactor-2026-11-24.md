# 三处超标入口的拆分记录

> 2026-11-25 复查：本文件末尾的类型检查失败属于 11 月 24 日历史状态；11 月 25 日审计时服务端和客户端类型检查均已通过。后续修改及验证以 [本轮修复记录](plans/2026-11-25-audit-reliability-fixes.md) 为准。

| 文件（相对 `platform/`） | 本次开始时（字节） | 原守卫记录 | 拆分后（字节） |
|---|---:|---:|---:|
| `desktop/src/pet.rs` | 62,937 | 62,874 | 57,591 |
| `dsh-plugins/lumo-ui/src/index.ts` | 179,226 | 176,589 | 169,510 |
| `dsh-plugins/lumo-ui/src/client/index.tsx` | 289,194 | 288,508 | 283,105 |

桌宠保留原工作区的 `pet_acp.rs` 启动适配；请求、附件校验和相应单测迁入 `pet/request.rs`。服务端将资料文件的校验、文本提取、分块和外部可见字段移入 `library-document.ts`。客户端把技能名称、提供方和描述映射移入 `client/skill-labels.ts`。路由、公开组件和 Tauri 命令入口未改名。

工作台回归同时补齐了现有 ACP 面板与桌宠约定的事件及存储键；引擎列表响应无效时显示不可用，运行树无快照时仍可从已知任务打开执行详情。

守卫上限仍是 60 KiB（61,440 字节）。桌宠已移出例外清单；两个 UI 入口仍是存量大文件，其基线已向下收紧，并非都低于 60 KiB。复查可从仓库根目录运行 `node platform/tools/guards/run.mjs --only file-size`。

桌宠测试可在未生成打包资源时运行 `TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --manifest-path platform/desktop/Cargo.toml pet::`。工作台相应的 Vitest 用例为 `client.spec.tsx`、`surface-api.spec.ts`、`knowledge-library-mutations-api.spec.ts` 和 `acp-session-panel.spec.ts`。

本次验证：桌宠 14 个测试通过；上述工作台用例加 `run-tree-panel.spec.tsx`、`dual-plugins` 共 63 个测试通过。`lumo-ui` 全量类型检查仍有改动前已出现的跨包 `rootDir` 和运行树类型错误，不属于已通过项。
