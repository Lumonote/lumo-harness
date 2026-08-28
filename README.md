# lumo-harness
基于 deepseek-harness 的分布式多智能体平台改造。

首页入口是仓库内原生 `deepseek-harness` 的 Web shell。启动 Cluster/Standalone 后打开
<http://127.0.0.1:4173>；Lumo 插件会在 DSH 原生页面内提供右下角“Lumo 运营面”，
运营入口为 <http://127.0.0.1:4173/lumo/ops>。
源码目录 `deepseek-harness/` 保留在当前工作区但按约定不提交 Git；默认 DSH 镜像会从它构建。

完整部署、环境变量、插件与验证说明见 [`platform/deploy/README.md`](./platform/deploy/README.md)、
[`docs/configuration.md`](./docs/configuration.md) 和 [`docs/implementation-status.md`](./docs/implementation-status.md)。
