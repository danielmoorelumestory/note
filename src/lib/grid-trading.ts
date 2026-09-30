// 网格交易回测的共享逻辑：行情获取与缓存、网格计算、当前状态、记录存储与云同步、资金曲线绘制。
// 计算器、已保存标的、回测详情三个页面共用，避免同一套规则在多处各自维护。

export type Candle = { date: string; close: number; high: number; low: number };
export type Trade = {
  // manual/id：手动添加的成交记录（详情页“添加记录”），其余为网格模拟成交。
  manual?: boolean; id?: string;
  date: string; side: string; price: number; amount: number; shares: number; capitalUsed?: number; pnl: number;
  quantity?: number; modelPrice?: number; modelAmount?: number; modelQuantity?: number;
};
export type EquityPoint = { date: string; current: number; positionValue: number; capitalUsed: number; pnl: number };
export type GridParams = {
  name: string; code: string; date: string; initialPrice: number; initialAmount: number;
  step: number; rebound: number; pullback: number; gridAmount: number;
};
export type GridResult = {
  range: string; current: number; lastTradeDate: string; lastTrade: number;
  nextBuy: number; nextSell: number; buyTrigger: number; sellTrigger: number; lowSince?: number; highSince?: number;
  pnl: number; value: number; realized: number; maxCapital: number; buys: number; sells: number;
  trades: Trade[]; series: EquityPoint[];
  // 当前持仓份额（含手动增删）。
  position?: number;
};
// 按成交日期记录手动修正的真实成交价/成交金额/成交份额；每个交易日最多一笔成交，建仓日即 row.date。
export type Overrides = Record<string, number>;
// 参数变更历史：截止 until（含）的交易日使用该段记录的旧参数，之后的交易日使用记录当前的参数。
// 这样修改步长/反弹/回落只影响之后的下一笔成交，不会改动此前已成交的记录。
export type ParamStage = { until: string; step: number; rebound: number; pullback: number };
// 手动记录：真实发生但网格模拟没有的成交。金额、持仓、占用本金、盈亏由系统按价格和份额自动计算。
export type ManualTrade = { id: string; date: string; side: '买入' | '卖出'; price: number; shares: number };
// manual：手动添加的成交；removed：被删除的网格成交（按成交日期，建仓不可删除）。
// 手动增删只叠加到总盈亏、持仓和占用本金上，不改动已有成交行的数据。
// anchor：备份对比用的“续跑锚点”——备份日之后的第一个交易日，上次成交价重置为 price（备份时列表最上面一条的价格），
// 使纯网格续跑真正从备份点出发。
export type Adjustments = { price?: Overrides; amount?: Overrides; shares?: Overrides; params?: ParamStage[]; manual?: ManualTrade[]; removed?: string[]; anchor?: { after: string; price: number } };

// 备份：冻结备份时刻的全部输入（参数、修正、手动增删、参数历史）和关键结果。
// 之后可用冻结的输入在最新行情上“纯网格续跑”，与当前（含手动微调）的实际数据对比收益。
export type Backup = {
  id: string; at: string;
  date: string; // 备份时最新交易日
  price: number; pnl: number; holding: number; position: number; capital: number; maxCapital: number;
  buys: number; sells: number; lastTrade: number; lastTradeDate: string;
  row: GridParams;
  priceOverrides?: Overrides; amountOverrides?: Overrides; sharesOverrides?: Overrides; paramHistory?: ParamStage[];
  manualTrades?: ManualTrade[]; removedTrades?: string[];
};
export type SavedRecord = {
  id: string; savedAt: string; updatedAt?: string;
  priceOverrides?: Overrides; amountOverrides?: Overrides; sharesOverrides?: Overrides; paramHistory?: ParamStage[];
  manualTrades?: ManualTrade[]; removedTrades?: string[];
  backups?: Backup[];
  row: GridParams & { id?: number };
  // 旧版本保存的结果可能缺少部分字段，读取时需做兼容。
  result: GridResult;
};
type Tombstone = { id: string; savedAt: string; updatedAt: string; deleted: true };
type CloudItem = SavedRecord | Tombstone;

export const RECORDS_KEY = 'grid-trading-saved-v1';
export const SYNC_KEY_STORAGE = 'grid-trading-sync-key-v1';
const DELETED_KEY = 'grid-trading-deleted-v1';
const CANDLE_CACHE_PREFIX = 'grid-trading-candles-v2:';
const QUOTE_CACHE_KEY = 'grid-trading-quotes-v1';
const QUOTE_TTL = 60 * 1000;
const TOMBSTONE_TTL = 180 * 24 * 3600 * 1000;
const SYNC_ENDPOINT = 'https://grid-trading-sync.danielmoore-b0c.workers.dev';
const FEE_RATE = 0.00015;
const STOCK_SELL_TAX_RATE = 0.0005;

// ---------- 通用工具 ----------

// 价格按 0.001 最小变动单位取整，避免 3.88 - 0.1 = 3.7800000000000002 这类浮点误差导致正好触及的价格被漏判。
export const tick = (value: number) => Math.round(value * 1000) / 1000;
// 交易日按北京时间计算，避免 UTC 零点前后把当天算成前一天。
export const marketToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
/** 中国 A 股连续竞价时段（9:30—11:30、13:00—15:00，北京时间）。节假日由报价日期是否为当天进一步兜底判断。 */
export const marketSessionOpen = () => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts();
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  const minutes = Number(value('hour')) * 60 + Number(value('minute'));
  return !['Sat', 'Sun'].includes(value('weekday')) && ((minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900));
};
export const isEtf = (code: string) => /^(5\d{5}|1[5-8]\d{4})$/.test(code.trim());
/** ETF 每笔买卖佣金按成交额万分之 1.5 计算，最低收取 ¥5；股票维持原比例佣金及卖出印花税口径。 */
const commission = (code: string, amount: number) => isEtf(code) ? Math.max(5, amount * FEE_RATE) : amount * FEE_RATE;
// 上交所 ETF / 股票以 5、6、9 开头；其余按深交所处理。
export const symbolOf = (code: string) => `${/^[569]/.test(code.trim()) ? 'sh' : 'sz'}${code.trim()}`;

const amountFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatAmount = (value: number) => amountFormat.format(value);
export const formatMoney = (value: number) => `${value >= 0 ? '+' : '-'}¥${amountFormat.format(Math.abs(value))}`;
export const formatPrice = (value?: number) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—';
export const formatPercent = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;

