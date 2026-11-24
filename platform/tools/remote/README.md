# platform/tools/remote — SSH 一键接入的远端侧工具

| 文件 | 作用 |
|---|---|
| `lumo-remote.sh` | 远端安装器（POSIX sh，经 `ssh host sh -s --` 从 stdin 送达）：probe / status / install / upgrade / rollback |
| `lumo-node.sh` | 安装包入口，打包时复制为 `bin/lumo-node`：`run` / `--version` / `--healthcheck` |
| `pack-server.mjs` | 打包脚本：运行树 → `lumo-server-<V>-<os>-<arch>.tar.gz` + `.sha256`；`--sums <dir>` 生成 `SHA256SUMS` |

## 服务端安装包格式（schema 1）

```
lumo-server-<version>-<os>-<arch>.tar.gz        os ∈ linux|darwin，arch ∈ x64|arm64
└── lumo-server-<version>-<os>-<arch>/
    ├── VERSION            version= / dsh_sha= / dsh_tag= / os= / arch=（远端 sh 直接 sed 读取）
    ├── manifest.json      schema, name, version, os, arch, dsh{repository,tag,sha}, node.engines,
    │                      entry=bin/lumo-node, fileCount, filesSha256(=sha256(files.sha256)), createdAt
    ├── files.sha256       包内全部普通文件的 sha256（sha256sum -c 格式）
    ├── bin/lumo-node
    ├── systemd/lumo-server.service.example
    └── app/               deepseek-harness（按 platform/dsh-pin.json 构建）+ platform（含 node_modules）
```

发布目录（GitHub Release `v<version>/`）里另有 `SHA256SUMS`，可选 `SHA256SUMS.sig`（`openssl dgst -sha256 -sign`）。

远端要求：node `^22.19 || >=24`、tar、curl、sha256sum 或 shasum；有 `systemd --user` 时注册 `lumo-server.service`，否则 nohup 兜底。

## 手动使用

```sh
# 打包（CI 中运行树取自 docker build --target dsh-node 的 /workspace）
node platform/tools/remote/pack-server.mjs --tree /tmp/server-tree --os linux --arch x64 --out dist-server
node platform/tools/remote/pack-server.mjs --sums dist-server

# 在线安装（远端按版本拼包名，下载 SHA256SUMS 校验；可加 --sig-pubkey ~/.lumo-release.pem）
ssh host sh -s -- install --root ~/.lumo-remote --version 1.2.3 --dsh-sha <40hex> --dsh-tag <tag> \
  --bundle-url https://github.com/Lumonote/lumo-harness/releases/download/v1.2.3/ < platform/tools/remote/lumo-remote.sh

# 离线安装：先推包，再不带 --bundle-url 安装
ssh host mkdir -p .lumo-remote/incoming
scp dist-server/lumo-server-1.2.3-linux-x64.tar.gz{,.sha256} host:.lumo-remote/incoming/
```

本机 Lumo 中：设置 `LUMO_REMOTE_BUNDLE_DIR=<目录>` 后，安装/升级会先自动 scp 推送对应包；
`LUMO_REMOTE_BUNDLE_BASE=<https 目录>` 改下载源，`=off` 关闭在线下载。
