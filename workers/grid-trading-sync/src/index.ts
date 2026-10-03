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

/** 已保存记录里出现过的标的代码（去重）。传入 owner 时只取该密钥名下的记录，否则取全部（定时任务用）。 */
async function trackedCodes(env: Env, owner?: string) {
  const statement = owner
    ? env.DB.prepare("SELECT DISTINCT json_extract(payload, '$.row.code') AS code FROM records WHERE owner_hash = ?").bind(owner)
    : env.DB.prepare("SELECT DISTINCT json_extract(payload, '$.row.code') AS code FROM records");
  const { results } = await statement.all<{ code: string | null }>();
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
 * 抓取并保存某个标的的 1 分钟线。接口一次最多返回最近 640 根（约 2.7 个交易日），所以每个交易日多次抓取、窗口互相重叠，
 * 单次失败会被后一次补上。用一条 INSERT ... json_each ... ON CONFLICT DO UPDATE 批量写入：同一分钟后抓到的值覆盖先前的值
 * （盘中抓到的最后一根可能还没走完），不会产生重复行。
 */
async function syncMinuteBars(env: Env, code: string) {
  const symbol = symbolOf(code);
  const response = await fetch(`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},m1,,640`);
  if (!response.ok) throw new Error(`${code} 行情接口返回 ${response.status}`);
  const payload = await response.json<{ data?: Record<string, { m1?: unknown[][] }> }>();
  const bars = (payload.data?.[symbol]?.m1 ?? []).map(bar => [String(bar[0]), Number(bar[1]), Number(bar[2]), Number(bar[3]), Number(bar[4]), Number(bar[5])])
    .filter(bar => /^\d{12}$/.test(bar[0] as string) && bar.slice(1).every(value => Number.isFinite(value)));
  if (!bars.length) return { fetched: 0, firstTs: null, lastTs: null };
  await env.DB.prepare(
    `INSERT INTO minute_bars (code, ts, open, close, high, low, volume)
     SELECT ?1, value->>0, value->>1, value->>2, value->>3, value->>4, value->>5 FROM json_each(?2) WHERE true
     ON CONFLICT (code, ts) DO UPDATE SET open = excluded.open, close = excluded.close, high = excluded.high, low = excluded.low, volume = excluded.volume`,
  ).bind(code, JSON.stringify(bars)).run();
  return { fetched: bars.length, firstTs: bars[0][0] as string, lastTs: bars.at(-1)![0] as string };
}

/**
 * 一次完整的抓取流程（定时任务与手动补抓共用）：逐个标的抓分钟线、更新前复权偏移，并为每个标的写一条 sync_log。
 * 单个标的失败只记日志，不影响其余标的。偏移更新失败不算抓取失败（分钟线已入库），只在日志的 error 里注明。
 */
async function runSync(env: Env, trigger: 'cron' | 'manual', codes: string[]) {
  const runAt = Date.now(), summary = { ok: 0, failed: 0 };
  for (const code of codes) {
    let result = { fetched: 0, firstTs: null as string | null, lastTs: null as string | null }, ok = 1, error: string | null = null;
    try {
      result = await syncMinuteBars(env, code);
      try { await syncOffsets(env, code); } catch (offsetError) { error = `偏移更新失败：${offsetError instanceof Error ? offsetError.message : String(offsetError)}`; }
    } catch (fetchError) {
      ok = 0; error = fetchError instanceof Error ? fetchError.message : String(fetchError);
      console.error('分钟线抓取失败', code, fetchError);
    }
    summary[ok ? 'ok' : 'failed']++;
    try {
      await env.DB.prepare('INSERT INTO sync_log (run_at, trigger, code, ok, fetched, first_ts, last_ts, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(runAt, trigger, code, ok, result.fetched, result.firstTs, result.lastTs, error).run();
    } catch (logError) { console.error('写入 sync_log 失败', code, logError); }
  }
  return { runAt, trigger, codes: codes.length, ...summary };
}

const FULL_DAY_BARS = 241; // 9:30—11:30、13:00—15:00，含 9:30 与 15:00 两端各一根
const STALE_AFTER_MS = 4 * 24 * 3600_000; // 连续超过 4 天没有成功抓取，认为定时任务异常（周末加休市不会误报：休市期间抓取仍然成功）

/**
 * 分钟线健康状态：GET /minute/status?code=510300。
 * - gaps：最近 30 天内、已收盘的交易日（以日K 偏移表为准）里分钟线不足 241 根的日期。最早一天的分钟线从抓取窗口中途开始，天然不完整，不判为缺口；
 *   当天 15:10 前尚未收盘也不判。停牌日也会出现在这里，由前端提示“可能为停牌”。
 * - lastSuccessAt / lastFailure：来自 sync_log；stale：超过 4 天没有成功抓取。
 */
async function readMinuteStatus(env: Env, url: URL) {
  const code = url.searchParams.get('code') ?? '';
  if (!/^\d{6}$/.test(code)) return json({ error: '请提供 6 位标的代码 code。' }, 400);
  const now = new Date(Date.now() + 8 * 3600_000), today = now.toISOString().slice(0, 10).replaceAll('-', '');
  const closed = now.getUTCHours() * 60 + now.getUTCMinutes() >= 15 * 60 + 10;
  const lastDay = closed ? today : new Date(now.getTime() - 24 * 3600_000).toISOString().slice(0, 10).replaceAll('-', '');
  const since = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString().slice(0, 10).replaceAll('-', '');
  const earliest = await env.DB.prepare('SELECT MIN(substr(ts, 1, 8)) AS day FROM minute_bars WHERE code = ?').bind(code).first<{ day: string | null }>();
  const { results: gaps } = earliest?.day ? await env.DB.prepare(
    `SELECT o.date AS date, COALESCE(c.n, 0) AS bars, ?5 - COALESCE(c.n, 0) AS missing
     FROM daily_offsets o LEFT JOIN (SELECT substr(ts, 1, 8) AS d, COUNT(*) AS n FROM minute_bars WHERE code = ?1 GROUP BY d) c ON c.d = o.date
     WHERE o.code = ?1 AND o.date >= ?2 AND o.date > ?3 AND o.date <= ?4 AND COALESCE(c.n, 0) < ?5 ORDER BY o.date`,
  ).bind(code, since, earliest.day, lastDay, FULL_DAY_BARS).all<{ date: string; bars: number; missing: number }>() : { results: [] };
  const success = await env.DB.prepare('SELECT MAX(run_at) AS at FROM sync_log WHERE code = ? AND ok = 1').bind(code).first<{ at: number | null }>();
  const failure = await env.DB.prepare('SELECT run_at AS at, error FROM sync_log WHERE code = ? AND ok = 0 ORDER BY run_at DESC LIMIT 1').bind(code).first<{ at: number; error: string | null }>();
  const lastSuccessAt = success?.at ?? null;
  return json({ code, lastSuccessAt, lastFailure: failure ?? null, stale: lastSuccessAt !== null && Date.now() - lastSuccessAt > STALE_AFTER_MS, gaps });
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
  // 定时任务（见 wrangler.jsonc 的 triggers.crons）：每个交易日 15:10、16:00 与次日 09:00 抓取所有已保存标的的 1 分钟线。
  async scheduled(_controller, env) {
    await runSync(env, 'cron', await trackedCodes(env));
  },
  async fetch(request, env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, PUT, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type' } });
    const owner = await ownerHash(request);
    if (!owner) return json({ error: '请提供至少 16 位同步密钥。' }, 401);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/minute') return readMinuteBars(env, url);
    if (request.method === 'GET' && url.pathname === '/minute/status') return readMinuteStatus(env, url);
    // 手动补抓：只抓取该密钥名下已保存记录涉及的标的，与定时任务走同一流程。
    if (request.method === 'POST' && url.pathname === '/minute/sync') return json(await runSync(env, 'manual', await trackedCodes(env, owner)));
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
