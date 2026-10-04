import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const notes = defineCollection({
  loader: glob({
    base: './src/content/notes',
    pattern: '**/[^_]*.md',
  }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    summary: z.string().default(''),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    // 指向 public/ 下的独立报告页（如 reports/xx.html）；有值时笔记页顶部显示“打开完整报告”按钮，链接自动带上站点 base。
    report: z.string().optional(),
  }),
});

export const collections = { notes };
