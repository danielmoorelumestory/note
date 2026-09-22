---
title: 记一篇笔记
date: 2026-09-22
summary: 新建 markdown，推 main，页面就在线上。
tags:
  - 指南
---

在 `src/content/notes/` 新建文件。文件名（去掉 `.md`）就是网址最后一段，所以用英文或拼音，别用空格。

```yaml
---
title: 标题
date: 2026-09-22
summary: 列表里的一句话
tags:
  - 标签
draft: false
---
```

`draft: true` 时，`npm run dev` 能看，`npm run build` 不会发到线上。

`_` 开头的文件不会进站点，`_template.md` 就是给你复制的。

写完：

```bash
git add src/content/notes/你的文件.md
git commit -m "note: 标题"
git push
```
