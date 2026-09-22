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
  }),
});

export const collections = { notes };
