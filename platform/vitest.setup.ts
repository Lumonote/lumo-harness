/**
 * 活库 spec 的 DSN 名字归一（vitest setupFiles，每个测试文件之前执行一次）。
 *
 * **为什么需要**：本仓库同时存在两套「指向一个可供测试的 PG」的变量名——
 *
 *   - `LUMO_TEST_PG_DSN`：全部 Go 侧（scheduler / governance / flows / projects /
 *     registry / connector-gateway / llm-gateway / usage-ledger / collaborator）与
 *     `deploy/acceptance-cluster.sh` 的统一入口；
 *   - `<SUBSYSTEM>_TEST_DSN`：dsh-plugins 侧各活库 spec 自己发明的
 *     `SESSION_LOG_TEST_DSN` / `METERING_TEST_DSN` / `JOB_CONTROL_TEST_DSN` /
 *     `STORAGE_TEST_DSN`。
 *
 * 两套名字并存时，操作者只设 `LUMO_TEST_PG_DSN` 会让后者**整组静默跳过**：`it.skip`
 * 让 vitest 退出码保持 0，报告里只是「skipped」。于是 `acceptance-cluster.sh` 的
 * 「真 PG 会话恢复 / fencing」这一步会在**零个活体用例**的情况下打印「通过」——而这
 * 正是集群验收要拿的证据（`session-log/__tests__/pg-log.spec.ts` 的 fencing 拒旧写者、
 * (session,seq) 主键分叉探测、至少一次投递的幂等吸收）。证据凭空消失比测试变红更坏。
 *
 * **修法**：把统一 DSN 补成各子系统名的**兜底**。显式设了子系统名就用子系统名（仍然
 * 支持「只把这个子系统指到另一个库」），否则回落到统一 DSN。
 *
 * **边界**：只补不覆盖；不解析、不探测、不校验 DSN 指向哪里——那是操作者的责任。
 * 这里也不打印任何东西：setupFiles 每个测试文件跑一次，打印会污染报告；「这一步到底
 * 跑了几个活体用例」由 `acceptance-cluster.sh` 的活体用例计数守卫负责。
 */

/** 与 `LUMO_TEST_PG_DSN` 等价的子系统级别名（顺序即文档顺序）。 */
const PG_DSN_ALIASES = [
  'SESSION_LOG_TEST_DSN',
  'METERING_TEST_DSN',
  'JOB_CONTROL_TEST_DSN',
  'STORAGE_TEST_DSN',
] as const

const canonical = process.env['LUMO_TEST_PG_DSN']

if (canonical) {
  for (const alias of PG_DSN_ALIASES) {
    // 用真值判断而不是 `??=`：`export X=` 会留下空串，而 spec 侧一律按真值决定是否跳过，
    // 空串必须视同未设置，否则别名补了等于没补。
    if (!process.env[alias]) {
      process.env[alias] = canonical
    }
  }
}
