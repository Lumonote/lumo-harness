# 公众号文章与物料

本目录收录产品介绍文章《单机版 DeepSeek-Harness：把「一切皆插件」装进一台电脑》及其配套资源，供仓库内引用与二次分发。

| 路径 | 说明 |
| --- | --- |
| [`2026-single-node-deepseek-harness.html`](./2026-single-node-deepseek-harness.html) | 文章正文（自包含 HTML，图片已抽成 `assets/article/` 下的文件） |
| [`assets/article/`](./assets/article/) | 文章内嵌截图（`01.jpg` … `11.jpg`） |
| [`assets/standalone-dsh/`](./assets/standalone-dsh/) | 文章相关高清原图（设置、技能市场、专家包、PPT、开放设计、会话日志、插件市场、更新检查、创造模式、知识库阅读器） |
| [`assets/promo/`](./assets/promo/) | 推广图：`promo-1200x511.png`、`promo-2350x1000.png`、`promo-2350x1000@2x.png` 与推广 HTML |
| [`assets/ads/`](./assets/ads/) | 广告图 `deepseek-harness-ad-01…06` 与生成提示词 `*.txt` |

## 文章结构

1. **设置 / 主题面板**：插件化的前端（皮肤、强调色、壁纸可配置；Slot 渲染器隔离单个插件崩溃）
2. **技能市场 SkillHub**：技能 132 个、专家包 13 个，按办公 / 内容创作 / 开发编程 / AI Agent / 行业分桶
3. **插件市场**：在线一键安装，本质是把 `cordis.patch.yml` 以 insert 一行插件的方式叠进插件树
4. **创造模式**：一句话提需求，实时改造工作台（巡视注册表 → 端到端规划 → 改插件 / 路由 / 分页）
5. **生成 PPT**：内容层 × 视觉层分离，模板可替换
6. **开放设计**：从一句话到可编辑的设计方案（布局、组件、信息层级，而非静态图）
7. **会话日志**：Token / 耗时 / 上下文可观测，可观测性本身也是插件

> 截图中的技能 / 插件数量与版本是运行态快照，以实际版本为准。转载请联系授权。
