---
title: 加一个网页功能
date: 2026-09-22
summary: 功能页是普通 Astro 页面，登记后会出现在实验列表。
tags:
  - 指南
  - 实验
---

适合放计算器、转换器、只在浏览器里跑的小工具。不要把密钥、token、内网地址写进页面或笔记。

1. 复制 `src/pages/lab/text-count.astro`，改成新文件名。
2. 在 `src/lib/labs.ts` 的 `labs` 数组加一条：`slug` 必须和文件名一致。
3. 推到 `main`。

页面地址是 `/note/lab/文件名`。布局用 `Base`，`current="lab"` 会把导航上的「实验」标成当前页。

脚本写在页面底部的 `<script>` 里，Astro 会打包它。文本处理留在浏览器，别默认往外发请求。
