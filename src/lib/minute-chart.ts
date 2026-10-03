import type { MinuteBar } from './grid-trading';

// 交易时段共 240 分钟：9:30—11:30 对应 0—120，13:00—15:00 对应 120—240（11:30 与 13:00 之间不占横轴）。
const slotOf = (ts: string) => {
  const minutes = Number(ts.slice(8, 10)) * 60 + Number(ts.slice(10, 12));
  return minutes <= 690 ? minutes - 570 : minutes - 780 + 120;
};
const timeText = (ts: string) => `${ts.slice(8, 10)}:${ts.slice(10, 12)}`;
export const volumeText = (volume: number) => volume >= 1e4 ? `${(volume / 1e4).toFixed(1)}万手` : `${Math.round(volume)}手`;

export function renderMinuteChart(svg: SVGSVGElement, bars: MinuteBar[]) {
  const width = Math.max(320, Math.min(920, Math.round(svg.parentElement?.clientWidth || 920)));
  const compact = width < 600, left = compact ? 56 : 62, right = compact ? 14 : 24;
  const priceTop = 24, priceHeight = 190, volTop = 244, volHeight = 60, bottom = volTop + volHeight, height = bottom + 28, chartWidth = width - left - right;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  if (!bars.length) { svg.innerHTML = `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#94a3b8" font-size="13">暂无分钟线数据</text>`; return; }
  const lows = bars.map(bar => bar.low), highs = bars.map(bar => bar.high);
  const min = Math.min(...lows), max = Math.max(...highs), span = max - min || Math.max(max * .002, .001), yMin = min - span * .08, yMax = max + span * .08;
  const maxVolume = Math.max(...bars.map(bar => bar.volume), 1);
  const x = (slot: number) => left + slot / 240 * chartWidth;
  const y = (value: number) => priceTop + (yMax - value) / (yMax - yMin) * priceHeight;
  const decimals = max < 10 ? 3 : 2;
  const grid = Array.from({ length: 4 }, (_, index) => {
    const value = yMin + (yMax - yMin) * index / 3, yy = y(value);
    return `<line x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" stroke="#f1f5f9"/><text x="${left - 8}" y="${yy + 4}" text-anchor="end" fill="#94a3b8" font-size="10">${value.toFixed(decimals)}</text>`;
  }).join('');
  const ticks = [[0, '09:30'], [60, '10:30'], [120, '11:30/13:00'], [180, '14:00'], [240, '15:00']]
    .map(([slot, label]) => `<text x="${x(slot as number)}" y="${bottom + 18}" text-anchor="middle" fill="#94a3b8" font-size="10">${label}</text>`).join('');
  const noon = `<line x1="${x(120)}" x2="${x(120)}" y1="${priceTop}" y2="${bottom}" stroke="#e2e8f0" stroke-dasharray="3 3"/>`;
  // 收盘价折线：午休前后断开成两段，避免用直线连起来误导。
  const path = (part: MinuteBar[]) => part.map((bar, index) => `${index ? 'L' : 'M'}${x(slotOf(bar.ts)).toFixed(1)},${y(bar.close).toFixed(1)}`).join('');
  const morning = bars.filter(bar => slotOf(bar.ts) <= 120), afternoon = bars.filter(bar => slotOf(bar.ts) > 120);
  const first = bars[0].open, barWidth = Math.max(1, chartWidth / 240 - .4);
  const volumes = bars.map(bar => {
    const h = bar.volume / maxVolume * volHeight, up = bar.close >= bar.open;
    return `<rect x="${(x(slotOf(bar.ts)) - barWidth / 2).toFixed(1)}" y="${(bottom - h).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" fill="${up ? '#fca5a5' : '#86efac'}"/>`;
  }).join('');
  // 开盘价基准线：高于为红、低于为绿，沿用 A 股红涨绿跌习惯。
  const base = `<line x1="${left}" x2="${width - right}" y1="${y(first)}" y2="${y(first)}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3"/>`;
  svg.innerHTML = `<text x="${left}" y="${priceTop - 8}" fill="#475569" font-size="11" font-weight="600">价格（元）· 1 分钟收盘价</text>`
    + `${grid}${noon}${base}<line x1="${left}" x2="${width - right}" y1="${priceTop + priceHeight}" y2="${priceTop + priceHeight}" stroke="#e2e8f0"/>`
    + `<text x="${left}" y="${volTop - 6}" fill="#475569" font-size="11" font-weight="600">成交量</text><line x1="${left}" x2="${width - right}" y1="${bottom}" y2="${bottom}" stroke="#e2e8f0"/>`
    + `${volumes}<path d="${path(morning)}" fill="none" stroke="#6366f1" stroke-width="1.4" stroke-linejoin="round"/><path d="${path(afternoon)}" fill="none" stroke="#6366f1" stroke-width="1.4" stroke-linejoin="round"/>${ticks}`
    + `<g class="cross" visibility="hidden" pointer-events="none"><line class="cv" y1="${priceTop}" y2="${bottom}" stroke="#94a3b8" stroke-dasharray="3 3"/><circle class="dot" r="3.5" fill="#6366f1" stroke="#fff" stroke-width="1.5"/>`
    + `<g class="tip"><rect rx="6" fill="#fff" fill-opacity=".97" stroke="#e2e8f0"/>${[0, 1, 2, 3].map(index => `<text class="t${index}" x="10" y="${16 + index * 16}" font-size="10" fill="${index ? '#475569' : '#0f172a'}"${index ? '' : ' font-weight="700"'}/>`).join('')}</g></g>`
    + `<rect class="hit" x="${left}" y="${priceTop}" width="${chartWidth}" height="${bottom - priceTop}" fill="transparent" style="cursor:crosshair;touch-action:pan-y"/>`;

  const cross = svg.querySelector('.cross') as SVGGElement, tip = svg.querySelector('.tip') as SVGGElement, hit = svg.querySelector('.hit') as SVGRectElement;
  const bySlot = new Map(bars.map(bar => [slotOf(bar.ts), bar]));
  const show = (event: PointerEvent) => {
    const bounds = svg.getBoundingClientRect(), pointerX = (event.clientX - bounds.left) * width / bounds.width;
    let slot = Math.max(0, Math.min(240, Math.round((pointerX - left) / chartWidth * 240)));
    // 横向最近的有数据的分钟。
    let bar = bySlot.get(slot);
    for (let offset = 1; !bar && offset < 240; offset++) bar = bySlot.get(slot - offset) ?? bySlot.get(slot + offset);
    if (!bar) return;
    slot = slotOf(bar.ts);
    const xx = x(slot), change = bar.close - first;
    cross.setAttribute('visibility', 'visible');
    cross.querySelector('.cv')!.setAttribute('x1', String(xx)); cross.querySelector('.cv')!.setAttribute('x2', String(xx));
    cross.querySelector('.dot')!.setAttribute('cx', String(xx)); cross.querySelector('.dot')!.setAttribute('cy', String(y(bar.close)));
    const lines = [timeText(bar.ts), `收盘 ${bar.close.toFixed(decimals)}（${change >= 0 ? '+' : ''}${change.toFixed(decimals)}）`, `高 ${bar.high.toFixed(decimals)} · 低 ${bar.low.toFixed(decimals)}`, `量 ${volumeText(bar.volume)}`];
    lines.forEach((text, index) => { tip.querySelector(`.t${index}`)!.textContent = text; });
    const box = tip.querySelector('rect')!; box.setAttribute('width', '128'); box.setAttribute('height', '70');
    tip.setAttribute('transform', `translate(${xx > width * .6 ? xx - 138 : xx + 10},${priceTop + 4})`);
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', () => cross.setAttribute('visibility', 'hidden'));
}


/** 当日摘要（开收高低、涨跌、成交量、分钟数）的 HTML；没有数据返回空串。样式类名为 minute-summary。 */
export function minuteSummaryHtml(bars: MinuteBar[]) {
  if (!bars.length) return '';
  const open = bars[0].open, close = bars.at(-1)!.close, high = Math.max(...bars.map(bar => bar.high)), low = Math.min(...bars.map(bar => bar.low));
  const change = close - open, decimals = high < 10 ? 3 : 2, volume = bars.reduce((sum, bar) => sum + bar.volume, 0);
  return [['开盘', open.toFixed(decimals)], ['收盘', close.toFixed(decimals)], ['最高', high.toFixed(decimals)], ['最低', low.toFixed(decimals)], ['日内涨跌', `${change >= 0 ? '+' : ''}${change.toFixed(decimals)}（${(change / open * 100).toFixed(2)}%）`], ['成交量', volumeText(volume)], ['分钟数', String(bars.length)]]
    .map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('');
}
