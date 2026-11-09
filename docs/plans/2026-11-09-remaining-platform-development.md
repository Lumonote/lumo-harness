# 剩余平台开发实施计划

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 按当前复核优先级补齐发布、附件容量、桌面发行、业务评测、生产验收、Go CI、体积与 UI 工程能力。

**Architecture:** 所有能力通过 platform 的插件、服务、工具和部署层实现，deepseek-harness 源码与锁文件保持只读。可独立开发的模块并行准备，按下列顺序集成；实机、真实供应商、IdP、KMS 和证书不足时完成可运行入口并记录实际阻塞，不使用模拟结果宣称外部验收通过。

**Tech Stack:** GitHub Actions、Go/PostgreSQL、TypeScript/Vitest、Node、Python、Tauri。

**交付状态（2026-11-10）：** 八项实现已集成，完成本地活依赖、浏览器及工具回归；
真实模型、正式签名/安装、多主机生产演练和 GitHub hosted run 仍按实际条件验收。
结果与边界见[交付记录](../platform-development-delivery-2026-11-09.md)。

---

### Task 1：正式发布门禁与可追溯性

- 修改 `.github/workflows/{ci,release,cluster-acceptance}.yml`：基础 CI 可复用且成为 tag 发布依赖，同次发行只解析一次上游 SHA。
- 保持日常 master 兼容检查；记录构建使用的 platform/upstream 身份。
- 新增工作流合同正反例，验证失败依赖不能发布、SHA 不漂移；本地解析与回归后集成。

### Task 2：附件容量与保留合同

- 修改 Session-control 附件 store/server、共享合同、user-auth 附件客户端与页面。
- 区分可选择附件容量与保留历史，解决退役后永久耗尽 100 项配额；保持历史读取、分支、检查点与迁移完整性。
- 增加容量事实和明确错误；引用权威不足的共享对象不物理删除。
- 真实 PG 验证并发上传/退役、达到上限、历史/分支/迁移及配额不错误释放。

### Task 3：桌面正式发行与原生验收

- 增加 Mac Developer ID 签名、公证、staple 和验证入口，正式发行缺凭据失败。
- 保留既有 CUA 原生验收，补齐安装版验收说明与可核对证据。
- 本机做契约/失败路径验证；真实签名安装和交互设备分别记录，不以 fixture 替代。

### Task 4：业务质量基线与回归门禁

- 扩展 `platform/dsh-plugins/agent-teams/eval/` 的真实观察导入与配置比较，校验覆盖、重复次数、成本和审核。
- 提供可重复执行/导出入口，oracle 不进入参与者上下文；fixture 与真实记录严格分离。
- 加入基线阈值及失败报告，真实模型调用仅使用实际可用配置；无真实结果不生成质量通过结论。

### Task 5：生产验证矩阵与 Provider 适配入口

- 扩展 deploy 的生产验收证据合同，明确独立主机/卷、分区、HA/PITR、RPO/RTO、流量恢复、IdP/KMS 证据。
- 接入现有恢复 Provider 协议，支持目标适配和结果核对；危险操作仍遵守真实范围、审批与执行合同。
- 对缺项、过期、错误目标和不确定结果做失败验证；不向生产注入故障或销毁租户密钥。

### Task 6：Go CI 实际执行证据

- 核对所有活依赖变量，接通可供给的 Redis/S3/RMQ；JSON 报告按必验集合拒绝 skip/空报告/重复终态。
- 关键并发模块 race，精选夜间验收也验证结构化结果；允许“包无测试”与真实用例跳过明确区分。

### Task 7：安装体积与复制去重

- 每个平台生成总字节、文件数、组件、安装器关联和 budget 报告。
- 安全保留包内可重定位相对 Python 链接；验证包外链接与 Windows 行为。
- 保持现有原生依赖过滤与功能，PPT 图标归档/能力按需交付须有实际消费和完整性支持后落地。

### Task 8：UI 模块化与真实交互回归

- 按领域逐步抽取前端入口中的独立模块，保持已验证的请求隔离与冲突恢复。
- 添加真实浏览器关键流程、窄屏和键盘验收入口及必要的可访问性修复。
- 先记录 bundle/加载数据再决定按需加载；不把代码行数直接视为性能故障。

### 最终集成

- 逐模块运行必要回归、TypeScript、Go build/vet/race、工作流与脚本校验。
- 运行环境可用时执行全平台活依赖套件；汇总 PASS/FAIL/SKIP 和未运行项目。
- 更新中文交付文档与当前能力索引，清理错误过期注释。
- `git diff --check`、主仓状态及上游 pristine 检查；保留所有变更供用户审阅。
