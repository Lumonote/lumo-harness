# 部署清单

> 三档形态 × 两类载体（参见 `docs/architecture.md` §13.2）。**同引擎不同拓扑**：仅 Local-lite 允许轻量替代（不承诺迁移）。

| 文件 | 形态 | 载体 | 用途 |
|------|------|------|------|
| `compose.local.yml` | Local-lite | 本地 | 开发、CI 快速用例；1 PG（pgvector）+ 进程内队列/文件 |
| `compose.standalone.yml` | Standalone | 本地/单机 | 同引擎单节点，**承诺可在线升级到 Cluster** |
| `compose.cluster.yml` | Cluster（缩微） | 本地 | **自研服务多实例 + 中间件单实例**；分布式行为与故障注入调试 |
| `helm/` | Cluster | 生产 | 生产部署（阶段 5 前为占位） |
| `migrate/` | — | — | Standalone → Cluster 迁移工具（一等交付物，阶段 5） |

## 故障注入（compose.cluster.yml）

```sh
docker compose -f compose.cluster.yml up              # 起两集群缩微拓扑
docker compose stop dsh-node-1                        # R2: 任务重投 + resume 幂等
docker compose stop scheduler-0                       # N1: 备节点接管 + 本地放置降级
docker compose pause cluster-b                        # §7.4: suspect(30s)→down(90s) 两段式
docker compose stop collaborator-0                    # §5.4.7.4: CRDT 归属转移
# 网络分区用 toxiproxy/tc 注入（R1: SeamProxy 熔断 + 背压）
```

## 约定

- **同一套镜像与应用配置，只换编排清单**；禁止「本地专用镜像」或「本地专用配置项」。
- 中间件在缩微集群中一律单实例（不验证中间件自身的 HA，那是它们各自的事）。
- 每个 compose 的 CI 冒烟：起得来 → 跑一个 headless 任务 → 正常退出。
