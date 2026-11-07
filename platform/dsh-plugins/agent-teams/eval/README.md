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
