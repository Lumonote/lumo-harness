# CI 与正式发布合同

正式 `v*` tag 必须是规范语义版本，并与 `platform/package.json`、桌面 Tauri 版本、Chart version/appVersion 四处相同；错误标签在构建前失败。通过后只解析一次 upstream `master` 的完整 Git SHA。基础 CI、集群验收和三种桌面安装器均使用该 SHA；任一基础检查、集群验收或桌面构建失败，发布 job 都不会执行。普通 push/PR 与夜间集群工作流继续验证最新 `master`，不将上游长期冻结。

## 正式桌面凭据

GitHub Actions 的正式 tag 构建要求以下配置，缺失时失败，不回落到 ad-hoc：

| 配置 | 类型 | 内容 |
| --- | --- | --- |
| `LUMO_MACOS_SIGNING_P12` | Secret | Developer ID Application 证书及私钥的 P12，单行 base64 |
| `LUMO_MACOS_SIGNING_P12_PASSWORD` | Secret | P12 密码 |
| `LUMO_MACOS_SIGNING_IDENTITY` | Secret | `Developer ID Application: 名称 (TEAMID)` |
| `LUMO_MACOS_NOTARY_API_KEY` | Secret | App Store Connect `.p8` 正文，保留换行 |
| `LUMO_MACOS_NOTARY_KEY_ID` | Secret | App Store Connect Key ID |
| `LUMO_MACOS_NOTARY_ISSUER` | Secret | App Store Connect Issuer UUID |
| `LUMO_WINDOWS_SIGNING_PFX` | Secret | Windows Code Signing 证书及私钥的 PFX，单行 base64 |
| `LUMO_WINDOWS_SIGNING_PFX_PASSWORD` | Secret | PFX 密码 |
| `LUMO_WINDOWS_TIMESTAMP_URL` | Repository variable | RFC 3161 时间戳 HTTP(S) 服务 |

`prepare-release-signing.mjs` 在 runner 临时目录创建隔离 Keychain 或导入 `CurrentUser\My`。P12/PFX 密码由子进程环境读取，不写入命令参数；`.p8` 只通过私有临时文件提供。原始文件在 setup 的 finally 中删除，构建后的 always 步骤删除 Keychain/证书。工具错误不回显可能含凭据的输出。

Windows 先以 `EphemeralKeySet` 解析 PFX，拒绝预存同指纹证书、已有私钥公钥复用和非唯一 signer。
完整证书集合与受保护的预存指纹先写入公开回执；修改证书仓库前再次检查碰撞，原子更新导入状态。
部分导入或返回值异常会立即按完整计划清理本次证书，带私钥时显式 `-DeleteKey`。
清理失败保留回执供 always 步骤重试；不会删除回执中受保护的预存证书。
真实 Windows Certificate Provider、证书导入和私钥删除，以及 Mac ACL、签名、公证和时间戳服务，
仍须在对应 runner 验证，故障 fixture 不提供该原生证明。

正式产物保留 runtime 体积、签名/公证回执、安装器 SHA-256 及平台/upstream 提交身份。体积缓存只来自成功构建的实测报告；没有旧报告时明确 bootstrap，仍执行绝对预算。已有基线时执行同目标平台增长预算。

## Go 活依赖与执行证据

每个 Go 模块使用独立 CI runner 的 PostgreSQL 与 Redis；Registry 启动固定源码构建的 MinIO，Usage Ledger 启动仓库约定的 RocketMQ 5.3.1 broker/proxy。依赖变量分别为 `LUMO_TEST_PG_DSN`、`LUMO_TEST_REDIS_DSN`、`LUMO_TEST_REDIS_ADDR`、三项 `LUMO_TEST_S3_*` 和 `LUMO_TEST_RMQ_ENDPOINT`。

测试用 `go list ./...` 冻结包集合，`go test -count=1 -json` 产生逐事件证据。验证器要求每个发现的包完成，拒绝测试 skip、失败、空执行、重复执行或终态、不完整报告和包集合不匹配。Go 的“包无测试文件”只在该包确实输出 `[no test files]`、未执行测试时单列，不能冒充测试通过。Governance、Session Control、Scheduler、Flows、Registry、Collaborator 和 Rate Limit 开启 race。

集群精选验收同样使用严格 Go JSONL 和 Vitest JSON 验证，不再用 PASS 文本行或“至少一个用例通过”作为完成判据；增加 Session Control 和 Rate Limit，并要求 Redis 两种地址形式。环境模板为 `platform/deploy/acceptance.env.example`。

## 本地验证入口

```sh
node --test platform/tools/__tests__/*.test.mjs
node platform/tools/verify-go-test-report.mjs /path/go-tests.jsonl --packages /path/go-list.txt
bash -n platform/deploy/acceptance-cluster.sh
```

正反例覆盖发布依赖缺失、SHA 漂移、失败旁路、报告造假、包遗漏、测试跳过、重复终态及签名凭据清理。GitHub hosted run、正式证书与全拓扑环境的实际执行结果另行记录，不能由这些合同测试推断。

基础 CI 同时编译 Node、浏览器及两套 eval 入口，执行全部 deploy Python 合同测试，
并以固定 `playwright@1.58.2` 与匹配 Chromium 运行 headless 源码工作台验收。
该浏览器证据标识为源码 fixture，与目标部署、模型、原生系统验收分别记录。