function readJson<T>(key: string, fallback: T, storage: Storage = localStorage): T {
  try { const raw = storage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}
function writeJson(key: string, value: unknown, storage: Storage = localStorage) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* 存储已满或不可用时放弃缓存 */ }
}

// ---------- 行情：日线缓存 + 批量实时报价 ----------

type CandleCache = { fetchedOn: string; from: string; candles: Candle[] };
const candleRequests = new Map<string, Promise<CandleCache>>();

// 旧版缓存按“代码 + 建仓日”分别保存，同一标的会重复下载；改为按代码缓存后清理旧键。
try { Object.keys(localStorage).filter(key => key.startsWith('grid-trading-market-cache-v1:')).forEach(key => localStorage.removeItem(key)); } catch { /* ignore */ }

async function downloadCandles(code: string, from: string): Promise<Candle[]> {
  const symbol = symbolOf(code);
  let end = marketToday(), lines: string[][] = [];
  // 前复权接口单次最多返回 640 根日线；起始日期较早时向前分段补齐。
  for (let page = 0; page < 20; page++) {
    const response = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,${from},${end},640,qfq`);
    if (!response.ok) throw new Error('行情服务暂不可用');
    const payload = await response.json();
    // 部分 ETF 的前复权接口以 day 返回日线，股票通常为 qfqday。
    const batch: string[][] = payload.data?.[symbol]?.qfqday ?? payload.data?.[symbol]?.day ?? [];
    if (!batch.length) break;
    lines = [...batch, ...lines];
    const firstDate = batch[0][0];
    if (firstDate <= from || batch.length < 640) break;
    const previous = new Date(`${firstDate}T00:00:00Z`); previous.setUTCDate(previous.getUTCDate() - 1); end = previous.toISOString().slice(0, 10);
  }
  return [...new Map(lines.map(line => [line[0], line])).values()]
    .map(line => ({ date: line[0], close: Number(line[2]), high: Number(line[3]), low: Number(line[4]) }))
    .filter(candle => candle.date >= from && Number.isFinite(candle.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 读取某代码自 begin 起的前复权日线。按代码缓存，每个交易日只下载一次（前复权会因分红改写历史价格，
 * 所以不做增量拼接）；同一代码的多条记录共享同一份缓存，并发请求合并为一次。
 */
export async function getCandles(code: string, begin: string, { force = false } = {}): Promise<Candle[]> {
  const key = `${CANDLE_CACHE_PREFIX}${code.trim()}`, today = marketToday();
  const cached = readJson<CandleCache | null>(key, null);
  if (!force && cached?.fetchedOn === today && cached.from <= begin && cached.candles.length) return cached.candles.filter(candle => candle.date >= begin);
  // 同一代码取所有请求中最早的起始日，保证缓存能覆盖各条记录。
  const from = cached && cached.from < begin ? cached.from : begin;
  let request = candleRequests.get(key);
  if (!request) {
    request = downloadCandles(code, from).then(candles => {
      const entry = { fetchedOn: today, from, candles };
      if (candles.length) writeJson(key, entry);
      return entry;
    }).finally(() => candleRequests.delete(key));
    candleRequests.set(key, request);
  }
  const entry = await request;
  return entry.candles.filter(candle => candle.date >= begin);
}

export type Quote = { code: string; name: string; price: number; high: number; low: number; date: string };

/** 批量获取实时报价：多只标的合并为一次请求；结果在本会话内缓存 60 秒，页面间切换不重复请求。 */
export async function fetchQuotes(codes: string[]): Promise<Map<string, Quote>> {
  const unique = [...new Set(codes.map(code => code.trim()).filter(code => /^\d{6}$/.test(code)))];
  const cache = readJson<Record<string, { at: number; quote: Quote }>>(QUOTE_CACHE_KEY, {}, sessionStorage);
  const result = new Map<string, Quote>();
  const missing = unique.filter(code => {
    const hit = cache[code];
    if (hit && Date.now() - hit.at < QUOTE_TTL) { result.set(code, hit.quote); return false; }
    return true;
  });
  if (!missing.length) return result;
  try {
    const response = await fetch(`https://qt.gtimg.cn/q=${missing.map(symbolOf).join(',')}`);
    // 报价文本为 GBK 编码，Response.text() 按 UTF-8 解码会让中文名称变成乱码。
    const text = new TextDecoder('gbk').decode(await response.arrayBuffer());
    for (const match of text.matchAll(/v_(?:sh|sz)(\d{6})="([^"]*)"/g)) {
      const fields = match[2].split('~'), stamp = fields[30] ?? '';
      const quote: Quote = { code: match[1], name: fields[1]?.trim() ?? '', price: Number(fields[3]), high: Number(fields[33]), low: Number(fields[34]), date: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` };
      // 停牌或未开盘时报价可能为 0，此时不参与合并。
      if (!(quote.price > 0 && quote.high > 0 && quote.low > 0) || stamp.length < 8) continue;
      result.set(quote.code, quote);
      cache[quote.code] = { at: Date.now(), quote };
    }
    writeJson(QUOTE_CACHE_KEY, cache, sessionStorage);
  } catch { /* 实时报价失败时仅使用日线 */ }
  return result;
}

/** 用实时报价补齐当日 K 线：已有当日日线则合并高低价，否则追加一根。 */
export function mergeQuote(candles: Candle[], quote?: Quote): Candle[] {
  if (!quote) return candles;
  const index = candles.findIndex(candle => candle.date === quote.date);
  if (index >= 0) {
    const merged = [...candles], previous = candles[index];
    merged[index] = { date: quote.date, close: quote.price, high: Math.max(previous.high, quote.high), low: Math.min(previous.low, quote.low) };
    return merged;
  }
  return !candles.length || quote.date > candles.at(-1)!.date ? [...candles, { date: quote.date, close: quote.price, high: quote.high, low: quote.low }] : candles;
}

// ---------- 网格计算 ----------

export const adjustmentsOf = (record: SavedRecord): Adjustments => ({ price: record.priceOverrides, amount: record.amountOverrides, shares: record.sharesOverrides, params: record.paramHistory, manual: record.manualTrades, removed: record.removedTrades });

/**
 * 修改步长/反弹/回落。
 * - 还没有任何网格买卖成交（只有建仓）：等同于修改这条记录的初始设置，整段历史按新参数重算，不保留旧参数。
 * - 已有网格成交：把改动前的参数记为一段截止到 until 的历史，新参数只对 until 之后的交易日生效。
 *   until 取上次成交日与昨天中较晚者——建仓及此前的成交不变，改动前已经过去的交易日也不会被新参数重新触发，
 *   当天已经发生的成交同样不受影响。同一天多次修改共用同一段历史（保留最初的旧参数）。
 */
export function withParamChange(record: SavedRecord, patch: Partial<Pick<GridParams, 'step' | 'rebound' | 'pullback'>>): SavedRecord {
  const { step, rebound, pullback } = record.row;
  const hasGridTrades = (record.result.trades ?? []).some(trade => trade.side !== '建仓' && !trade.manual);
  if (!hasGridTrades) return { ...record, row: { ...record.row, ...patch }, paramHistory: undefined, updatedAt: new Date().toISOString() };
  const lastTradeDate = record.result.lastTradeDate ?? record.result.trades?.at(-1)?.date ?? record.row.date;
  const yesterday = new Date(`${marketToday()}T00:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const until = [lastTradeDate, yesterday.toISOString().slice(0, 10)].sort().at(-1)!;
  const history = record.paramHistory ?? [];
  const paramHistory = history.some(stage => stage.until === until) ? history
    : [...history, { until, step, rebound, pullback }].sort((a, b) => a.until.localeCompare(b.until));
  return { ...record, row: { ...record.row, ...patch }, paramHistory, updatedAt: new Date().toISOString() };
}

/**
 * 按日线模拟网格：反弹买入、回落卖出直接计入固定的下一格成交价。
 * 日内最低价触及买入价、或日内最高价触及卖出价，即按该价格成交；不要求先跌破/突破步长线后再反转。
 * 有手动修正时按真实成交价/金额/份额成交，成交价同时作为后续网格基准；model* 记录原计算值。
 */
function simulateGrid(row: GridParams, candles: Candle[], adjustments: Adjustments): GridResult {
  const taxRate = isEtf(row.code) ? 0 : STOCK_SELL_TAX_RATE;
  const pick = (map: Overrides | undefined, date: string) => {
    const value = map?.[date];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const fillPrice = (date: string, modelPrice: number) => {
    const value = pick(adjustments.price, date);
    return value === undefined ? { price: modelPrice } : { price: value, modelPrice };
  };
  // 份额修正优先：金额 = 份额 × 成交价；否则按修正金额反推份额。
  const fillAmount = (date: string, modelAmount: number, price: number) => {
    const quantity = pick(adjustments.shares, date);
    if (quantity !== undefined) return { amount: quantity * price, quantity, modelAmount, modelQuantity: modelAmount / price };
    const amount = pick(adjustments.amount, date);
    return amount === undefined ? { amount: modelAmount, quantity: modelAmount / price } : { amount, quantity: amount / price, modelAmount };
  };
  const opening = fillPrice(row.date, row.initialPrice), openingFill = fillAmount(row.date, row.initialAmount, opening.price), openingAmount = openingFill.amount;
  const openingFee = commission(row.code, openingAmount);
  let cash = -openingFee, shares = openingFill.quantity, cost = openingAmount + openingFee, capitalUsed = openingAmount, maxCapital = capitalUsed;
  let lastTrade = opening.price, lastTradeDate = row.date, realized = 0, buys = 0, sells = 0;
  let anchored = !adjustments.anchor;
  // 接口在非交易日会从下一交易日开始返回；该首个实际交易日视为建仓日，建仓当笔总盈亏按其收盘价结算。
  const openingCandle = candles.find(candle => candle.date >= row.date), openingDay = openingCandle?.date;
  const trades: Trade[] = [{ date: row.date, side: '建仓', ...opening, ...openingFill, shares, capitalUsed, pnl: cash + shares * (openingCandle?.close ?? opening.price) - openingAmount }];
  const series: EquityPoint[] = [];
  // 当日适用的参数：取第一个截止日不早于当日的历史段，否则用当前参数。
  const stages = adjustments.params ?? [];
  const paramsAt = (date: string) => stages.find(stage => date <= stage.until) ?? row;
  const buy = (date: string, modelPrice: number) => {
    const fill = fillPrice(date, modelPrice), tradePrice = fill.price;
    const amountFill = fillAmount(date, row.gridAmount, tradePrice), amount = amountFill.amount, fee = commission(row.code, amount);
    shares += amountFill.quantity; cost += amount + fee; cash -= amount + fee; capitalUsed += amount; maxCapital = Math.max(maxCapital, capitalUsed);
    lastTrade = tradePrice; lastTradeDate = date; buys++;
    trades.push({ date, side: '买入', ...fill, ...amountFill, shares, capitalUsed, pnl: cash + shares * tradePrice - openingAmount });
    return true;
  };
  const sell = (date: string, modelPrice: number) => {
    const fill = fillPrice(date, modelPrice), tradePrice = fill.price;
    const modelProceeds = Math.min(shares, row.gridAmount / tradePrice) * tradePrice;
    // 修正后的卖出份额不能超过当前全部持仓。
    const amountFill = fillAmount(date, modelProceeds, tradePrice), quantity = Math.min(shares, amountFill.quantity);
    if (quantity > 0) {
      const proceeds = quantity * tradePrice, netProceeds = proceeds - commission(row.code, proceeds) - proceeds * taxRate, unitCost = cost / shares;
      shares -= quantity; cash += netProceeds; capitalUsed -= proceeds; realized += netProceeds - quantity * unitCost; cost -= quantity * unitCost;
      lastTrade = tradePrice; lastTradeDate = date; sells++;
      trades.push({ date, side: '卖出', ...fill, ...amountFill, amount: proceeds, quantity, shares, capitalUsed, pnl: cash + shares * tradePrice - openingAmount });
    }
    return true;
  };
  for (const candle of candles) {
    // 建仓日只按建仓价建立初始仓位，不读取当日高低价，也不触发网格。
    if (candle.date !== openingDay) {
      // 续跑锚点：备份日之后的第一个交易日起，以备份时最上面一条的价格为上次成交价。
      if (!anchored && candle.date > adjustments.anchor!.after) { lastTrade = adjustments.anchor!.price; anchored = true; }
      const params = paramsAt(candle.date);
      const buyPrice = tick(lastTrade - params.step + params.rebound);
      const sellPrice = tick(lastTrade + params.step - params.pullback);
      // 一根日线不能得知先后顺序；同日两侧均触及时沿用买入优先、每日最多一笔的保守约定。
      if (candle.low <= buyPrice) buy(candle.date, buyPrice);
      else if (candle.high >= sellPrice) sell(candle.date, sellPrice);
    }
    series.push({ date: candle.date, current: candle.close, positionValue: shares * candle.close, capitalUsed, pnl: cash + shares * candle.close - openingAmount });
  }
  const current = candles.at(-1)?.close ?? opening.price, value = cash + shares * current;
  const nextBuy = tick(lastTrade - row.step + row.rebound), nextSell = tick(lastTrade + row.step - row.pullback);
  return {
    range: candles.length ? `${candles[0].date} ～ ${candles.at(-1)!.date}` : row.date,
    current, lastTradeDate, lastTrade, nextBuy, nextSell, buyTrigger: nextBuy, sellTrigger: nextSell,
    pnl: value - openingAmount, value, realized, maxCapital, buys, sells, trades, series, position: shares,
  };
}

/**
 * 当前持仓市值 = 持仓份额 × 当前价。注意 result.value 是“现金流累计 + 持仓市值”的总资产净值，不能当作持仓市值；
 * 早期保存的记录没有 position，用资金曲线最后一天的持仓市值（同样是份额 × 收盘价）兜底。
 */
export const holdingValue = (result: GridResult) =>
  typeof result.position === 'number' ? result.position * result.current : (result.series?.at(-1)?.positionValue ?? 0);

/** 备份当前数据：冻结输入与关键结果，不含逐日曲线与成交明细（对比时用冻结的输入重新计算）。 */
export function createBackup(record: SavedRecord): Backup {
  const { result, row } = record, last = result.series?.at(-1);
  return {
    id: crypto.randomUUID(), at: new Date().toISOString(), date: last?.date ?? marketToday(),
    price: result.current, pnl: result.pnl, holding: holdingValue(result), position: result.position ?? 0,
    capital: last?.capitalUsed ?? 0, maxCapital: result.maxCapital, buys: result.buys, sells: result.sells,
    lastTrade: result.lastTrade, lastTradeDate: result.lastTradeDate,
    row: { name: row.name, code: row.code, date: row.date, initialPrice: row.initialPrice, initialAmount: row.initialAmount, step: row.step, rebound: row.rebound, pullback: row.pullback, gridAmount: row.gridAmount },
    priceOverrides: record.priceOverrides, amountOverrides: record.amountOverrides, sharesOverrides: record.sharesOverrides, paramHistory: record.paramHistory,
    manualTrades: record.manualTrades, removedTrades: record.removedTrades,
  };
}

/** 纯网格续跑：用备份时冻结的输入在最新行情上重算，备份日之后完全按网格买卖（不含之后的手动微调），从备份时最上面一条的价格出发。 */
export function replayBackup(backup: Backup, candles: Candle[]): GridResult {
  return calculateGrid(backup.row, candles, { ...backupAdjustments(backup), anchor: { after: backup.date, price: backup.lastTrade } });
}

const backupAdjustments = (backup: Backup): Adjustments => ({
  price: backup.priceOverrides, amount: backup.amountOverrides, shares: backup.sharesOverrides, params: backup.paramHistory,
  manual: backup.manualTrades, removed: backup.removedTrades,
});

/**
 * 备份日及之前的成交被修正后，按修正后的数据重算“备份时”的快照（总盈亏、持仓、占用本金、上次成交价等），
 * 让对比表的“备份时”列与备份视图保持一致；上次成交价同时是纯网格续跑的起点。
 */
export function refreshBackupSnapshot(backup: Backup, candles: Candle[]): Backup {
  const result = calculateGrid(backup.row, candles.filter(candle => candle.date <= backup.date), backupAdjustments(backup));
  return {
    ...backup, price: result.current, pnl: result.pnl, holding: holdingValue(result), position: result.position ?? 0,
    capital: result.series.at(-1)?.capitalUsed ?? backup.capital, maxCapital: result.maxCapital, buys: result.buys, sells: result.sells,
    lastTrade: result.lastTrade, lastTradeDate: result.lastTradeDate,
  };
}

/** 建仓的实际价格与金额：详情页修正过建仓成交后以修正值为准，否则为创建时填写的设置值。 */
export function openingOf(record: SavedRecord): { price: number; amount: number } {
  const opening = record.result.trades?.find(trade => trade.side === '建仓');
  return { price: opening?.price ?? record.row.initialPrice, amount: opening?.amount ?? record.row.initialAmount };
}

/** 网格模拟 + 手动增删叠加。 */
export function calculateGrid(row: GridParams, candles: Candle[], adjustments: Adjustments = {}): GridResult {
  return applyLedger(row, simulateGrid(row, candles, adjustments), adjustments);
}

/**
 * 叠加手动增删的成交：
 * - 只影响总盈亏、持仓、占用本金、最多使用本金与资金曲线；已有成交行（价格、份额、持仓、盈亏）保持模拟结果不变。
 * - 手动记录自身的成交后持仓、占用本金、当时盈亏，按“模拟结果在该日的状态 + 此前所有增删的累计影响”自动算出。
 * - 只有位于列表最上面（最新）的一条决定下一格买卖价的基准：新增了更新的记录，或删掉了最新的成交，才改变上次成交价。
 */
function applyLedger(row: GridParams, base: GridResult, adjustments: Adjustments): GridResult {
  const manual = adjustments.manual ?? [], removed = new Set(adjustments.removed ?? []);
  const gridRemoved = base.trades.filter((trade, index) => index > 0 && !trade.manual && removed.has(trade.date));
  if (!manual.length && !gridRemoved.length) return base;
  const taxRate = isEtf(row.code) ? 0 : STOCK_SELL_TAX_RATE;
  const openingAmount = base.trades[0].amount;
  // 一笔成交对现金、持仓、占用本金的影响；sign = -1 表示撤销这笔成交。
  const effect = (side: string, amount: number, quantity: number, sign: 1 | -1) => {
    const buy = side === '买入';
    return {
      ds: (buy ? quantity : -quantity) * sign,
      dcash: (buy ? -amount - commission(row.code, amount) : amount - commission(row.code, amount) - amount * taxRate) * sign,
      dcap: (buy ? amount : -amount) * sign,
      dbuys: (buy ? 1 : 0) * sign, dsells: (buy ? 0 : 1) * sign,
    };
  };
  type Change = ReturnType<typeof effect> & { date: string; order: number; seq: number; manual?: ManualTrade };
  const changes: Change[] = [];
  gridRemoved.forEach(trade => changes.push({ ...effect(trade.side, trade.amount, trade.quantity ?? trade.amount / trade.price, -1), date: trade.date, order: 0, seq: changes.length }));
  manual.forEach(item => changes.push({ ...effect(item.side, item.price * item.shares, item.shares, 1), date: item.date, order: 1, seq: changes.length, manual: item }));
  changes.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.seq - b.seq);

  // 模拟结果在某日的状态：取当日或此前最后一笔模拟成交的持仓、占用本金与现金。
  const baseAt = (date: string) => {
    let index = 0;
    base.trades.forEach((trade, i) => { if (trade.date <= date) index = i; });
    const trade = base.trades[index];
    return { shares: trade.shares, capitalUsed: trade.capitalUsed ?? 0, cash: index === 0 ? -commission(row.code, openingAmount) : trade.pnl + openingAmount - trade.shares * trade.price };
  };
  const manualRows: Trade[] = [];
  let cumulative = { ds: 0, dcash: 0, dcap: 0 };
  for (const change of changes) {
    cumulative = { ds: cumulative.ds + change.ds, dcash: cumulative.dcash + change.dcash, dcap: cumulative.dcap + change.dcap };
    const item = change.manual;
    if (!item) continue;
    const start = baseAt(item.date), sharesAfter = start.shares + cumulative.ds;
    manualRows.push({
      manual: true, id: item.id, date: item.date, side: item.side, price: item.price, amount: item.price * item.shares, quantity: item.shares,
      shares: sharesAfter, capitalUsed: start.capitalUsed + cumulative.dcap,
      pnl: start.cash + cumulative.dcash + sharesAfter * item.price - openingAmount,
    });
  }
  // 列表按日期排序：同一天模拟成交在前、手动记录在后。
  const trades = [...base.trades.filter((trade, index) => index === 0 || !removed.has(trade.date)), ...manualRows].sort((a, b) => a.date.localeCompare(b.date));

  const total = changes.reduce((sum, change) => ({ ds: sum.ds + change.ds, dcash: sum.dcash + change.dcash, dbuys: sum.dbuys + change.dbuys, dsells: sum.dsells + change.dsells }), { ds: 0, dcash: 0, dbuys: 0, dsells: 0 });
  // 曲线：自增删当日起逐日叠加累计影响。
  let pointer = 0, run = { ds: 0, dcash: 0, dcap: 0 };
  const series = base.series.map(point => {
    while (pointer < changes.length && changes[pointer].date <= point.date) {
      run = { ds: run.ds + changes[pointer].ds, dcash: run.dcash + changes[pointer].dcash, dcap: run.dcap + changes[pointer].dcap };
      pointer++;
    }
    return { ...point, positionValue: point.positionValue + run.ds * point.current, capitalUsed: point.capitalUsed + run.dcap, pnl: point.pnl + run.dcash + run.ds * point.current };
  });
  const delta = total.dcash + total.ds * base.current;

  // 下一格基准：列表最上面一条不是模拟的最后一笔时，以它的成交价为上次成交价。
  const top = trades.at(-1)!;
  const topIsBaseLast = !top.manual && top.date === base.lastTradeDate;
  const lastTrade = topIsBaseLast ? base.lastTrade : top.price, lastTradeDate = topIsBaseLast ? base.lastTradeDate : top.date;
  const nextBuy = tick(lastTrade - row.step + row.rebound), nextSell = tick(lastTrade + row.step - row.pullback);
  return {
    ...base, trades, series, lastTrade, lastTradeDate, nextBuy, nextSell, buyTrigger: nextBuy, sellTrigger: nextSell,
    pnl: base.pnl + delta, value: base.value + delta, position: (base.position ?? 0) + total.ds,
    maxCapital: Math.max(...series.map(point => point.capitalUsed)),
    buys: base.buys + total.dbuys, sells: base.sells + total.dsells,
  };
}

// ---------- 当前状态 ----------

export type GridStatus = { tone: 'buy' | 'sell' | 'idle'; reached: boolean; label: string; detail: string; gap: number };

/**
 * 当前状态：显示现价离固定下一笔买入/卖出价较近的一侧及差距。
 */
export function gridStatus(record: SavedRecord): GridStatus | null {
  const { result, row } = record, current = result.current;
  if (!(current > 0)) return null;
  const buyGap = (result.nextBuy - current) / current, sellGap = (result.nextSell - current) / current;
  const candidates: GridStatus[] = [
    { tone: 'buy', reached: current <= result.nextBuy, label: current <= result.nextBuy ? '已达买入价' : '距买入价', detail: formatPercent(buyGap), gap: buyGap },
    { tone: 'sell', reached: current >= result.nextSell, label: current >= result.nextSell ? '已达卖出价' : '距卖出价', detail: formatPercent(sellGap), gap: sellGap },
  ];
  return candidates.sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap))[0];
}

