import { defineConfig } from 'astro/config';
import vue from '@astrojs/vue';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages serves this site from /note; Vercel serves it from the domain root.
const isVercel = process.env.VERCEL === '1';
export default defineConfig({
  integrations: [vue()],
  site: isVercel
    ? `https://${process.env.VERCEL_URL}`
    : 'https://danielmoorelumestory.github.io',
  base: isVercel ? undefined : '/note',
  markdown: {
    shikiConfig: {
      theme: 'github-light',
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
