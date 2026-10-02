import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages serves this site from /note; Vercel serves it from the domain root.
const isVercel = process.env.VERCEL === '1';

export default defineConfig({
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
