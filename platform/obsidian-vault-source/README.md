# Lumo Vault Source

Obsidian 插件：把当前 vault 同步为 Lumo 桌面知识库（单机版）的来源。

设计依据：`docs/superpowers/specs/2026-09-04-knowledge-panel-single-node-vault-design.md`
（vault 为源 + 插件构建 + sqlite FTS5 关键词档）。

## 职责边界

- **本插件只做三件事**：配置 Lumo 入口与 token、触发「同步」、显示结果。
- **扫描 / 分块 / 索引都在 Lumo 桌面运行时**（`@lumo/knowledge-vault`）完成：
  - `#`/`##` 标题切块；`frontmatter space/title` 映射；`docId = base64url(相对路径)`
  - 关键词检索（sqlite trigram FTS5，零新依赖）
  - 真相源 = vault 本身；索引库在 Lumo 状态目录（`knowledge-vault.sqlite`），可随时重建
- Lumo 面板中对 vault 来源为**只读**（打开原文 = `obsidian://open`）。

## 安装与构建

```sh
cd platform/obsidian-vault-source
pnpm install
pnpm run build          # 生成 dist/main.js + dist/manifest.json
```

把 `dist/` 内容复制到 vault 的 `.obsidian/plugins/lumo-vault-source/`，在 Obsidian
「设置 → 第三方插件」中启用。

## 配置与使用

1. 在插件设置中填 Lumo API 地址（默认 `http://127.0.0.1:3080`）与工作台 token。
2. Lumo 桌面版需运行（or 已安装）。vault 目录通过环境变量 `LUMO_KNOWLEDGE_VAULT_ROOT`
   指定（Lumo 启动前设置）；不设则面板显示「未配置」引导。
3. 点击功能区图标或命令「同步到 Lumo 知识库」。
4. Lumo → 资料库面板：来源列表、空间筛选、索引健康摘要、打开原文。

## 映射规则

| 概念 | 规则 |
|------|------|
| 来源 | vault 内所有 `.md`（忽略隐藏目录/文件） |
| docId | `base64url(vault 相对路径)`（面板展示为人读路径字段） |
| space | 一级文件夹名；`frontmatter space: <id>` 可覆盖；根文件 = `general` |
| title | `frontmatter title` ?? 文件名 |
| sourceVersion | 文件 mtime 的 Unix 秒 |
