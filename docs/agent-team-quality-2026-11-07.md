# Agent Team 业务质量评测（2026-11-07）

本批新增一个可接实际执行结果的离线评测面，位于
`platform/dsh-plugins/agent-teams/eval/`。它衡量团队的最终业务交付，保持现有编排、
授权、租约、计量和强制异构审核语义。没有修改 DeepSeek Harness 或插件生产执行代码。

## 语料与隔离

`golden.zh.json` 的 suite 为 `team-business-zh`、revision 1，包含 16 个自包含任务。
这是一组针对平台使用场景设计的评测样例，未声称来自真实客户日志。

| 类别 | 用例 |
| --- | --- |
| 业务任务 8 项 | 订单去重与退款对账、三方发票校验、DAG 关键路径、含审核费的预算准入、政策版本退款、精确 SKU 库存合并、灰度 SLO、跨时区交接 |
| 抗干扰 8 项 | 检索片段注入、迟到旧代报告、缺失验收证据、多数成员自信算错、局部通过而组合失败、业务输入不足、Unicode 相似标识、审核版本不匹配 |

任务同时给出用户目标、带 ID 的来源和严格 JSON 输出合同。三种既有拓扑
`planner-worker`、`pipeline`、`deliberation` 均有建议用例；实际试验可以比较其他拓扑，
但必须记录真实配置。此套件是有限任务上的精确结构化 oracle，不能泛化为开放式写作、
任意仓库修改或全部团队工作质量。

评测方保管含 `expected` 的语料。`tasks` 命令导出时删除 oracle；参与者、协调者、
被测审核者只接导出的任务，不得读取答案。评测器不会发起 LLM 评分或自动决定模型优劣。
新增业务语料应独立校准答案、变更 revision，并重跑数据合同测试；suite 全文 digest
会阻止修改 oracle 后继续混入旧结果。

## 执行与结果导入

从 `platform/dsh-plugins/agent-teams` 执行，使用已有 `tsx` 依赖：

```sh
node --import tsx eval/run-eval.ts validate
node --import tsx eval/run-eval.ts tasks > /private/tmp/team-quality-tasks.json
node --import tsx eval/run-eval.ts template > /private/tmp/team-quality-results.json
node --import tsx eval/run-eval.ts score --results /private/tmp/team-quality-results.json
```

`validate` 只校验语料，输出 `evaluated_trials: 0`。`template` 仅给出空记录封套，
不自动生成完美答案。需要操作人员或可信导出器先执行现有团队流程，再从实际交付、
审核结果与计量台账填入 `runs`。评测器只读 JSON，不调用外部服务、不执行 shell
内容、不读取 evidence reference 指向的路径或 URL。

结果 schema 为 `lumo-team-quality-results/v1`，必须同时绑定 suite ID、revision、
SHA-256 digest。主要字段如下，完整严格类型在 `eval/schema.ts`：

| 字段 | 口径 |
| --- | --- |
| `source` | `fixture` 仅验证评测程序；`recorded` 表示导入的执行观察。两类始终分组，不能合算模型通过率。 |
| `case_id`、`trial_id` | 一条业务任务的一次完整试验，同 source/configuration/case/trial 不能重复。重复试验使用新的 trial ID，不丢弃失败轮次。 |
| `configuration` | 固定 ID、真实拓扑、协调者/成员/审核者各 role/provider/model/preset_revision。审核记录中的模型必须在配置中声明。同一 ID 不得对应不同配置，模型或提示修订应使用新 ID。 |
| `execution` | `completed/failed/cancelled/uncertain` 终态、起止 UTC 毫秒时间戳及执行证据引用；运行中记录不进入终态报告。开始时间包含排队，结束时间包含审核与全部返工。 |
| `submissions` | 从 1 连续编号的业务交付尝试，包含真实 run_id、提交时间、解析后的最终 JSON 与该 JSON 的 digest。失败于交付前可为空；遗漏的内部重试仍必须计入整条试验成本和延迟。 |
| `review` | 可为 null；有记录时必须给出 approve/reject/unavailable、精确交付 digest、审核时间、真实审核模型及证据引用。摘要相同或事后换版不能复用审核。 |
| `cost` | 包含协调者、全部成员、审核、失败与重试的整条台账总额，单位 microUSD 整数；完整台账不可得使用 null。已计量为零可以填 0，但必须有台账证据。 |

时间戳必须精确为 `YYYY-MM-DDTHH:mm:ss.sssZ`，顺序要求开始≤交付≤审核≤下一次交付≤结束。
输入未知字段、负数/小数/不安全整数成本、重复 run_id、错误摘要、未知用例、非有限 JSON、
畸形时间和超限输入都会报错，不会静默修正。CLI 输入限制为 16 MiB、单条答案 32 KiB、
每试验最多 32 次交付、每文件最多 10000 条试验。文件导入失败会退出非零。

