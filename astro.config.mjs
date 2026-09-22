import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://danielmoorelumestory.github.io',
  base: '/note',
  markdown: {
    shikiConfig: {
      theme: 'github-light',
    },
  },
  vite: {
    build: {
      // latex.css 字体较大，禁止内联进 CSS，避免单文件数 MB
      assetsInlineLimit: 0,
    },
  },
});
