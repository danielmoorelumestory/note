export interface Env { DB: D1Database }

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' },
});

async function ownerHash(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')?.trim();
  if (!token || token.length < 16) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, PUT, OPTIONS', 'access-control-allow-headers': 'authorization, content-type' } });
    const owner = await ownerHash(request);
    if (!owner) return json({ error: '请提供至少 16 位同步密钥。' }, 401);
    if (request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT payload FROM records WHERE owner_hash = ? ORDER BY updated_at DESC').bind(owner).all<{ payload: string }>();
      return json({ records: results.map(row => JSON.parse(row.payload)) });
    }
    if (request.method === 'PUT') {
      const body = await request.json<{ records?: unknown[] }>();
      if (!Array.isArray(body.records) || body.records.length > 200) return json({ error: '记录格式无效或超过 200 条。' }, 400);
      const records = body.records.filter((record): record is { id: string } => typeof record === 'object' && record !== null && typeof (record as { id?: unknown }).id === 'string');
      if (records.length !== body.records.length) return json({ error: '记录缺少 id。' }, 400);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM records WHERE owner_hash = ?').bind(owner),
        ...records.map(record => env.DB.prepare('INSERT INTO records (owner_hash, record_id, payload, updated_at) VALUES (?, ?, ?, ?)').bind(owner, record.id, JSON.stringify(record), now)),
      ]);
      return json({ records: records.length, updatedAt: now });
    }
    return json({ error: '不支持的请求方法。' }, 405);
  },
} satisfies ExportedHandler<Env>;