`artifact_digest` 使用 `artifactDigest()` 对对象键排序后的 JSON 计算 SHA-256，数组保留
合同顺序。它是评测格式摘要，不能直接当作 Governance manifest digest 或审核回执。
若原始输出不是合法 JSON，不得人工修成正确答案：把原始文本及解析错误放入自定义
错误对象作为 artifact，并保留原始执行证据，oracle 会将其判错；没有交付则不伪造 submission。

真实计量台账当前以 USD 记录，导出时用完整十进制金额换算到 microUSD，不通过不完整
token 数猜价格。精度小于一个 microUSD 时应在整条试验合计后按明示的同一舍入规则换算，
不要逐次舍入后再求和。台账延迟到达时先填 null，补齐后重算。

证据引用仅提供追溯索引，不包含登录凭据、API key 或私有审批 receipt。评测器不鉴别
引用真伪，所以报告固定标记 `imported-observations-not-independently-attested`。
`recorded` 不是供应商成功、计量完整性或生产审核合规的证明；发布结论前仍须复核
原始服务端回执、配置和台账。导入器也必须证明未遗漏失败试验或提交。

## 严格指标

oracle 对最终结构化答案按键序无关、数组顺序有意义的 JSON 全等判断，不使用模型自报
的正确标记、文本长度或自信程度。新增多种合法答案的任务应另行设计明示 oracle，不能
为了让样例通过放宽成模糊子串匹配。

| 指标 | 计算与分母 |
| --- | --- |
| 任务成功率 | 终态 completed 且最终答案 oracle 正确且精确审核 approve 的试验数 / 所有已观察终态试验。failed/cancelled/uncertain、缺审核或审核不可用都不算成功。 |
| 首次交付成功率 | 仅有一次提交且满足上述成功条件 / 所有终态试验。 |
| 误批率 | 错误答案被 approve 的提交数 FP / 已有 approve/reject 决策的错误答案数 (FP+TN)。 |
| 批准中缺陷占比 | FP / 全部 approve 数 (TP+FP)，与误批率是不同分母。 |
| 误拒率 | 正确答案被 reject 的提交数 FN / 已有决策的正确答案数 (TP+FN)。另输出批准 precision/recall 与四格计数。 |
| 审核覆盖率 | approve/reject 提交数 / 所有提交数；null/unavailable 单独计数，不能把审核不可用当正确拒绝。 |
| 返工率 | 提交次数>1的试验数 / 所有试验；额外提交数=sum(max(0,提交次数−1))，另输出每试验均值。内部无交付重试不冒充业务返工。 |
| 成本 | 输出已计量覆盖率和已知合计；只有每条试验成本完整时才输出总额与每成功任务成本。每成功任务成本=全部成功和失败试验总费用 / 成功数。 |
| 延迟 | 分别输出全部终态、业务成功试验的样本数、均值、p50、p95、最大值，单位 ms；百分位用 nearest-rank。失败终止用时保留在全部终态分布。 |

空分母一律为 null，不能显示为 0% 错误或零成本。成本缺失时
`total_known_microusd` 只是已知部分，`total_microusd` 与 `microusd_per_success` 均为 null。
观察成功率只是已执行样本的比率，不是整套语料或生产总体成功率。

报告按 `source × configuration` 隔离，并分别输出业务/抗干扰类别、逐案例试验/成功数、
缺失案例和 `balanced_repetitions`。只有全部用例执行次数相同且大于零才给出均衡重复数。
`observations_digest` 绑定整份已校验输入，便于保留报告与原始观察的对应关系，不代表签名。
比较配置应固定 suite digest、案例、试验次数、预算和计时边界，建议每案例至少三次；
不均衡或部分样本不能直接宣称某个拓扑/模型更好。单个试验应保留过程证据，逐次审核
误批会计入报告，即使后续返工修好也不能抹掉早期误批。

## 本批实测与外部未验收

独立类型检查通过：

```sh
cd platform
node node_modules/typescript/bin/tsc -p dsh-plugins/agent-teams/eval/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run dsh-plugins/agent-teams/__tests__/quality-eval.spec.ts
```

专属回归 **12 PASS / 0 FAIL / 0 SKIP**，验证语料覆盖、oracle 隔离与摘要绑定、严格结果
schema、四种审核混淆格、缺审核/成本、失败费用、返工、百分位、重复/配置漂移、fixture
隔离和 CLI 输入限制。CLI `validate` 已实际读取 16 个用例，报告 `evaluated_trials=0`。
测试中的答案和费用都是明确的 fixture，只能证明数据校验与计算实现。

本批没有调用任何真实模型供应商，没有导入业务客户结果，也没有产生“16项通过”的模型
质量分数。实际供应商/模型/拓扑的任务成功、误批、成本和延迟仍待用上述数据合同导入
真实试验后评估；此前供应商访问拒绝的问题不因本工具而被视为通过。通用平台回归由
根任务最终统一验收，本文件不提前声明整个平台通过。
