# Pico.css 全站脚手架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全站改用 `@picocss/pico` classless blue，去掉自研奶油主题，笔记/首页/lab 统一冷色语义风。

**Architecture:** npm 打包 `pico.classless.blue.min.css`；`Base.astro` 改为 Pico 期望的 `body > header|main|footer`；`global.css` 瘦身为 token 别名 + 站点结构补丁（列表、TOC、lab 工具）。

**Tech Stack:** Astro 7、`@picocss/pico@2.1.1`、现有 content collections（不改 markdown）。

## Global Constraints

- 依赖：`@picocss/pico@2.1.1`（npm，禁止运行时 CDN）
- 样式：`pico.classless.blue.min.css`（冷蓝，对齐研报气质）
- base path：`/note` 不变
- 本轮不做 callout/timeline 组件化，不迁 Starlight，不改 md 正文
- 页面 scoped 样式可继续用 `--ink/--line/...`，由补丁层映射到 `--pico-*`

## File map

| File | Responsibility |
| --- | --- |
| `package.json` / lock | 依赖 |
| `src/layouts/Base.astro` | 引入 Pico + 扁平 header/main/footer |
| `src/styles/global.css` | 薄补丁：token 别名、壳、列表、文章、TOC、lab tool |
| `src/pages/index.astro` | banner 用别名 token（无需改逻辑） |
| `src/pages/notes/index.astro` | switch-btn 同理 |
| `src/components/IndustryETFSection.astro` | 同理（token 别名后应仍工作） |
| `src/pages/lab/text-count.astro` | 依赖 global 里新增 `.tool/.stats` |

---

### Task 1: 安装 Pico 并挂上 Base

**Files:**
- Modify: `package.json`（已可含依赖）
- Modify: `src/layouts/Base.astro`
- Modify: `src/styles/global.css`（先可仍旧，Task 2 瘦身）

**Interfaces:**
- Produces: Base 引入 `@picocss/pico/css/pico.classless.blue.min.css` 与 `../styles/global.css`
- Produces: DOM 为 `body > header.site-header`、`body > main`、`body > footer.site-footer`

- [ ] **Step 1: 确认依赖已安装**

Run: `npm ls @picocss/pico`
Expected: `@picocss/pico@2.1.1`

- [ ] **Step 2: 改写 Base.astro**

```astro
---
import '@picocss/pico/css/pico.classless.blue.min.css';
import '../styles/global.css';
import { href } from '../lib/url';

interface Props {
  title?: string;
  description?: string;
  current?: 'notes' | 'lab';
}

const { title, description = '笔记和行业研究专栏。', current } = Astro.props;
const pageTitle = title ? `${title} · 记` : '记 · 笔记与行业研究';
---

<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content={description} />
    <link rel="icon" href={href('favicon.svg')} />
    <link rel="alternate" type="application/rss+xml" title="记" href={href('rss.xml')} />
    <title>{pageTitle}</title>
  </head>
  <body>
    <header class="site-header">
      <div class="top">
        <a class="brand" href={href()}>
          <span class="brand-icon">记</span>
          <span class="brand-title">记</span>
          <span class="brand-tag">知识库 & 专栏</span>
        </a>
        <nav class="nav">
          <a href={href('notes')} aria-current={current === 'notes' ? 'page' : undefined}>全部笔记</a>
          <a href={href('notes#industry')} class="nav-highlight">行业专栏</a>
          <a href={href('lab')} aria-current={current === 'lab' ? 'page' : undefined}>实验</a>
        </nav>
      </div>
    </header>
    <main>
      <slot />
    </main>
    <footer class="site-footer">
      <div class="foot-inner">
        <div>
          <div class="foot-brand">记 · 个人随笔与行业研究自选池</div>
          <p class="foot-desc">静态站构建，推到 main 自动发布到 GitHub Pages。</p>
        </div>
        <div class="foot-links">
          <a href="https://github.com/danielmoorelumestory/note" target="_blank" rel="noopener">GitHub 仓库</a>
          <a href={href('rss.xml')}>RSS</a>
        </div>
      </div>
    </footer>
  </body>
</html>
```

- [ ] **Step 3: Commit 依赖 + Base**

```bash
git add package.json package-lock.json src/layouts/Base.astro
git commit -m "feat: 接入 Pico classless blue 并扁平化 Base 布局"
```

---

### Task 2: 重写 global.css 薄补丁

**Files:**
- Modify: `src/styles/global.css`（整文件替换）

**Interfaces:**
- Produces: `:root` 别名 `--bg/--ink/--muted/--line/--accent/--bg-raised/--bg-card/--code-bg/--radius-*` → `--pico-*`
- Produces: `.site-header` sticky、`.nav` 扁平链接、`.note-list`、`.lab-grid`、`.article-layout`/TOC、`.prose` scroll-margin、`.tool/.stats`、表格 overflow

- [ ] **Step 1: 写入瘦身版 global.css**

完整内容以实现时代码为准，必须包含：
1. token 别名（供 index/notes/IndustryETFSection scoped 样式继续工作）
2. sticky header + 扁平 `.nav a`（覆盖 Pico `nav li` 假设）
3. 列表/网格/文章双栏/TOC active
4. `.prose table` 外包横向滚动（`overflow-x: auto` 挂在 `.prose` 或 table 父级；若无 wrap，则 `table { display:block; overflow-x:auto }` 小屏）
5. lab `.tool` / `.stats`
6. 去掉奶油径向渐变、毛玻璃、serif 主题大段

- [ ] **Step 2: build 验证**

Run: `npm run build`
Expected: exit 0，产物在 `dist/`

- [ ] **Step 3: Commit**

```bash
git add src/styles/global.css
git commit -m "refactor: 用 Pico 别名补丁替换奶油主题 CSS"
```

---

### Task 3: 走查补丁与验收

**Files:**
- Modify only if build/视觉缺口：`src/pages/index.astro`、`src/pages/notes/index.astro`、`src/components/IndustryETFSection.astro`、`src/pages/lab/text-count.astro`（优先只改 CSS 变量引用，不改逻辑）

- [ ] **Step 1: build 再跑一次 + 抽查关键页 HTML**

Run: `npm run build && rg -n "f5f1e8|8c3a2f|奶油|glass-bg" src dist || true`
Expected: `src` 中无旧奶油主色硬编码；build 成功

- [ ] **Step 2: 若 scoped 样式仍引用已删变量，在 global 补别名或改 scoped 为 `--pico-*`**

- [ ] **Step 3: 最终 commit（仅当有额外修复）**

```bash
git add -A && git status
# 有改动则：
git commit -m "fix: 对齐 Pico 后的页面 scoped 样式变量"
```

---

## Spec coverage

- 全站 Pico classless → Task 1–2
- 冷蓝 → `pico.classless.blue`
- 薄补丁、保留 TOC/顶栏逻辑 → Task 2
- 不改 md / 不改 CI → 无对应破坏性 task
- build + 无奶油残留 → Task 3
