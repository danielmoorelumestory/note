# 记

个人笔记和浏览器小功能。静态站，发到 [GitHub Pages](https://danielmoorelumestory.github.io/note/)。

## 本地

```bash
npm install
npm run dev
```

打开 http://localhost:4321/note/

## 写笔记

`src/content/notes/文件名.md`

```yaml
---
title: 标题
date: 2026-09-22
summary: 一句话
tags:
  - 标签
draft: false
---
```

`draft: true` 只在本地显示。`_` 开头的文件不发布。

## 加功能页

1. 新建 `src/pages/lab/名字.astro`
2. 在 `src/lib/labs.ts` 登记 `slug`、`title`、`summary`

参考 `src/pages/lab/text-count.astro`。

## 发布

推 `main`。Actions 会构建并部署。仓库 Settings → Pages → Source 选 **GitHub Actions**（只需设一次）。

线上地址：https://danielmoorelumestory.github.io/note/
