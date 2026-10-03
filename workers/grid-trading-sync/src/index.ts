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

const symbolOf = (code: string) => `${/^[569]/.test(code) ? 'sh' : 'sz'}${code}`;

/** 已保存记录里出现过的所有标的代码（去重）。 */
async function trackedCodes(env: Env) {
  const { results } = await env.DB.prepare("SELECT DISTINCT json_extract(payload, '$.row.code') AS code FROM records").all<{ code: string | null }>();
  return results.map(row => row.code?.trim() ?? '').filter(code => /^\d{6}$/.test(code));
}

const beijingToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** 日线收盘价（date → close）。单次最多 640 根，起始日较早时从 end 向前分页，最多 6 页。fq 为 'qfq' 时取前复权，否则为未复权。 */
async function dailyCloses(symbol: string, begin: string, fq: 'qfq' | ''): Promise<Map<string, number>> {
  const closes = new Map<string, number>();
  let end = beijingToday();
  for (let page = 0; page < 6; page++) {
    const response = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,${begin},${end},640,${fq}`);
    if (!response.ok) throw new Error(`日线接口返回 ${response.status}`);
    const data = (await response.json<{ data?: Record<string, { qfqday?: string[][]; day?: string[][] }> }>()).data?.[symbol];
    const batch = (fq ? data?.qfqday ?? data?.day : data?.day) ?? [];
    if (!batch.length) break;
    for (const bar of batch) if (Number.isFinite(Number(bar[2]))) closes.set(bar[0], Number(bar[2]));
    if (batch[0][0] <= begin || batch.length < 640) break;
    const previous = new Date(`${batch[0][0]}T00:00:00Z`); previous.setUTCDate(previous.getUTCDate() - 1); end = previous.toISOString().slice(0, 10);
  }
  return closes;
}

/** 重写某标的从最早分钟线日期起每个交易日的前复权偏移（= 未复权收盘价 − 前复权收盘价）。 */
async function syncOffsets(env: Env, code: string) {
  const symbol = symbolOf(code);
  const earliest = await env.DB.prepare('SELECT MIN(ts) AS ts FROM minute_bars WHERE code = ?').bind(code).first<{ ts: string | null }>();
  const begin = earliest?.ts ? `${earliest.ts.slice(0, 4)}-${earliest.ts.slice(4, 6)}-${earliest.ts.slice(6, 8)}` : beijingToday();
  const [raw, adjusted] = await Promise.all([dailyCloses(symbol, begin, ''), dailyCloses(symbol, begin, 'qfq')]);
  const rows = [...raw].filter(([date]) => adjusted.has(date)).map(([date, close]) => [date.replaceAll('-', ''), Math.round((close - adjusted.get(date)!) * 1e6) / 1e6]);
  if (!rows.length) return 0;
  await env.DB.prepare('INSERT OR REPLACE INTO daily_offsets (code, date, offset) SELECT ?1, value->>0, value->>1 FROM json_each(?2)').bind(code, JSON.stringify(rows)).run();
  return rows.length;
}

/**
 * 抓取并保存某个标的的 1 分钟线。接口一次最多返回最近 640 根（约 3 个交易日），所以每个交易日收盘后跑一次即可连续覆盖，
 * 偶尔漏跑一两天也会被后一次补上。用一条 INSERT OR IGNORE ... json_each 批量写入，重复数据自动跳过。
 */
async function syncMinuteBars(env: Env, code: string) {
  const symbol = symbolOf(code);
  const response = await fetch(`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},m1,,640`);
  if (!response.ok) throw new Error(`${code} 行情接口返回 ${response.status}`);
  const payload = await response.json<{ data?: Record<string, { m1?: unknown[][] }> }>();
  const bars = (payload.data?.[symbol]?.m1 ?? []).map(bar => [String(bar[0]), Number(bar[1]), Number(bar[2]), Number(bar[3]), Number(bar[4]), Number(bar[5])])
    .filter(bar => /^\d{12}$/.test(bar[0] as string) && bar.slice(1).every(value => Number.isFinite(value)));
  if (!bars.length) return 0;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO minute_bars (code, ts, open, close, high, low, volume)
     SELECT ?1, value->>0, value->>1, value->>2, value->>3, value->>4, value->>5 FROM json_each(?2)`,
  ).bind(code, JSON.stringify(bars)).run();
  return bars.length;
}

/** 读取分钟线：GET /minute?code=510300&from=20260929&to=20261002&adjust=qfq（from/to 为 YYYYMMDD，含两端，可省略）。 */
async function readMinuteBars(env: Env, url: URL) {
  const code = url.searchParams.get('code') ?? '';
  if (!/^\d{6}$/.test(code)) return json({ error: '请提供 6 位标的代码 code。' }, 400);
  const from = (url.searchParams.get('from') ?? '00000000').replace(/\D/g, '').padEnd(12, '0'), to = (url.searchParams.get('to') ?? '99999999').replace(/\D/g, '').padEnd(12, '9');
  // adjust=qfq（默认）返回前复权价：未复权价 − 当日偏移；adjust=none 返回未复权原值。没有偏移记录的日期按未复权返回。
  const adjusted = url.searchParams.get('adjust') !== 'none';
  const { results } = await env.DB.prepare(
    adjusted
      ? `SELECT m.ts, m.open - COALESCE(o.offset, 0) AS open, m.close - COALESCE(o.offset, 0) AS close, m.high - COALESCE(o.offset, 0) AS high, m.low - COALESCE(o.offset, 0) AS low, m.volume
         FROM minute_bars m LEFT JOIN daily_offsets o ON o.code = m.code AND o.date = substr(m.ts, 1, 8)
         WHERE m.code = ? AND m.ts >= ? AND m.ts <= ? ORDER BY m.ts`
      : 'SELECT ts, open, close, high, low, volume FROM minute_bars WHERE code = ? AND ts >= ? AND ts <= ? ORDER BY ts',
  ).bind(code, from, to).all();
  return json({ code, adjust: adjusted ? 'qfq' : 'none', count: results.length, bars: results });
}

export default {
  // 定时任务（见 wrangler.jsonc 的 triggers.crons）：每个交易日收盘后抓取所有已保存标的的 1 分钟线。
  async scheduled(_controller, env) {
    for (const code of await trackedCodes(env)) {
      try { await syncMinuteBars(env, code); await syncOffsets(env, code); } catch (error) { console.error('分钟线抓取失败', code, error); }
    }
  },
  async fetch(request, env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, PUT, OPTIONS', 'access-control-allow-headers': 'authorization, content-type' } });
    const owner = await ownerHash(request);
    if (!owner) return json({ error: '请提供至少 16 位同步密钥。' }, 401);
    if (request.method === 'GET' && new URL(request.url).pathname === '/minute') return readMinuteBars(env, new URL(request.url));
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
