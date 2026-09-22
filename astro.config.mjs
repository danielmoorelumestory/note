import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://danielmoorelumestory.github.io',
  base: '/note',
  markdown: {
    shikiConfig: {
      theme: 'github-light',
    },
  },
});
