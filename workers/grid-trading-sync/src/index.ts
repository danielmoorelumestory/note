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
const addDays = (date: string, days: number) => { const day = new Date(`${date}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + days); return day.toISOString().slice(0, 10); };
const compact = (date: string) => date.replaceAll('-', '');

type DailyBar = { open: number; close: number; high: number; low: number; volume: number };

// 免费版 Worker 单次调用最多 50 次 fetch 子请求（D1 查询不计入）。日K 抓取按预算计数，超出时抛出 BUDGET，剩余标的留到下一次触发。
const FETCH_LIMIT = 48;
class Budget { used = 0; constructor(private limit: number) {} take() { if (++this.used > this.limit) throw new Error('BUDGET'); } }
// 前复权偏移的比较容差：价格最小变动单位是 0.001，小于一半即视为没有变化。
const OFFSET_TOLERANCE = 5e-4;

/**
 * 日K（date → 开收高低量）。单次最多 640 根，起始日较早时从 end 向前分页，最多 6 页。
 * fq 为 'qfq' 时取前复权，否则为未复权。接口每行为 [日期, 开, 收, 高, 低, 量]。
 */
async function dailyBars(symbol: string, begin: string, fq: 'qfq' | '', budget: Budget): Promise<Map<string, DailyBar>> {
  const bars = new Map<string, DailyBar>();
  let end = beijingToday();
  for (let page = 0; page < 6; page++) {
    // 两个域名返回相同数据；web.ifzq.gtimg.cn 会不定期拒绝 Cloudflare 出口（返回 501），所以优先用 ifzq.gtimg.cn，失败再换另一个。
    let response: Response | undefined;
    for (const host of ['ifzq.gtimg.cn', 'web.ifzq.gtimg.cn']) {
      budget.take();
      response = await fetch(`https://${host}/appstock/app/fqkline/get?param=${symbol},day,${begin},${end},640,${fq}`);
      if (response.ok) break;
    }
    if (!response?.ok) throw new Error(`日线接口返回 ${response?.status}`);
    const data = (await response.json<{ data?: Record<string, { qfqday?: string[][]; day?: string[][] }> }>()).data?.[symbol];
    const batch = (fq ? data?.qfqday ?? data?.day : data?.day) ?? [];
    if (!batch.length) break;
    for (const row of batch) {
      const [open, close, high, low, volume] = row.slice(1, 6).map(Number);
      if ([open, close, high, low, volume].every(Number.isFinite)) bars.set(row[0], { open, close, high, low, volume });
    }
    if (batch[0][0] <= begin || batch.length < 640) break;
    end = addDays(batch[0][0], -1);
  }
  return bars;
}

/** 回填起点：该标的所有已保存记录的最早建仓日，与“四年前 1 月 1 日”取较早者。 */
async function backfillStart(env: Env, code: string) {
  const row = await env.DB.prepare("SELECT MIN(json_extract(payload, '$.row.date')) AS date FROM records WHERE json_extract(payload, '$.row.code') = ?").bind(code).first<{ date: string | null }>();
  const fourYearsAgo = `${Number(beijingToday().slice(0, 4)) - 4}-01-01`;
  return row?.date && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.date < fourYearsAgo ? row.date : fourYearsAgo;
}

/** 分块写入（每条语句的绑定参数有大小限制），json_each 批量 upsert。 */
async function upsertRows(env: Env, sql: string, code: string, rows: unknown[][]) {
  for (let index = 0; index < rows.length; index += 400) await env.DB.prepare(sql).bind(code, JSON.stringify(rows.slice(index, index + 400))).run();
}
const writeDaily = (env: Env, code: string, bars: Map<string, DailyBar>) => upsertRows(env,
  `INSERT INTO daily_bars (code, date, open, close, high, low, volume)
   SELECT ?1, value->>0, value->>1, value->>2, value->>3, value->>4, value->>5 FROM json_each(?2) WHERE true
   ON CONFLICT (code, date) DO UPDATE SET open = excluded.open, close = excluded.close, high = excluded.high, low = excluded.low, volume = excluded.volume
   WHERE daily_bars.open IS NOT excluded.open OR daily_bars.close IS NOT excluded.close OR daily_bars.high IS NOT excluded.high OR daily_bars.low IS NOT excluded.low OR daily_bars.volume IS NOT excluded.volume`,
  code, [...bars].map(([date, bar]) => [compact(date), bar.open, bar.close, bar.high, bar.low, bar.volume]));