// ---------- 记录存储 ----------

export const readRecords = () => readJson<SavedRecord[]>(RECORDS_KEY, []);
export const writeRecords = (records: SavedRecord[]) => localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
/** 只替换指定记录，读取最新列表后再写，避免覆盖其它页面同时做的修改。 */
export function saveRecord(record: SavedRecord) {
  const records = readRecords();
  writeRecords(records.some(item => item.id === record.id) ? records.map(item => item.id === record.id ? record : item) : [record, ...records]);
}

/** 用最新行情重算一条记录（沿用其手动修正）；行情不可用时返回原记录。不改 updatedAt，不影响云同步的新旧判断。 */
export async function refreshRecord(record: SavedRecord, quotes?: Map<string, Quote>): Promise<SavedRecord> {
  const candles = await getCandles(record.row.code, record.row.date);
  const quote = (quotes ?? await fetchQuotes([record.row.code])).get(record.row.code.trim());
  const merged = mergeQuote(candles, quote);
  if (!merged.length) return record;
  return { ...record, result: calculateGrid(record.row, merged, adjustmentsOf(record)) };
}

/** 批量刷新：所有标的的实时报价合并为一次请求，日线按代码共享缓存。单条失败时保留原结果。 */
export async function refreshRecords(records: SavedRecord[]): Promise<SavedRecord[]> {
  const quotes = await fetchQuotes(records.map(record => record.row.code));
  const outcomes = await Promise.allSettled(records.map(record => refreshRecord(record, quotes)));
  return outcomes.map((outcome, index) => outcome.status === 'fulfilled' ? outcome.value : records[index]);
}

