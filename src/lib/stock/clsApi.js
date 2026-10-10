/**
 * CLS 接口统一请求层（经 grid-trading-sync Worker 的 /cls 转发，浏览器直连会 CORS）
 */

import { SYNC_ENDPOINT } from '../endpoints';

const signatureCache = new Map();
const SIGNATURE_CACHE_MS = 5 * 60 * 1000;
const LATEST_DAY_KEY = 'stock-latest-trading-day-v1';
const LATEST_DAY_TTL = 30 * 60 * 1000;

async function fetchViaProxy(targetUrl) {
  let res;
  try {
    res = await fetch(`${SYNC_ENDPOINT}/cls?url=${encodeURIComponent(targetUrl)}`, {
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? '请求超时' : '无法连接行情代理');
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`行情代理返回异常 (${res.status})`);
  }
  if (!res.ok) {
    throw new Error(json.error || json.msg || `行情代理请求失败 (${res.status})`);
  }
  return json;
}

/**
 * 获取 CLS 签名
 * @param {string} [targetRequestUrl]
 * @returns {Promise<string>}
 */
export async function getClsSignature(targetRequestUrl) {
  const urlToSign = targetRequestUrl || 'https://api3.cls.cn/share/quote/analysis?os=ios&sv=8.6.9';
  const cached = signatureCache.get(urlToSign);
  if (cached && Date.now() - cached.time < SIGNATURE_CACHE_MS) {
    return cached.signature;
  }
  const sdkUrl = `https://api3.cls.cn/v2/js/sdk/cls?url=${encodeURIComponent(urlToSign)}`;
  const json = await fetchViaProxy(sdkUrl);
  if (json.errno !== 0 || !json.data?.signature) {
    throw new Error(json.msg || '获取签名失败');
  }
  signatureCache.set(urlToSign, { signature: json.data.signature, time: Date.now() });
  return json.data.signature;
}

/**
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {Promise<string[]>} YYYYMMDD，从近到远
 */
export async function getTradingDays(startDate, endDate) {
  const url = `https://x-quote.cls.cn/v2/quote/a/stock/range_trading_days?start_date=${startDate}&end_date=${endDate}`;
  const json = await fetchViaProxy(url);
  if (json.code !== 200 || !Array.isArray(json.data)) {
    throw new Error(json.msg || '获取交易日失败');
  }
  return json.data.map((d) => d.replace(/-/g, ''));
}

/**
 * 最近交易日（含今天），YYYY-MM-DD。失败时回退到北京时间今天。
 * @returns {Promise<string>}
 */
export async function getLatestTradingDay() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(LATEST_DAY_KEY) || 'null');
    if (cached && Date.now() - cached.time < LATEST_DAY_TTL) return cached.day;
  } catch {}
  const today = getBeijingDate();
  try {
    const days = await getTradingDays(getBeijingDate(-20), today);
    if (!days.length) return today;
    const d = days[0];
    const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
    sessionStorage.setItem(LATEST_DAY_KEY, JSON.stringify({ day, time: Date.now() }));
    return day;
  } catch {
    return today;
  }
}

/**
 * @param {{ date: string, upLimit: number, signature: string }} options
 */
export async function fetchPlateUpDownAnalysis({ date, upLimit, signature }) {
  const url = `https://x-quote.cls.cn/v2/quote/a/plate/up_down_analysis?up_limit=${upLimit}&date=${date}&sign=${signature}`;
  const json = await fetchViaProxy(url);
  if (json.code !== 200) {
    throw new Error(json.msg || '请求板块数据失败');
  }
  return json;
}

/**
 * 按日期并发拉取板块数据（最多 concurrency 个同时在途），结果顺序与 dates 一致。
 * 只并发网络请求；写 IndexedDB 由调用方串行做，避免 stock_base 读改写互相覆盖。
 * @param {string[]} dates - YYYYMMDD
 * @returns {Promise<Array<{ date: string, json?: any, error?: Error }>>}
 */
export async function fetchPlateDays(dates, { upLimit = 1, concurrency = 4 } = {}) {
  if (!dates.length) return [];
  const firstUrl = `https://x-quote.cls.cn/v2/quote/a/plate/up_down_analysis?up_limit=${upLimit}&date=${dates[0]}`;
  const signature = await getClsSignature(firstUrl);
  const results = new Array(dates.length);
  let next = 0;
  const worker = async () => {
    while (next < dates.length) {
      const i = next++;
      try {
        results[i] = { date: dates[i], json: await fetchPlateUpDownAnalysis({ date: dates[i], upLimit, signature }) };
      } catch (error) {
        results[i] = { date: dates[i], error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, dates.length) }, worker));
  return results;
}

/** 北京时间日期 YYYY-MM-DD，offsetDays 为相对今天的天数 */
export function getBeijingDate(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

/** 交易日接口不可用时的回退：最近 count 个北京时间工作日（不含节假日），YYYYMMDD 从近到远 */
export function recentWeekdays(count) {
  const out = [];
  for (let i = 0; out.length < count && i < count * 3; i++) {
    const day = getBeijingDate(-i);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(day.replace(/-/g, ''));
  }
  return out;
}

/** 北京时间当天 YYYYMMDD */
export function getTodayYYYYMMDD() {
  return getBeijingDate().replace(/-/g, '');
}
