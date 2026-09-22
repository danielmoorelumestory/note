import { getCollection, type CollectionEntry } from 'astro:content';

export type Note = CollectionEntry<'notes'>;

export async function visibleNotes(): Promise<Note[]> {
  const all = await getCollection('notes');
  const visible = import.meta.env.DEV ? all : all.filter((note) => !note.data.draft);
  return visible.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function searchText(note: Note): string {
  return [note.data.title, note.data.summary, ...note.data.tags, note.id]
    .join(' ')
    .toLowerCase();
}