// ---------- 云同步 ----------

const stamp = (item: CloudItem) => new Date(item.updatedAt ?? item.savedAt).valueOf();
const isTombstone = (item: CloudItem): item is Tombstone => (item as Tombstone).deleted === true;
export const readSyncKey = () => (localStorage.getItem(SYNC_KEY_STORAGE) ?? '').trim();

async function cloudRequest(token: string, body?: unknown): Promise<CloudItem[]> {
  const response = await fetch(SYNC_ENDPOINT, {
    method: body ? 'PUT' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(body ? '写入云端记录失败' : '读取云端记录失败');
  return body ? [] : ((await response.json()).records ?? []) as CloudItem[];
}

/** 删除记录：写入删除标记（墓碑），同步时让其它设备上的同一记录也被删除，避免被云端旧数据“复活”。 */
export function removeRecords(ids: string[]) {
  const now = new Date().toISOString(), deleted = readJson<Record<string, string>>(DELETED_KEY, {});
  for (const id of ids) deleted[id] = now;
  writeJson(DELETED_KEY, deleted);
  writeRecords(readRecords().filter(item => !ids.includes(item.id)));
}

/** 全量同步：本机记录、本机删除标记与云端合并，同一 id 以修改/删除时间较新者为准，结果同时写回云端和本机。 */
export async function syncAll(token: string): Promise<SavedRecord[]> {
  const remote = await cloudRequest(token);
  const tombstones: Tombstone[] = Object.entries(readJson<Record<string, string>>(DELETED_KEY, {})).map(([id, at]) => ({ id, savedAt: at, updatedAt: at, deleted: true }));
  const merged = new Map<string, CloudItem>();
  for (const item of [...readRecords(), ...tombstones, ...remote]) {
    const previous = merged.get(item.id);
    if (!previous || stamp(item) >= stamp(previous)) merged.set(item.id, item);
  }
  const values = [...merged.values()];
  const records = values.filter((item): item is SavedRecord => !isTombstone(item));
  // 墓碑保留 180 天，足够其它设备同步到删除；过期后清理，避免占满云端 200 条上限。
  const alive = values.filter(isTombstone).filter(item => Date.now() - stamp(item) < TOMBSTONE_TTL);
  await cloudRequest(token, { records: [...records, ...alive] });
  writeRecords(records);
  writeJson(DELETED_KEY, Object.fromEntries(alive.map(item => [item.id, item.updatedAt])));
  return records;
}

/** 只把一条记录合并进云端（云端版本更新时不覆盖）；返回需要提示的失败信息，成功时为空字符串。 */
export async function pushRecord(record: SavedRecord): Promise<string> {
  const token = readSyncKey();
  if (token.length < 16) return '修正已保存到本机；尚未设置同步密钥，未同步到云端。';
  try {
    const remote = await cloudRequest(token);
    const existing = remote.find(item => item.id === record.id);
    if (existing && stamp(existing) > stamp(record)) return '云端有更新的版本，本次修正未上传，请到“已保存标的”页手动同步。';
    await cloudRequest(token, { records: existing ? remote.map(item => item.id === record.id ? record : item) : [record, ...remote] });
    return '';
  } catch {
    return '修正已保存到本机，但同步云端失败，请稍后在“已保存标的”页手动同步。';
  }
}

// ---------- 资金曲线 ----------

/** 绘制持仓市值、占用本金（阶梯线）、总盈亏与收盘价曲线，带十字光标与提示框。 */
export function renderEquityChart(svg: SVGSVGElement, series: EquityPoint[], nextBuy: number | undefined, nextSell: number | undefined, trades: Trade[] = [], marker?: { date: string; label: string }) {
  if (!series.length || !Number.isFinite(nextBuy) || !Number.isFinite(nextSell)) { svg.innerHTML = '<text x="460" y="150" text-anchor="middle" fill="#94a3b8" font-size="13">暂无完整曲线数据</text>'; return; }
  const buyLevel = nextBuy!, sellLevel = nextSell!;
  const width = 920, height = 300, left = 62, right = 54, top = 18, bottom = 38, chartWidth = width - left - right, chartHeight = height - top - bottom;
  const values = series.flatMap(point => [point.positionValue, point.capitalUsed, point.pnl]);
  const min = Math.min(0, ...values), max = Math.max(...values), span = max - min || 1, yMin = min - span * .06, yMax = max + span * .06;
  const priceMinRaw = Math.min(...series.map(point => point.current), buyLevel), priceMaxRaw = Math.max(...series.map(point => point.current), sellLevel);
  const priceSpan = priceMaxRaw - priceMinRaw || Math.max(priceMaxRaw * .02, .01), priceMin = priceMinRaw - priceSpan * .06, priceMax = priceMaxRaw + priceSpan * .06;
  const x = (index: number) => left + index / Math.max(1, series.length - 1) * chartWidth;
  const y = (value: number) => top + (yMax - value) / (yMax - yMin) * chartHeight;
  const priceY = (value: number) => top + (priceMax - value) / (priceMax - priceMin) * chartHeight;
  const path = (valueOf: (point: EquityPoint) => number, scale = y) => series.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${scale(valueOf(point)).toFixed(1)}`).join('');
  // 占用本金只在成交日跳变：先沿上一日数值水平延伸，到成交日再竖直跳到新值（阶梯线）。
  const capitalPath = series.map((point, index) => index ? `H${x(index).toFixed(1)}V${y(point.capitalUsed).toFixed(1)}` : `M${x(0).toFixed(1)},${y(point.capitalUsed).toFixed(1)}`).join('');
  const grid = Array.from({ length: 5 }, (_, index) => { const value = yMin + (yMax - yMin) * index / 4, yy = y(value); return `<line x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" stroke="#e2e8f0"/><text x="${left - 8}" y="${yy + 4}" text-anchor="end" fill="#94a3b8" font-size="10">${(value / 10000).toFixed(1)}万</text>`; }).join('');
  const priceLabels = Array.from({ length: 5 }, (_, index) => { const value = priceMin + (priceMax - priceMin) * index / 4; return `<text x="${width - right + 8}" y="${priceY(value) + 4}" fill="#64748b" font-size="10">${value.toFixed(3)}</text>`; }).join('');
  const labels = [0, Math.floor((series.length - 1) / 2), series.length - 1].map(index => `<text x="${x(index)}" y="${height - 12}" text-anchor="middle" fill="#94a3b8" font-size="10">${series[index].date}</text>`).join('');
  const zero = min < 0 ? `<line x1="${left}" x2="${width - right}" y1="${y(0)}" y2="${y(0)}" stroke="#475569" stroke-width="1.5" stroke-dasharray="6 4"/>` : '';
  const level = (value: number, color: string, label: string) => `<line x1="${left}" x2="${width - right}" y1="${priceY(value)}" y2="${priceY(value)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${width - right + 8}" y="${priceY(value) + 4}" fill="${color}" font-size="10">${label} ${value.toFixed(3)}</text>`;
  // 备份点：在备份日画一条竖线并标注，便于区分备份时的数据与之后按网格续跑的走向。
  const markerIndex = marker ? series.findIndex(point => point.date >= marker.date) : -1;
  const markerSvg = marker && markerIndex >= 0
    ? `<line x1="${x(markerIndex)}" x2="${x(markerIndex)}" y1="${top}" y2="${height - bottom}" stroke="#0369a1" stroke-width="1.2" stroke-dasharray="4 3"/><text x="${x(markerIndex) + (markerIndex > series.length * .8 ? -5 : 5)}" y="${top + 10}" text-anchor="${markerIndex > series.length * .8 ? 'end' : 'start'}" fill="#0369a1" font-size="10" font-weight="700">${marker.label}</text>` : '';
  const tipLines = ['date', 'trade', 'current', 'position', 'capital', 'profit'];
  svg.innerHTML = `<g>${grid}${zero}${priceLabels}${level(buyLevel, '#16a34a', '买')}${level(sellLevel, '#ea580c', '卖')}${markerSvg}</g>`
    + `<path d="${path(point => point.positionValue)}" fill="none" stroke="#2563eb" stroke-width="1.5"/><path d="${capitalPath}" fill="none" stroke="#f59e0b" stroke-width="1.5"/><path d="${path(point => point.pnl)}" fill="none" stroke="#dc2626" stroke-width="1.5"/><path d="${path(point => point.current, priceY)}" fill="none" stroke="#7c3aed" stroke-width="1.5"/>${labels}`
    + `<g class="chart-crosshair" visibility="hidden" pointer-events="none"><line class="crosshair-v" y1="${top}" y2="${height - bottom}" stroke="#64748b" stroke-width="1" stroke-dasharray="3 3"/><line class="crosshair-h" x1="${left}" x2="${width - right}" stroke="#64748b" stroke-width="1" stroke-dasharray="3 3"/>`
    + ['position:#2563eb', 'capital:#f59e0b', 'profit:#dc2626', 'current:#7c3aed'].map(item => { const [name, color] = item.split(':'); return `<circle class="dot-${name}" r="4" fill="${color}" stroke="#fff" stroke-width="2"/>`; }).join('')
    + `<g class="chart-tooltip"><rect fill="#0f172a" fill-opacity=".94" rx="6"/>${tipLines.map((name, index) => `<text class="tip-${name}" x="10" y="${17 + index * 18}" fill="#f8fafc" font-size="10"${index ? '' : ' font-weight="700"'}/>`).join('')}</g></g>`
    + `<rect class="chart-hit-area" x="${left}" y="${top}" width="${chartWidth}" height="${chartHeight}" fill="transparent" style="cursor:crosshair"/>`;
  const crosshair = svg.querySelector('.chart-crosshair') as SVGGElement, tooltip = svg.querySelector('.chart-tooltip') as SVGGElement;
  const set = (selector: string, attrs: Record<string, number | string>) => { const el = svg.querySelector(selector)!; for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value)); };
  const setText = (name: string, text: string) => { tooltip.querySelector(`.tip-${name}`)!.textContent = text; };
  const tradeByDate = new Map(trades.map(trade => [trade.date, trade]));
  const showPoint = (event: PointerEvent) => {
    const bounds = svg.getBoundingClientRect();
    const pointerX = (event.clientX - bounds.left) * width / bounds.width, pointerY = (event.clientY - bounds.top) * height / bounds.height;
    const index = Math.max(0, Math.min(series.length - 1, Math.round((pointerX - left) / chartWidth * (series.length - 1))));
    const point = series[index], xx = x(index), trade = tradeByDate.get(point.date);
    set('.crosshair-v', { x1: xx, x2: xx });
    set('.crosshair-h', { y1: pointerY, y2: pointerY });
    set('.dot-position', { cx: xx, cy: y(point.positionValue) });
    set('.dot-capital', { cx: xx, cy: y(point.capitalUsed) });
    set('.dot-profit', { cx: xx, cy: y(point.pnl) });
    set('.dot-current', { cx: xx, cy: priceY(point.current) });
    setText('date', point.date);
    setText('trade', trade ? `成交  ${trade.side} ${trade.price.toFixed(3)} · ¥${formatAmount(trade.amount)}` : '成交  —');
    setText('current', `收盘价  ${point.current.toFixed(3)}`);
    setText('position', `持仓市值  ¥${formatAmount(point.positionValue)}`);
    setText('capital', `占用本金  ¥${formatAmount(point.capitalUsed)}`);
    setText('profit', `总盈亏  ${formatMoney(point.pnl)}`);
    const tooltipWidth = 200, tooltipHeight = 18 * tipLines.length + 8;
    const tooltipX = xx > width - right - tooltipWidth - 12 ? xx - tooltipWidth - 12 : xx + 12;
    const tooltipY = Math.max(top, Math.min(height - bottom - tooltipHeight, pointerY - tooltipHeight / 2));
    tooltip.setAttribute('transform', `translate(${tooltipX},${tooltipY})`);
    set('.chart-tooltip rect', { width: tooltipWidth, height: tooltipHeight });
    crosshair.setAttribute('visibility', 'visible');
  };
  const hitArea = svg.querySelector('.chart-hit-area')!;
  hitArea.addEventListener('pointermove', event => showPoint(event as PointerEvent));
  hitArea.addEventListener('pointerleave', () => crosshair.setAttribute('visibility', 'hidden'));
}

