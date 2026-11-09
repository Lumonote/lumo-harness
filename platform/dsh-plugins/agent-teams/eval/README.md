# Agent Team 业务质量离线评测

本工具消费已执行的团队试验记录，计算业务结果、审核错误、返工、成本和延迟。
它不调用供应商，不替代 Governance 的认证、异构审核或业务完成门禁。
协议与完整操作说明见 [交付文档](../../../../docs/agent-team-quality-2026-11-07.md)。

从 `platform/dsh-plugins/agent-teams` 执行：

```sh
node --import tsx eval/run-eval.ts validate
node --import tsx eval/run-eval.ts tasks > /private/tmp/team-quality-tasks.json
node --import tsx eval/run-eval.ts template > /private/tmp/team-quality-results.json
# 填入实际执行/审核/用量台账后，再计算报告：
node --import tsx eval/run-eval.ts score --results /private/tmp/team-quality-results.json
```

`golden.zh.json` 包含 oracle，只交给评测方；参与者和审核者只使用 `tasks` 导出。
16 项自包含用例分为 8 项业务和 8 项抗干扰，覆盖三个既有拓扑。不要把读取 oracle
后填入的答案标成真实模型执行，也不要把 `validate` 的用例数当作模型通过数。

`schema.ts` 是严格运行时数据合同；`metrics.ts` 是计算口径；`run-eval.ts` 只读本地 JSON
并输出 JSON。自定义语料使用 `--suite path`，结果必须精确绑定 suite revision 和 digest。

```sh
node --import tsx eval/run-eval.ts validate --suite /path/to/suite.json
node --import tsx eval/run-eval.ts score --suite /path/to/suite.json --results /path/to/observations.json
```

## 基线比较与发布质量门禁

`gate` 从原始观察重新校验并计算，拒绝 fixture 充当真实记录、缺案例、重复不均衡、
成本不完整、配置摘要变化和缺失基线。失败仍输出完整 JSON，退出码为 2；输入错误为 1。
通过只表示导入记录满足策略，原始回执与台账的真实性仍需评测方核对。

```sh
node --import tsx eval/run-eval.ts gate --results /path/to/candidate.json \
  --policy /path/to/policy.json --baseline /path/to/baseline.json > /path/to/gate.json
```

策略须由评测负责人按业务设定，不提供冒充真实质量承诺的默认阈值。`configuration_digest`
使用 `artifactDigest(configuration)`，固定拓扑、模型、角色与 preset revision。例：

```json
{
  "schema_version": "lumo-team-quality-policy/v1",
  "suite_digest": "填写语料的64位SHA256",
  "configuration_id": "candidate-v2",
  "configuration_digest": "填写候选配置的64位SHA256",
  "min_repetitions": 3,
  "min_success_rate": 0.9,
  "max_defective_approval_fraction": 0,
  "max_rework_rate": 0.2,
  "max_p95_ms": 120000,
  "max_microusd_per_success": 1000000,
  "baseline": {
    "configuration_id": "baseline-v1",
    "configuration_digest": "填写基线配置的64位SHA256",
    "max_success_rate_drop": 0,
    "max_cost_ratio": 1.1,
    "max_latency_ratio": 1.1
  }
}
```

首次建基线时设 `baseline: null` 并省略 `--baseline`。后续比较要求同一 suite digest、
逐案例相同试验数和完整成本；审核误批按“所有批准中的错误比例”约束，避免错误答案样本
为零时把未知误批率显示为 0。所有失败、取消、不确定状态和返工费用继续进入统计。
报告包含策略、观察和基线观察摘要，可与安装包版本关联归档。未执行真实模型时不发布质量分数。
