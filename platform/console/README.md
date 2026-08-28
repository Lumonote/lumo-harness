# Lumo Workbench（已退役）

> 此静态页面只保留迁移提示，不再直连控制面，也不再从浏览器发送身份头。生产/集群
> 入口是官方 `deepseek-harness` Web，Lumo 能力通过
> `platform/dsh-plugins/lumo-ui` 外置插件包挂载；请参阅
> [`platform/deploy/README.md`](../deploy/README.md)。

```bash
cd platform/console
python3 -m http.server 4174
```

打开 <http://127.0.0.1:4174> 可查看迁移提示；默认目标为原生入口
<http://127.0.0.1:4173/lumo/ops>。其他部署可在托管页面中预置
`window.LUMO_NATIVE_OPS_URL`，但该目录不会自动跳转或发出控制面请求。