// ---------- 备份对比曲线 ----------

export type CompareMetric = 'pnl' | 'positionValue' | 'capitalUsed';

/**
 * 备份视图的对比曲线：同一指标下，纯网格续跑（实线）与当前数据含手动微调（虚线）两条走势，
 * 带备份点竖线；悬停时显示两者的值和差额（当前 − 纯网格）。
 */
export function renderCompareChart(svg: SVGSVGElement, pure: EquityPoint[], live: EquityPoint[], metric: CompareMetric, marker?: { date: string; label: string }) {
  if (!pure.length) { svg.innerHTML = '<text x="460" y="150" text-anchor="middle" fill="#94a3b8" font-size="13">暂无数据</text>'; return; }
  const liveByDate = new Map(live.map(point => [point.date, point]));
  const pureValues = pure.map(point => point[metric]), liveValues = pure.map(point => (liveByDate.get(point.date) ?? point)[metric]);
  const all = [...pureValues, ...liveValues];
  // 总盈亏始终包含 0 轴；持仓市值、占用本金按数据范围缩放，避免走势被压扁。
  const lo = metric === 'pnl' ? Math.min(0, ...all) : Math.min(...all), hi = metric === 'pnl' ? Math.max(0, ...all) : Math.max(...all);
  const span = hi - lo || Math.max(Math.abs(hi) * .02, 1), yMin = lo - span * .08, yMax = hi + span * .08;
  const width = 920, height = 300, left = 62, right = 24, top = 18, bottom = 38, chartWidth = width - left - right, chartHeight = height - top - bottom;
  const x = (index: number) => left + index / Math.max(1, pure.length - 1) * chartWidth;
  const y = (value: number) => top + (yMax - value) / (yMax - yMin) * chartHeight;
  const label = (value: number) => yMax - yMin < 20000 ? Math.round(value).toLocaleString('zh-CN') : `${(value / 10000).toFixed(1)}万`;
  const path = (values: number[]) => values.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join('');
  const grid = Array.from({ length: 5 }, (_, index) => { const value = yMin + (yMax - yMin) * index / 4, yy = y(value); return `<line x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" stroke="#e2e8f0"/><text x="${left - 8}" y="${yy + 4}" text-anchor="end" fill="#94a3b8" font-size="10">${label(value)}</text>`; }).join('');
  const zero = lo < 0 && hi > 0 ? `<line x1="${left}" x2="${width - right}" y1="${y(0)}" y2="${y(0)}" stroke="#475569" stroke-width="1.5" stroke-dasharray="6 4"/>` : '';
  const labels = [0, Math.floor((pure.length - 1) / 2), pure.length - 1].map(index => `<text x="${x(index)}" y="${height - 12}" text-anchor="middle" fill="#94a3b8" font-size="10">${pure[index].date}</text>`).join('');
  const markerIndex = marker ? pure.findIndex(point => point.date >= marker.date) : -1;
  const markerSvg = marker && markerIndex >= 0
    ? `<line x1="${x(markerIndex)}" x2="${x(markerIndex)}" y1="${top}" y2="${height - bottom}" stroke="#0369a1" stroke-width="1.2" stroke-dasharray="4 3"/><text x="${x(markerIndex) + (markerIndex > pure.length * .8 ? -5 : 5)}" y="${top + 10}" text-anchor="${markerIndex > pure.length * .8 ? 'end' : 'start'}" fill="#0369a1" font-size="10" font-weight="700">${marker.label}</text>` : '';
  const format = metric === 'pnl' ? formatMoney : (value: number) => `¥${formatAmount(value)}`;
  const tipLines = ['date', 'pure', 'live', 'diff'];
  svg.innerHTML = `<g>${grid}${zero}${markerSvg}</g>`
    + `<path d="${path(pureValues)}" fill="none" stroke="#2563eb" stroke-width="1.8"/><path d="${path(liveValues)}" fill="none" stroke="#ea580c" stroke-width="1.8" stroke-dasharray="6 3"/>${labels}`
    + `<g class="cmp-crosshair" visibility="hidden" pointer-events="none"><line class="cmp-v" y1="${top}" y2="${height - bottom}" stroke="#64748b" stroke-width="1" stroke-dasharray="3 3"/>`
    + `<circle class="cmp-dot-pure" r="4" fill="#2563eb" stroke="#fff" stroke-width="2"/><circle class="cmp-dot-live" r="4" fill="#ea580c" stroke="#fff" stroke-width="2"/>`
    + `<g class="cmp-tip"><rect fill="#0f172a" fill-opacity=".94" rx="6"/>${tipLines.map((name, index) => `<text class="cmp-${name}" x="10" y="${17 + index * 18}" fill="#f8fafc" font-size="10"${index ? '' : ' font-weight="700"'}/>`).join('')}</g></g>`
    + `<rect class="cmp-hit" x="${left}" y="${top}" width="${chartWidth}" height="${chartHeight}" fill="transparent" style="cursor:crosshair"/>`;
  const crosshair = svg.querySelector('.cmp-crosshair') as SVGGElement, tip = svg.querySelector('.cmp-tip') as SVGGElement;
  const set = (selector: string, attrs: Record<string, number | string>) => { const el = svg.querySelector(selector)!; for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value)); };
  const setText = (name: string, text: string) => { tip.querySelector(`.cmp-${name}`)!.textContent = text; };
  const hit = svg.querySelector('.cmp-hit')!;
  hit.addEventListener('pointermove', event => {
    const bounds = svg.getBoundingClientRect(), e = event as PointerEvent;
    const pointerX = (e.clientX - bounds.left) * width / bounds.width, pointerY = (e.clientY - bounds.top) * height / bounds.height;
    const index = Math.max(0, Math.min(pure.length - 1, Math.round((pointerX - left) / chartWidth * (pure.length - 1))));
    const xx = x(index), a = pureValues[index], b = liveValues[index];
    set('.cmp-v', { x1: xx, x2: xx });
    set('.cmp-dot-pure', { cx: xx, cy: y(a) }); set('.cmp-dot-live', { cx: xx, cy: y(b) });
    setText('date', pure[index].date + (marker && pure[index].date > marker.date ? '（备份后）' : ''));
    setText('pure', `纯网格  ${format(a)}`); setText('live', `当前    ${format(b)}`); setText('diff', `差额    ${metric === 'pnl' ? formatMoney(b - a) : `${b - a >= 0 ? '+' : '-'}¥${formatAmount(Math.abs(b - a))}`}`);
    const tipWidth = 200, tipHeight = 18 * tipLines.length + 8;
    tip.setAttribute('transform', `translate(${xx > width - right - tipWidth - 12 ? xx - tipWidth - 12 : xx + 12},${Math.max(top, Math.min(height - bottom - tipHeight, pointerY - tipHeight / 2))})`);
    set('.cmp-tip rect', { width: tipWidth, height: tipHeight });
    crosshair.setAttribute('visibility', 'visible');
  });
  hit.addEventListener('pointerleave', () => crosshair.setAttribute('visibility', 'hidden'));
}