const writeOffsets = (env: Env, code: string, offsets: Map<string, number>) => upsertRows(env,
  `INSERT INTO daily_offsets (code, date, offset) SELECT ?1, value->>0, value->>1 FROM json_each(?2) WHERE true
   ON CONFLICT (code, date) DO UPDATE SET offset = excluded.offset WHERE daily_offsets.offset IS NOT excluded.offset`, code, [...offsets]);

/** 偏移 = 未复权收盘价 − 前复权收盘价（日期键为 YYYYMMDD，保留 6 位小数）。 */
const offsetsOf = (raw: Map<string, { close: number }>, adjusted: Map<string, { close: number }>) =>
  new Map([...raw].filter(([date]) => adjusted.has(date)).map(([date, bar]) => [compact(date), Math.round((bar.close - adjusted.get(date)!.close) * 1e6) / 1e6]));

/** 该标的是否需要（重新）回填：从未回填过，或已保存记录里出现了比已回填起点更早的建仓日。 */
async function needsBackfill(env: Env, code: string) {
  const meta = await env.DB.prepare('SELECT backfilled_from AS date FROM daily_meta WHERE code = ?').bind(code).first<{ date: string }>();
  return !meta || (await backfillStart(env, code)) < meta.date;
}

/**
 * 同步某标的的日K 与前复权偏移：
 * - 需要回填时：从回填起点整段下载未复权与前复权日K，写入全部日K 与偏移；
 * - 否则只取最近 30 天，覆盖写入未复权日K；若这 30 天重新算出的偏移与库中不一致（除权除息），
 *   则整段重新下载前复权日K、用库里已有的未复权收盘价重算全部偏移（未复权日K 历史不变，无需重下）。
 */
async function syncDaily(env: Env, code: string, budget: Budget) {
  const symbol = symbolOf(code);
  if (await needsBackfill(env, code)) {
    const start = await backfillStart(env, code);
    const [raw, adjusted] = [await dailyBars(symbol, start, '', budget), await dailyBars(symbol, start, 'qfq', budget)];
    if (!raw.size) return;
    await writeDaily(env, code, raw);
    await writeOffsets(env, code, offsetsOf(raw, adjusted));
    await env.DB.prepare('INSERT OR REPLACE INTO daily_meta (code, backfilled_from) VALUES (?, ?)').bind(code, start).run();
    return;
  }
  const begin = addDays(beijingToday(), -30);
  const [raw, adjusted] = [await dailyBars(symbol, begin, '', budget), await dailyBars(symbol, begin, 'qfq', budget)];
  if (!raw.size) return;
  await writeDaily(env, code, raw);
  const recent = offsetsOf(raw, adjusted);
  const { results: stored } = await env.DB.prepare('SELECT date, offset FROM daily_offsets WHERE code = ? AND date >= ?').bind(code, compact(begin)).all<{ date: string; offset: number }>();
  const storedByDate = new Map(stored.map(row => [row.date, row.offset]));
  const changed = [...recent].some(([date, offset]) => storedByDate.has(date) && Math.abs(storedByDate.get(date)! - offset) > OFFSET_TOLERANCE);
  if (!changed) { await writeOffsets(env, code, recent); return; }
  // 发生除权除息：整段重算偏移。
  const meta = await env.DB.prepare('SELECT backfilled_from AS date FROM daily_meta WHERE code = ?').bind(code).first<{ date: string }>();
  const fullAdjusted = await dailyBars(symbol, meta!.date, 'qfq', budget);
  const { results: rawRows } = await env.DB.prepare('SELECT date, close FROM daily_bars WHERE code = ?').bind(code).all<{ date: string; close: number }>();
  const rawByDate = new Map(rawRows.map(row => [`${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}`, { close: row.close }]));
  await writeOffsets(env, code, offsetsOf(rawByDate, fullAdjusted));
}

/**
 * 抓取并保存某个标的的 1 分钟线。接口一次最多返回最近 640 根（约 2.7 个交易日），所以每个交易日多次抓取、窗口互相重叠，
 * 单次失败会被后一次补上。用一条 INSERT ... json_each ... ON CONFLICT DO UPDATE 批量写入：同一分钟后抓到的值覆盖先前的值
 * （盘中抓到的最后一根可能还没走完），不会产生重复行；只有值真的变了才写入（D1 免费版每天最多写 10 万行，重复写同样的值也算）。
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
     ON CONFLICT (code, ts) DO UPDATE SET open = excluded.open, close = excluded.close, high = excluded.high, low = excluded.low, volume = excluded.volume
     WHERE minute_bars.open IS NOT excluded.open OR minute_bars.close IS NOT excluded.close OR minute_bars.high IS NOT excluded.high OR minute_bars.low IS NOT excluded.low OR minute_bars.volume IS NOT excluded.volume`,
  ).bind(code, JSON.stringify(bars)).run();
  return { fetched: bars.length, firstTs: bars[0][0] as string, lastTs: bars.at(-1)![0] as string };
}

/**
 * 一次完整的抓取流程（定时任务与手动补抓共用），分两步：
 * 1. 逐个标的抓分钟线，并为每个标的写一条 sync_log（单个失败只记日志，不影响其余标的）；
 * 2. 逐个标的同步日K 与前复权偏移。日K 阶段失败不算抓取失败（分钟线已入库），只把原因追加到该标的日志的 error 里；
 *    子请求预算用完时（首次回填多个标的）停止，剩余标的留到下一次触发，分钟线优先保证。
 */
