/**
 * 节点间 mTLS 文件配置（dsh-node 侧镜像，**仅类型面**）。
 *
 * 权威定义：platform/shared/seam-contracts/mtls.ts —— 那份还带
 * assertMutualTLSFileConfig / readMutualTLSFiles 等运行时校验，改契约先改它。
 *
 * 为什么镜像而不是相对导入：dsh-node 在打包 runtime 里是以 .ts 源码被 tsx 直接
 * 加载的（tauri.conf.json 把 target/lumo-runtime 映射到 Resources/runtime），
 * `../../../shared/...` 会落到 Resources/ 下——那里没有 shared。今天这条是
 * `import type`，tsx 会擦除所以侥幸不炸；但一旦有人把它改成值导入（引一个校验
 * 函数），打包态就会以 ERR_MODULE_NOT_FOUND 在启动时崩掉，与 worker-binding.ts
 * 那次同因。这里只镜像数据平面真正用到的类型，运行时校验仍由权威模块承担。
 */

export interface MutualTLSFileConfig {
  /** PEM CA bundle that validates the peer certificate chain. */
  caFile: string
  /** PEM certificate chain for this node. */
  certFile: string
  /** PEM private key for this node; must be mounted read-only by deployment. */
  keyFile: string
  /** Optional expected DNS name; clients otherwise use the endpoint hostname. */
  serverName?: string
  /** Secret volume rotation check cadence; defaults to 30 seconds, minimum 1 second. */
  reloadIntervalMs?: number
}
