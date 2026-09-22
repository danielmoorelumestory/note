# Design: 全站 Pico.css 脚手架迁移

**日期：** 2026-09-22  
**状态：** 已通过口头设计评审，待实现计划  
**仓库：** sterlet（Astro 笔记站）

## 背景与目标

当前站点使用自研暖奶油 / 赤陶主题 CSS，笔记（尤其行业研报）在通用 prose 下层级弱、表格与分区不够「研报」。用户希望对齐成熟研报页气质，但**直接采用成熟脚手架**，而不是手抄参考 HTML 或重写一整套 CSS。

**目标：** 全站视觉统一切到 Pico.css（冷色语义风），现有 markdown 零改或极少改即可受益。

## 已确认决策

| 项 | 选择 |
| --- | --- |
| 范围 | 全站（首页 / 笔记 / lab / 404），非仅行业研究标签 |
| 视觉 | 冷色语义风（Pico 默认），对齐参考研报气质，不保留奶油主轴 |
| 深度 | 成熟框架直接用；本轮不做 callout / timeline 组件化 |
| 方案 | `@picocss/pico` classless |
| 参考（气质） | `pig_price_equity_linkage_research_20260916.html`（仅作目标气质，不 vendoring 其 CSS） |

## 架构

1. 通过 npm 安装 `@picocss/pico`，构建期打包进产物（GitHub Pages 不依赖运行时 CDN）。
2. 在 `Base.astro` 引入 Pico **classless** 样式表（例如 `pico.classless.min.css`），使无 class 的 markdown 语义标签直接获得排版。
3. 将 `src/styles/global.css` 降为**薄补丁层**：只保留 Pico 不管的站点行为与 DOM 缝合（壳宽度、sticky 顶栏与 TOC、当前页高亮、draft chip、lab 网格若需要等）。
4. 删除或停用奶油色 token、毛玻璃顶栏主题、自定义 `.prose` 大段主题样式，避免与 Pico 双主题打架。

```
Base.astro
  ├── @picocss/pico (classless)
  └── global.css (thin patches only)
        └── pages: index / notes / lab / 404
```

## 组件与文件边界

### 保留（逻辑与信息架构）

- `Base.astro` 顶栏结构（brand、笔记、lab）
- `pages/notes/[...id].astro`：面包屑、TOC sticky、frontmatter meta、滚动高亮脚本
- lab 登记（`lib/labs.ts`）与功能页逻辑
- content collections、RSS、`lib/url.ts` base path

### 修改

- `package.json` / lockfile：增加 `@picocss/pico`
- `layouts/Base.astro`：引入 Pico classless
- `styles/global.css`：瘦身为补丁
- 各页仅在必要时把容器对齐 Pico 语义（如 `main` / `article`）；不引入第二套 UI 库

### 明确不做（本轮）

- 不迁移 Astro Starlight
- 不组件化参考 HTML 的 callout / grid.card / timeline / formula
- 不改 markdown 正文内容（除非为语义标签所必需，默认零改）
- 不改 GitHub Actions / 发布流程
- 不实现暗色模式切换（跟随 Pico 默认即可）

## 迁移策略

1. 安装 Pico，在 `Base` 挂上 classless。
2. 剥离 `global.css` 中与 Pico 冲突的主题规则；保留交互补丁。
3. 目视走查：首页、笔记列表、`swine-poultry-research`、lab、404、窄屏表格。
4. `npm run build` 确认 `base` 路径与静态资源正确。

## 验收标准

- `npm run build` 通过；GitHub Pages base path 行为不变。
- 全站统一为 Pico 冷色语义风，无大面积奶油背景残留。
- 研报页标题、表格、引用、列表可读；小屏表格可横向滚动。
- 顶栏当前页、TOC 高亮、草稿标记仍可用。
- 现有 md 无需新写作约定即可正常显示。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 现有 class（`.shell` / `.prose` / `.nav`）与 Pico 选择器叠加异常 | 补丁层按页走查；冲突规则删除优先于覆盖 |
| lab 自定义控件样式丢失 | 改用 Pico 语义 `button` / `input`，必要时极少补丁 |
| classless 全局影响过猛 | 仅一处引入；不混用 Pico 有 class 与 classless 两套完整表 |

## 实现后续

设计批准并完成本 spec 审阅后，用 `writing-plans` 产出分步实现计划，再编码。