async function runSync(env: Env, trigger: 'cron' | 'manual', codes: string[]) {
  const runAt = Date.now(), summary = { ok: 0, failed: 0 };
  for (const code of codes) {
    let result = { fetched: 0, firstTs: null as string | null, lastTs: null as string | null }, ok = 1, error: string | null = null;
    try {
      result = await syncMinuteBars(env, code);
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
  // 分钟线阶段每个标的已用掉 1 次 fetch，日K 预算要扣除；按“日K 最近更新最久远”的顺序处理，保证预算有限时每个标的轮流得到更新。
  const budget = new Budget(Math.max(4, FETCH_LIMIT - codes.length));
  const { results: latest } = await env.DB.prepare('SELECT code, MAX(date) AS date FROM daily_bars GROUP BY code').all<{ code: string; date: string }>();
  const latestByCode = new Map(latest.map(row => [row.code, row.date]));
  const ordered = [...codes].sort((a, b) => (latestByCode.get(a) ?? '').localeCompare(latestByCode.get(b) ?? ''));
  const note = (code: string, text: string) => env.DB.prepare("UPDATE sync_log SET error = CASE WHEN error IS NULL THEN ?1 ELSE error || '；' || ?1 END WHERE run_at = ?2 AND code = ?3 AND trigger = ?4")
    .bind(text, runAt, code, trigger).run().catch(() => undefined);
  for (const [index, code] of ordered.entries()) {
    try { await syncDaily(env, code, budget); } catch (dailyError) {
      const message = dailyError instanceof Error ? dailyError.message : String(dailyError);
      if (message === 'BUDGET') { await note(code, '日K 同步因请求预算用尽，留待下次触发'); for (const rest of ordered.slice(index + 1)) await note(rest, '日K 同步留待下次触发'); break; }
      console.error('日K 同步失败', code, dailyError);
      await note(code, `日K 同步失败：${message}`);
    }
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

/**
 * 读取日K：GET /daily?code=510300&from=2025-01-02&to=2026-10-03&adjust=qfq（from/to 可用 YYYY-MM-DD 或 YYYYMMDD，可省略）。
 * adjust=qfq（默认）返回前复权价（未复权价 − 当日偏移，没有偏移的日期按未复权返回），adjust=none 返回原值。
 * 若该代码属于请求密钥名下已保存的记录、且云端还没回填（或出现了更早的建仓日），先按需回填再返回；其他代码绝不触发写入。
 * coveredFrom 是已回填到的起点，前端据此判断“最早一根日K 晚于起点”是标的上市较晚、还是数据不全。
 */
async function readDailyBars(env: Env, owner: string, url: URL) {
  const code = url.searchParams.get('code') ?? '';
  if (!/^\d{6}$/.test(code)) return json({ error: '请提供 6 位标的代码 code。' }, 400);
  const from = (url.searchParams.get('from') ?? '').replace(/\D/g, '') || '00000000', to = (url.searchParams.get('to') ?? '').replace(/\D/g, '') || '99999999';
  const adjusted = url.searchParams.get('adjust') !== 'none';
  if ((await trackedCodes(env, owner)).includes(code) && await needsBackfill(env, code)) {
    try { await syncDaily(env, code, new Budget(FETCH_LIMIT - 4)); } catch (error) { console.error('按需回填失败', code, error); }
  }
  const dateText = "substr(b.date, 1, 4) || '-' || substr(b.date, 5, 2) || '-' || substr(b.date, 7, 2)";
  const { results } = await env.DB.prepare(adjusted
    ? `SELECT ${dateText} AS date, b.open - COALESCE(o.offset, 0) AS open, b.close - COALESCE(o.offset, 0) AS close, b.high - COALESCE(o.offset, 0) AS high, b.low - COALESCE(o.offset, 0) AS low, b.volume
       FROM daily_bars b LEFT JOIN daily_offsets o ON o.code = b.code AND o.date = b.date WHERE b.code = ? AND b.date >= ? AND b.date <= ? ORDER BY b.date`
    : `SELECT ${dateText} AS date, b.open, b.close, b.high, b.low, b.volume FROM daily_bars b WHERE b.code = ? AND b.date >= ? AND b.date <= ? ORDER BY b.date`,
  ).bind(code, from, to).all();
  const meta = await env.DB.prepare('SELECT backfilled_from AS date FROM daily_meta WHERE code = ?').bind(code).first<{ date: string }>();
  return json({ code, adjust: adjusted ? 'qfq' : 'none', coveredFrom: meta?.date ?? null, count: results.length, bars: results });
}

/**
 * 近四年前复权最高/最低价：GET /daily/extremes?codes=601318,159901（一次最多 50 个）。
 * 窗口为“今年及前四个自然年”（今年 2026 年则从 2022-01-01 起），前复权价 = 价格 − 当日偏移，最低价排除 ≤ 0 的值。
 * 只返回该密钥名下已保存且已回填（有 daily_meta）的标的，不触发任何抓取或写入；其余标的不出现在结果里，由前端回退。
 */
async function readExtremes(env: Env, owner: string, url: URL) {
  const requested = [...new Set((url.searchParams.get('codes') ?? '').split(',').map(code => code.trim()).filter(code => /^\d{6}$/.test(code)))].slice(0, 50);
  const from = `${Number(beijingToday().slice(0, 4)) - 4}-01-01`;
  const owned = new Set(await trackedCodes(env, owner));
  const codes = requested.filter(code => owned.has(code));
  if (!codes.length) return json({ window: { from }, extremes: {} });
  const marks = codes.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT b.code AS code, MAX(b.high - COALESCE(o.offset, 0)) AS high,
            MIN(CASE WHEN b.low - COALESCE(o.offset, 0) > 0 THEN b.low - COALESCE(o.offset, 0) END) AS low, MAX(b.date) AS last
     FROM daily_bars b LEFT JOIN daily_offsets o ON o.code = b.code AND o.date = b.date
     WHERE b.code IN (${marks}) AND b.code IN (SELECT code FROM daily_meta) AND b.date >= ?
     GROUP BY b.code`,
  ).bind(...codes, compact(from)).all<{ code: string; high: number; low: number | null; last: string }>();
  const extremes: Record<string, { high: number; low: number; to: string }> = {};
  const tick = (value: number) => Math.round(value * 1000) / 1000; // 价格最小变动单位 0.001，去掉浮点减法的尾数
  for (const row of results) if (row.low !== null) extremes[row.code] = { high: tick(row.high), low: tick(row.low), to: `${row.last.slice(0, 4)}-${row.last.slice(4, 6)}-${row.last.slice(6, 8)}` };
  return json({ window: { from }, extremes });
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
    if (request.method === 'GET' && url.pathname === '/daily/extremes') return readExtremes(env, owner, url);
    if (request.method === 'GET' && url.pathname === '/daily') return readDailyBars(env, owner, url);
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
      // 按记录 upsert：只有传入版本的更新时间（缺省用保存时间）不早于云端现有版本才写入，较旧的被忽略；不再整表删除，
      // 避免另一台设备刚写入的新版本被一次过期的整份上传覆盖。ISO 时间字符串的字典序即时间先后，相等时覆盖（幂等）。
      const version = (column: string) => `COALESCE(json_extract(${column}, '$.updatedAt'), json_extract(${column}, '$.savedAt'), '')`;
      const upsert = `INSERT INTO records (owner_hash, record_id, payload, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (owner_hash, record_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
        WHERE ${version('excluded.payload')} >= ${version('records.payload')}`;
      try {
        const results = records.length ? await env.DB.batch(records.map(record => env.DB.prepare(upsert).bind(owner, record.id, JSON.stringify(record), now))) : [];
        const skipped = records.filter((_, index) => results[index].meta.changes === 0).map(record => record.id);
        // 墓碑（删除标记）客户端只保留 180 天，之后不再上传；服务端同样在写入后清理过期的，避免永久残留。
        const expired = new Date(now - 180 * 24 * 3600_000).toISOString();
        await env.DB.prepare("DELETE FROM records WHERE owner_hash = ? AND json_extract(payload, '$.deleted') = 1 AND " + version('payload') + ' < ?').bind(owner, expired).run();
        return json({ records: records.length, updatedAt: now, skipped });
      } catch (error) {
        console.error('写入记录失败', error);
        return json({ error: `写入记录失败：${error instanceof Error ? error.message : String(error)}` }, 500);
      }
    }
    return json({ error: '不支持的请求方法。' }, 405);
  },
} satisfies ExportedHandler<Env>;
