import type { APIRoute } from 'astro';
import { href } from '../lib/url';
import { visibleNotes } from '../lib/notes';

export const GET: APIRoute = async ({ site }) => {
  const notes = (await visibleNotes()).filter((note) => !note.data.draft);
  const origin = site ?? new URL('https://danielmoorelumestory.github.io');
  const items = notes
    .map((note) => {
      const link = new URL(href(`notes/${note.id}`), origin).href;
      return `<item>
        <title>${escapeXml(note.data.title)}</title>
        <link>${link}</link>
        <guid>${link}</guid>
        <pubDate>${note.data.date.toUTCString()}</pubDate>
        <description>${escapeXml(note.data.summary)}</description>
      </item>`;
    })
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>记</title>
    <link>${new URL(href(), origin).href}</link>
    <description>笔记</description>
    ${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
};

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
