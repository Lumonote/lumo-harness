# 固定上游能力

本目录保存 Lumo 运行时直接消费的上游 Skill 快照。它们不是文档链接：DSH 插件会读取这里
的 `SKILL.md`、脚本、模板和素材，桌面打包器也会把它们复制进应用资源。

| 目录 | 上游 | 用途 |
| --- | --- | --- |
| `skills/gpt-image-2-style-library` | `freestylefly/awesome-gpt-image-2` | GPT Image 2 风格与提示词模板 |
| `skills/archify` | `tt-a1i/archify` | 架构、流程、生命周期和调度图 |
| `skills/ppt-master` | `hugohe3/ppt-master` | 原生可编辑 PPTX 生成与编辑 |

`skill-sources.json` 是可审计来源清单，更新时必须同时修改仓库地址、上游路径、提交哈希、
版本和许可证。不要使用浮动分支替换固定提交。

在新 checkout 中安装固定依赖：

```sh
cd platform/upstream
./install-components.sh
```

PPT Master 的开发环境安装在忽略提交的 `skills/ppt-master/.venv`。桌面本地预览会自动设置
`LUMO_PPT_PYTHON`；正式桌面打包器会从这个环境提取可重定位 Python 及依赖并写入应用资源，
缺少环境或解释器依赖开发机非系统动态库时直接拒绝打包。服务器镜像则在镜像构建阶段安装
同一份 `requirements.txt`，任务执行期间不得安装依赖。

Ruflo 是 npm 运行时依赖，固定在 `@lumo/ruflo-orchestration` 的 `package.json` 中，不复制到
本目录。适配器禁止执行 `ruflo init` 和 `doctor --fix`，避免覆盖 Lumo 的项目指令、MCP 配置
或钩子；其运行状态只能写入当前项目的 `.lumo/ruflo/<task-id>/<run-id>`。
