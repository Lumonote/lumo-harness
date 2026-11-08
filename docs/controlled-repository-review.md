# 受控仓库修改与独立审核

`platform-closed-repository-v1` 提供一个可枚举影响范围的仓库修改模式。模型只能读取和替换私有内存快照中的完整文本，不能执行代码、终端命令、连接器、网络请求或修改宿主工作目录。

## 部署配置

集群需要治理 PostgreSQL 迁移 `040_governance_controlled_repository.sql`。在绑定该 Agent 的 subagent-host `runtimeReport` 配置中，由部署管理员设置：

迁移同时扩充预设的 `output_profile` 数据库约束，保留原有文本、文件档位并接受
`platform-closed-repository-v1`。服务启动执行相同的约束升级；重复执行迁移或重启
不会把约束退回旧范围，也不修改既有预设的档位和 revision。未知档位仍由数据库拒绝。

```yaml
repositorySource:
  root: /srv/lumo/approved-repository
  repository: organization/private-repository
  baseCommit: 0123456789abcdef0123456789abcdef01234567
  baseBranch: main
  paths:
    - src/example.ts
    - README.md
```

本地目录应为部署管理员管理的私有 Git 仓库，完整基础提交已预先拉取。配置不会从任务描述、模型参数或浏览器请求读取。运行前读取指定提交的 blob，工作目录中的未提交修改不进入快照。切换基础提交必须更新部署配置并启动新执行和独立审核。

Agent 预设选择“受控仓库修改”，清空系统提示引用、连接器和知识空间。每次最多 8 个已存在的普通 UTF-8 文件，每个最多 3072 字节；不支持新增、删除、二进制、可执行文件、符号链接、子模块、隐藏路径、hooks 或 node_modules。写空文本表示清空已有文件，不表示删除。

## 证据与审核

执行器始终上报全部批准文件的最终内容。治理服务保存基础快照，独立计算变更路径、完整修改前后正文、SHA-256 和全文件 unified patch。模型不能自选“受影响文件”清单或提供修改前的正文。未变化文件不生成 diff；零变更结果不能取得发布许可。

生成的 `repo-change-NNNN.json` 沿用受控文件的不可变 PG blob、哈希核对和逐文件读取回执。审核 Agent 必须在准备后读取每一个完整变更文件，且 Agent、预设、模型、节点满足现有异构审核约束。审核结果必须绑定完整 manifest digest。缺回执、过期审核、历史不明副作用或后续执行代次均不能获得当前发布许可。该模式不执行测试；审核结论不得被视为代码已经通过编译或运行验收。

## 发布草稿 PR

当前发布支持 GitHub，使用当前用户关联的账号。连接器需提供官方 Git API 的 `get_ref`、`get_commit`、`create_tree`、`create_commit`、`create_ref` 和 `create_pull_request` 操作，示例见 `platform/shared/connectors/github.oauth.example.json`。浏览器不接受仓库、路径、文件内容或基础提交覆盖。

流程先在 PG 为精确已审 manifest 创建唯一 `pending` 许可，再原子消耗为 `publishing`。只有一个调用能成功 claim；每次重新检查当前角色、任务访问权限、任务状态和审核有效性。claim 持久提交后，host 才能请求 GitHub。

host 使用基础提交的不可变 tree，提交且只提交已审路径的完整文本，创建唯一父提交为批准基础提交的新 commit，再一次性创建 `lumo/review-<许可 ID>` 分支。发布前后核对 base/head commit，PR 必须为 draft。不会自动合并，也不会修改基础分支。治理审计保存报告的草稿 URL；GitHub 才是 PR 是否仍存在及后续更改的事实来源。

## 中断和结果不明

PG 事务无法与 GitHub 外部写入形成跨服务原子事务。`publishing` 不会因超时重新变为 `pending`，也不允许自动再次 claim。基础分支移动、连接器失败、进程退出或治理最终确认失败，可能留下 Git 对象、唯一分支或草稿 PR。界面会提示核对任务审计；已获得草稿 URL 时一并显示。

操作员应先按许可 ID 检查对应分支和 PR，再决定人工保留或清理。不要盲目重试旧许可。要发布修改后的内容，应准备新的基础快照、执行结果及独立审核。现阶段没有自动恢复写入或外部状态对账作业；这种中断只允许人工核对，保留持久 fence。

普通工具、终端、外部连接器和旧执行记录仍为未知影响范围。受控仓库模式不会替这些记录补造“完整枚举”或追认审核。
