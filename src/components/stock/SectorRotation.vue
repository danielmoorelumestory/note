<script setup>
import { ref, onMounted } from 'vue'
import { initDB, getPlateData, getPlateDataBatch, extractAndSaveAllData, updatePlateContinuityRate } from '../../lib/stock/db.js'
import { getTradingDays, fetchPlateDays, getTodayYYYYMMDD, getBeijingDate, recentWeekdays } from '../../lib/stock/clsApi.js'
import PlateStockList from './PlateStockList.vue'

const emit = defineEmits(['back'])

const loading = ref(true)
const error = ref(null)
const partialError = ref(null)
const dateData = ref([]) // array of { date: 'YYYYMMDD', plates: [{ name, change, limitCount, maxUp, maxUpNum, continuityRate, limitStocks }] }
const currentView = ref('rotation') // 'rotation' | 'stockList'
const selectedPlateName = ref('')

const formatPct = (v) => {
  if (v === null || v === undefined) return '--'
  return (v * 100).toFixed(2) + '%'
}

const formatDisplayDate = (yyyymmdd) => {
  return `${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6)}`
}

const formatRate = (r) => {
  if (r === null || r === undefined || Number.isNaN(r)) return '--'
  return (r * 100).toFixed(0) + '%'
}

const formatRateNumber = (r) => {
  if (r === null || r === undefined || Number.isNaN(r)) return null
  return String(Math.round(r * 100))
}

const extractLimitStockCodes = (p) => {
  if (!p) return []
  const list = p.stock_list ?? p.stocks ?? p.stockList ?? p.stocks_list
  if (!Array.isArray(list) || list.length === 0) return []
  const out = []
  for (const s of list) {
    if (!s) continue
    const code = s.secu_code ?? s.code ?? s.stock_code
    if (code) out.push(String(code))
  }
  return Array.from(new Set(out))
}

// deterministic color generator for plate names
const nameColorCache = {}
const hashCode = (str) => {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

const hsl = (h, s, l) => `hsl(${h} ${s}% ${l}%)`

// Fixed, distinct palette to ensure consistent and distinguishable plate colors
const PALETTE = [
  { bg: hsl(6, 85, 92), border: hsl(6,85,42), text: '#4b1a1a' },
  { bg: hsl(18, 85, 92), border: hsl(18,85,42), text: '#4a2b03' },
  { bg: hsl(48, 85, 92), border: hsl(48,85,40), text: '#3b2e03' },
  { bg: hsl(120, 60, 92), border: hsl(120,60,38), text: '#0f3b2d' },
  { bg: hsl(160, 60, 92), border: hsl(160,60,38), text: '#0a3b34' },
  { bg: hsl(190, 80, 92), border: hsl(190,80,38), text: '#07323b' },
  { bg: hsl(220, 80, 92), border: hsl(220,80,38), text: '#072246' },
  { bg: hsl(250, 70, 90), border: hsl(250,70,40), text: '#1e114a' },
  { bg: hsl(285, 70, 90), border: hsl(285,70,40), text: '#391344' },
  { bg: hsl(320, 75, 92), border: hsl(320,75,40), text: '#44102b' },
  { bg: hsl(345, 75, 92), border: hsl(345,75,40), text: '#4a0f18' },
  { bg: hsl(30, 60, 92), border: hsl(30,60,40), text: '#3b2b12' }
]

const getPaletteColor = (name) => {
  if (!name) return { bgLight: hsl(0, 0, 96), text: '#0f1724', border: 'rgba(15,23,36,0.06)' }
  const idx = hashCode(name) % PALETTE.length
  const p = PALETTE[idx]
  return { bgLight: p.bg, text: p.text, border: p.border }
} 

// Discrete bucket colors from pale blue → light blue → stronger blue → warm orange
const FREQUENCY_BUCKETS = [
  '#F0F8FF', // very pale blue
  '#CFEFFF',
  '#9FD9FF',
  '#5FB8FF',
  '#FF8A00'  // warm orange for highest frequency
]

const hexToRgb = (hex) => {
  const h = hex.replace('#','')
  return [parseInt(h.substring(0,2),16), parseInt(h.substring(2,4),16), parseInt(h.substring(4,6),16)]
}

const darkenHex = (hex, amt) => {
  const [r,g,b] = hexToRgb(hex)
  const nr = Math.max(0, r - amt)
  const ng = Math.max(0, g - amt)
  const nb = Math.max(0, b - amt)
  return '#' + [nr,ng,nb].map(x => x.toString(16).padStart(2,'0')).join('').toUpperCase()
}


// Robust extraction for number of up-limit (涨停) stocks for a plate
const extractLimitCount = (p) => {
  if (!p) return undefined

  // check a bunch of common numeric fields first
  const numericFields = [
    'up_limit_count','up_limit_cnt','up_cnt','up_count','limit_count','limit_cnt','limit_total','limit','upCount','ztCount','zt_cnt','up_num'
  ]
  for (const k of numericFields) {
    if (k in p) {
      const v = p[k]
      const n = Number(v)
      if (!Number.isNaN(n)) return n
    }
  }

  // check nested fields that sometimes appear
  if (p.summary && typeof p.summary === 'object') {
    for (const k of numericFields) {
      if (k in p.summary) {
        const n = Number(p.summary[k])
        if (!Number.isNaN(n)) return n
      }
    }
  }

  // try to infer from lists of stocks (stock_list / stocks / stockList)
  const list = p.stock_list ?? p.stocks ?? p.stockList ?? p.stocks_list
  if (Array.isArray(list) && list.length > 0) {
    let count = 0
    for (const s of list) {
      if (!s) continue
      // direct flags
      if (s.limit === 1 || s.is_limit === true || s.up_limit === 1 || s.zdt === 1 || s.isZt === true) { count++; continue }

      // percent / change heuristics: many APIs report percent as a number (10 or 0.10) or a string '10.00%'
      const pctRaw = s.pct ?? s.pctChg ?? s.change_pct ?? s.changePercent ?? s.change ?? s.chg ?? s.increment ?? s.inc
      let pctNum
      if (typeof pctRaw === 'string') {
        const m = pctRaw.match(/-?[0-9]+\.?[0-9]*/)
        if (m) pctNum = parseFloat(m[0])
      } else if (typeof pctRaw === 'number') {
        pctNum = pctRaw
      }
      if (pctNum !== undefined) {
        // normalize: if pctNum > 3 it's probably in percent units (e.g., 10), convert to decimal
        if (Math.abs(pctNum) > 3) pctNum = pctNum / 100
        if (pctNum >= 0.089) { count++; continue }
      }
    }
    if (count > 0) return count
  }

  // If we reach here, we couldn't detect a count. Log a single sample of keys to help debugging (one-time per session).
  if (!extractLimitCount._warned) {
    try {
      console.warn('SectorRotation: could not detect limitCount fields for plate example, keys:', Object.keys(p).slice(0, 20))
    } catch (e) {}
    extractLimitCount._warned = true
  }

  return undefined
}

// name frequency tracking
import { computed } from 'vue'
const nameCounts = ref({})
const nameStats = ref({}) // { name: { total, up, down } }
const maxCount = ref(1)

const computeNameCounts = () => {
  const counts = {}
  const stats = {}
  const threshold = 0.01 // only count days where change > 1% (or < -1% for down)

  dateData.value.forEach(d => {
    d.plates.forEach(p => {
      const isUp = p.change > threshold
      const isDown = p.change < -threshold

      // frequency counts only consider meaningful moves (up > 1%)
      if (isUp) {
        counts[p.name] = (counts[p.name] || 0) + 1
      }

      if (!stats[p.name]) stats[p.name] = { total: 0, up: 0, down: 0 }
      if (isUp || isDown) {
        stats[p.name].total++
      }
      if (isUp) stats[p.name].up++
      else if (isDown) stats[p.name].down++
    })
  })

  nameCounts.value = counts
  nameStats.value = stats
  const vals = Object.values(counts)
  maxCount.value = vals.length ? Math.max(...vals) : 1
}

const getColorByFrequency = (name) => {
  // Continuous Blue -> White -> Orange mapping (two-stage)
  const c = nameCounts.value[name] || 0
  // frequency 0 -> neutral dark gray background (user requested)
  if (!c) {
    return { bg: '#D3D3D3', text: '#FFFFFF', border: '#8B8B8B', ratio: 0 }
  }

  const minOcc = 1
  const denom = Math.max(1, maxCount.value - minOcc)
  const rNorm = denom === 0 ? 0 : ((c - minOcc) / denom) // 0..1
  const r = Math.max(0, Math.min(1, rNorm))

  const START = '#FFFFFF' // white
  const END = '#FF8A00'   // orange

  const [sr, sg, sb] = hexToRgb(START)
  const [er, eg, eb] = hexToRgb(END)

  const lerp = (a, b, t) => Math.round(a + (b - a) * t)
  const rr = lerp(sr, er, r)
  const rg = lerp(sg, eg, r)
  const rb = lerp(sb, eb, r)


  const bg = '#' + [rr, rg, rb].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase()
  const border = darkenHex(bg, 30)
  const luminance = 0.2126 * rr + 0.7152 * rg + 0.0722 * rb
  const text = luminance > 180 ? '#000000' : '#FFFFFF'
  return { bg, text, border, ratio: r }
}

// 获取板块在固定7个工作日的涨停数（从今天向前数7个工作日，所有列都显示相同的7天）
const getPlateLimitCountsByDate = (plateName) => {
  const countsByDate = {}
  
  // 固定从今天（最新的日期）向前数7个工作日
  // dateData 已经按日期倒序排列，第一个是最新的日期（今天）
  if (dateData.value.length === 0) {
    return []
  }
  
  // 直接使用 dateData 中已有的7天数据，确保日期格式一致
  // dateData 已经是从今天向前数7个工作日的数据，按日期倒序排列（最新的在前）
  // 第一个是今天，后面是昨天、前天...（总共7个工作日）
  const targetDates = dateData.value.slice(0, 7).map(dayData => dayData.date)
  
  // 构建 dateData 的 Map 以便快速查找
  const dateDataMap = new Map()
  dateData.value.forEach(dayData => {
    dateDataMap.set(dayData.date, dayData.plates)
  })
  
  // 遍历目标日期，查找该板块在每一天的涨停数
  targetDates.forEach(date => {
    const plates = dateDataMap.get(date)
    if (plates) {
      const plate = plates.find(p => p.name === plateName)
      if (plate && plate.limitCount !== undefined && plate.limitCount !== null) {
        countsByDate[date] = plate.limitCount
      } else {
        countsByDate[date] = 0
      }
    } else {
      // 如果 dateData 中没有该日期的数据，默认为 0
      countsByDate[date] = 0
    }
  })
  
  // 返回数组，今天在最前面，然后按时间倒序（昨天、前天...）
  // targetDates 已经是从今天开始按时间倒序的7个工作日
  // 确保顺序正确：第一个是最新的日期（今天）
  return targetDates.map(date => ({
    date: date,
    count: countsByDate[date] || 0
  }))
} 

const getPlateContinuityRatesByDate = (plateName) => {
  if (dateData.value.length === 0) return []
  const targetDates = dateData.value.slice(0, 7).map(dayData => dayData.date)

  const dateDataMap = new Map()
  dateData.value.forEach(dayData => {
    dateDataMap.set(dayData.date, dayData.plates)
  })

  return targetDates.map(date => {
    const plates = dateDataMap.get(date)
    const plate = plates ? plates.find(p => p.name === plateName) : null
    return {
      date,
      rate: plate ? (plate.continuityRate ?? null) : null
    }
  })
}

const ensureContinuityRatesForSevenDays = async () => {
  if (dateData.value.length < 2) return

  const updates = []
  for (let i = 0; i < dateData.value.length - 1; i++) {
    const today = dateData.value[i]
    const yesterday = dateData.value[i + 1]

    const yMap = new Map()
    yesterday.plates.forEach(p => {
      yMap.set(p.name, p)
    })

    for (const p of today.plates) {
      // 先读数据库/缓存字段（已在 plate.continuityRate 上），有就不算
      if (p.continuityRate !== null && p.continuityRate !== undefined) continue

      const yp = yMap.get(p.name)
      if (!yp) {
        p.continuityRate = null
        continue
      }

      const yCodes = yp.limitStocks || []
      if (!yCodes.length) {
        p.continuityRate = null
        continue
      }

      const tSet = new Set(p.limitStocks || [])
      let inter = 0
      for (const c of yCodes) {
        if (tSet.has(c)) inter++
      }
      const rate = inter / yCodes.length
      p.continuityRate = rate

      // 写回数据库（下次先读 DB，不重复计算）
      updates.push(
        updatePlateContinuityRate(today.date, p.name, rate).catch(() => null)
      )
    }
  }

  if (updates.length) {
    await Promise.all(updates)
  }
}

// 将 plateData + plateStats 转为 dateData 一条
function pushSectorDay(apiDate, plateData, plateStats) {
  const plates = plateData
    .filter(p => p.secu_name && !p.secu_name.startsWith('ST') && !p.secu_name.startsWith('*ST') && !p.secu_name.includes('其他'))
    .map(p => ({ name: p.secu_name, change: p.change, raw: p }))
    .sort((a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity))

  if (plates.length === 0) return

  const normalized = plates.map(p => {
    const stats = plateStats?.[p.name] || {}
    const raw = p.raw
    const limitCount = (raw?.plate_stock_up_num ?? stats?.plate_stock_up_num ?? extractLimitCount(raw) ?? 0)
    const maxUp = raw?.maxUp ?? stats?.maxUp ?? null
    const maxUpNum = raw?.maxUpNum ?? stats?.maxUpNum ?? null
    const continuityRate = raw?.continuityRate ?? stats?.continuityRate ?? null
    const limitStocks = extractLimitStockCodes(raw)
    return {
      name: p.name,
      change: p.change,
      limitCount,
      maxUp,
      maxUpNum,
      continuityRate,
      limitStocks
    }
  })
  dateData.value.push({ date: apiDate, plates: normalized })
}

// Fetch 7 个交易日数据：当天不读 DB 直接请求；非当天先读 DB，无再请求
const fetchForSevenValidDates = async () => {
  loading.value = true
  error.value = null
  dateData.value = []

  try {
    await initDB()
  } catch (e) {
    console.error('数据库初始化失败:', e)
    error.value = '数据库初始化失败'
    loading.value = false
    return
  }

  const todayStr = getTodayYYYYMMDD()
  let dateList = []

  try {
    dateList = (await getTradingDays(getBeijingDate(-30), getBeijingDate())).slice(0, 7)
  } catch (e) {
    console.warn('getTradingDays 失败，回退到本地推算', e)
    dateList = recentWeekdays(7)
  }

  // 历史日优先 IndexedDB（无网络）；缺的再批量走云端 D1 / 实时 CLS
  const needFetchDates = []
  const localRows = await getPlateDataBatch(dateList.filter((d) => d !== todayStr))
  const localByDate = new Map(localRows.map((r) => [r.date, r]))

  for (const apiDate of dateList) {
    const local = apiDate === todayStr ? null : localByDate.get(apiDate)
    if (local?.plateData?.length > 0) {
      pushSectorDay(apiDate, local.plateData, local.stats || {})
    } else {
      needFetchDates.push(apiDate)
    }
  }

  let fetchError = null
  try {
    for (const { date: apiDate, json, error: e } of await fetchPlateDays(needFetchDates)) {
      if (e) {
        console.warn('网络请求失败', apiDate, e)
        fetchError ??= e
        continue
      }
      if (!(json?.data?.plate_stock?.length > 0)) continue
      try {
        await extractAndSaveAllData(apiDate, json)
      } catch (saveError) {
        console.warn('保存数据到数据库失败', apiDate, saveError)
      }
      const updatedResult = await getPlateData(apiDate)
      pushSectorDay(apiDate, updatedResult?.plateData || json.data.plate_stock, updatedResult?.stats || {})
    }
  } catch (e) {
    console.warn('获取签名失败', e)
    fetchError = e
  }

  if (dateData.value.length === 0 && fetchError) {
    error.value = fetchError.message || '网络请求失败'
    loading.value = false
    return
  }
  partialError.value = fetchError ? `部分交易日加载失败：${fetchError.message}` : null

  dateData.value.sort((a, b) => b.date.localeCompare(a.date))
  await ensureContinuityRatesForSevenDays()
  computeNameCounts()
  loading.value = false
}

const handlePlateClick = (plateName) => {
  selectedPlateName.value = plateName
  currentView.value = 'stockList'
}

const handleBackToRotation = () => {
  currentView.value = 'rotation'
  selectedPlateName.value = ''
}

onMounted(() => {
  fetchForSevenValidDates()
})
</script>

<template>
  <PlateStockList 
    v-if="currentView === 'stockList'" 
    :plate-name="selectedPlateName"
    @back="handleBackToRotation"
  />
  
  <div v-else class="sector-rotation-page">
    <div class="header-bar">
      <button class="back-btn" @click="emit('back')">← 返回</button>
      <h2 class="page-title">板块轮动（近 7 个交易日）</h2>
    </div>
    <p class="subtle-note">提示：频率统计仅计入单日涨幅大于 1% 的出现次数</p>

    <div v-if="loading" class="loading">正在加载板块数据…</div>
    <div v-else-if="error" class="error">
      {{ error }}
      <button class="retry-btn" @click="fetchForSevenValidDates">重试</button>
    </div>
    <div v-else>
      <p v-if="partialError" class="partial-error">{{ partialError }}</p>
      <div v-if="dateData.length === 0" class="empty">未找到板块数据</div>

      <div v-else class="grid-wrap">
        <div class="day-column" v-for="(d, idx) in dateData" :key="d.date">
          <div class="day-header">{{ formatDisplayDate(d.date) }}</div>
          <ol class="plate-list">
            <li v-for="(p, i) in d.plates.slice(0, 30)" :key="p.name + '_' + i" class="plate-item"
                :data-bucket="getColorByFrequency(p.name).bucket"
                :class="{ 'top-1': i === 0, 'top-2': i === 1, 'top-3': i === 2 }"
                :style="{ '--bg-light': getColorByFrequency(p.name).bg, '--name-text': getPaletteColor(p.name).text, '--border-color': getColorByFrequency(p.name).border }"
                @click="handlePlateClick(p.name)">

              <!-- frequency badge (right-top) shows occurrence count; outlined by freq color -->
              <span class="freq-badge" v-if="nameCounts[p.name]" :style="{ border: '1px solid ' + getColorByFrequency(p.name).border, color: getColorByFrequency(p.name).text, background: 'transparent' }">{{ nameCounts[p.name] }}</span>

              <div class="pname">{{ p.name }}</div>
              <div class="pchg" :style="{ color: p.change > 0 ? '#e63946' : (p.change < 0 ? '#16a34a' : '#6b7280') }">{{ formatPct(p.change) }}</div>
              <div v-if="p.maxUp" class="max-up" :title="'最高连板：' + p.maxUp">最高：{{ p.maxUp }}</div>

              <!-- 近七天涨停数列表 - 紧凑显示（只显示数字） -->
              <div class="limit-counts-list">
                <div 
                  v-for="(dayInfo, dayIdx) in getPlateLimitCountsByDate(p.name)" 
                  :key="dayInfo.date"
                  class="limit-count-item"
                  :class="{ 'current-day': dayInfo.date === d.date }"
                  :title="formatDisplayDate(dayInfo.date) + ': ' + dayInfo.count + '只涨停'">
                  <span class="limit-value" :class="{ 'has-limit-value': dayInfo.count > 0 }">{{ dayInfo.count }}</span>
                </div>
              </div> 

              <!-- 近七天连板率 - 先读 DB，无则计算并写回 -->
              <div class="continuity-rates-list">
                <div
                  v-for="dayInfo in getPlateContinuityRatesByDate(p.name)"
                  :key="dayInfo.date"
                  class="rate-item"
                  :class="{ 'current-day': dayInfo.date === d.date }"
                  :title="formatDisplayDate(dayInfo.date) + ': 连板率 ' + formatRate(dayInfo.rate)">
                  <span v-if="formatRateNumber(dayInfo.rate) === null" class="rate-value rate-na">--</span>
                  <span v-else class="rate-value has-rate">
                    <span class="rate-num">{{ formatRateNumber(dayInfo.rate) }}</span><span class="rate-sym">%</span>
                  </span>
                </div>
              </div>
            </li>
          </ol>
        </div> 
      </div>
    </div>
  </div>
</template>

<style scoped>
.sector-rotation-page {
  padding: 80px 20px 40px 20px; /* add top space for header-bar */
  min-height: 100vh;
  background: #f5f7fb;
  color: #1f2937; /* ensure readable text */
}

.header-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  background: white;
  padding: 15px 20px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 20px;
}

.back-btn {
  background: #e63946;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: bold;
  transition: all 0.2s;
}

.back-btn:hover {
  background: #c1121f;
  transform: translateX(-2px);
}

.page-title {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  color: #000000; /* title forced to pure black */
  flex: 1;
}

.loading, .empty, .error { padding: 40px; color: #4b5563; }
.error { display: flex; align-items: center; gap: 12px; color: #b91c1c; }
.retry-btn { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; }
.partial-error { margin: 0 0 8px; font-size: 0.85rem; color: #b45309; }
.subtle-note { text-align: center; color: #6b7280; margin: 6px 0 12px; font-size: 0.92rem; }
.grid-wrap {
  display: flex;
  gap: 0; /* remove column gap */
  overflow-x: auto;
  align-items: flex-start;
  padding-bottom: 10px;
}
.day-column {
  min-width: 200px;
  max-width: 240px;
  background: rgba(255,255,255,0.95);
  border-radius: 6px;
  padding: 0;
  box-shadow: none;
  border: 1px solid rgba(15,23,36,0.04);
  text-align: left;
  overflow: hidden;
} 
.day-header {
  font-weight: 600;
  margin-bottom: 4px;
  color: #475569;
  text-align: center;
  padding: 6px 0 4px;
  font-size: 0.85rem;
  border-bottom: 1px solid rgba(15,23,36,0.04);
} 
.plate-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.plate-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 5px 6px;
  margin: 0;
  background: var(--bg-light, rgba(255,255,255,0.95));
  color: var(--name-text, #0f1724);
  border-radius: 0;
  border-bottom: 1px solid rgba(15,23,36,0.06);
  text-align: center;
  cursor: pointer;
  transition: all 0.2s ease;
  height: 108px;
} 

.plate-item:hover {
  background: var(--bg-light, rgba(255,255,255,0.95));
  transform: scale(1.02);
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  z-index: 10;
}
.plate-item:last-child { border-bottom: none; }

.freq-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.62rem;
  background: transparent;
}

.top-1 { border-left: 3px solid #F59E0B; }
.top-2 { border-left: 3px solid #94A3B8; }
.top-3 { border-left: 3px solid #CD7F32; }

.freq-badge { font-weight: 700; text-shadow: 0 0 0.5px rgba(0,0,0,0.12); }

.pname { display: block; padding: 0; font-weight: 700; color: #000000; text-align: center; font-size: 0.82rem; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; width: 100%; }
.pchg { font-weight: 700; text-align: center; font-size: 0.8rem; width: 100%; margin-top: 1px; }
.max-up {
  font-size: 0.68rem;
  font-weight: 700;
  color: #334155;
  width: 100%;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  height: 14px;
  line-height: 14px;
}

/* 近七天涨停数列表 - 紧凑显示（只显示数字） */
.limit-counts-list {
  margin-top: 2px;
  display: flex;
  flex-wrap: nowrap;
  gap: 1px;
  width: 100%;
  justify-content: center;
  align-items: center;
  overflow-x: auto;
  scrollbar-width: none;
}

.limit-counts-list::-webkit-scrollbar { display: none; }

.limit-count-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 14px;
  padding: 0 1px;
  background: rgba(248, 250, 252, 0.8);
  border-radius: 2px;
  transition: all 0.15s;
  border: 1px solid transparent;
  cursor: help;
}

.limit-count-item:hover {
  background: rgba(255, 255, 255, 0.95);
  transform: scale(1.1);
  z-index: 5;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.limit-count-item.current-day {
  background: rgba(59, 130, 246, 0.25);
  border: 1px solid rgba(59, 130, 246, 0.5);
}

.limit-value {
  color: #64748b;
  font-weight: 600;
  font-size: 0.58rem;
  text-align: center;
  line-height: 1;
  white-space: nowrap;
}

.limit-count-item.current-day .limit-value {
  color: #2563eb;
  font-weight: 700;
}

.limit-value.has-limit-value {
  color: #e63946;
  font-weight: 700;
}

.limit-count-item.current-day .limit-value.has-limit-value {
  color: #2563eb;
  font-weight: 700;
}

/* 近七天连板率 - 紧凑显示 */
.continuity-rates-list {
  margin-top: 2px;
  display: flex;
  flex-wrap: nowrap; /* prefer single line */
  gap: 1px;
  width: 100%;
  justify-content: center;
  align-items: center;
  overflow-x: auto; /* if too tight, scroll instead of wrapping */
  scrollbar-width: none; /* Firefox */
}

.continuity-rates-list::-webkit-scrollbar { display: none; } /* WebKit */

.rate-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 14px;
  padding: 0 1px;
  background: rgba(248, 250, 252, 0.8);
  border-radius: 2px;
  border: 1px solid transparent;
  cursor: help;
  transition: all 0.15s;
}

.rate-item:hover {
  background: rgba(255, 255, 255, 0.95);
  transform: scale(1.06);
  z-index: 5;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.rate-item.current-day {
  background: rgba(59, 130, 246, 0.22);
  border: 1px solid rgba(59, 130, 246, 0.45);
}

.rate-value {
  color: #64748b;
  font-weight: 700;
  font-size: 0.5rem;
  line-height: 1;
  white-space: nowrap;
}

.rate-item.current-day .rate-value {
  color: #2563eb;
}

.rate-value.has-rate {
  color: #111827;
}

.rate-na {
  color: #64748b;
}

.rate-num {
  font-size: 0.54rem;
  font-weight: 800;
}

.rate-sym {
  margin-left: 1px;
  font-size: 0.42rem;
  font-weight: 800;
  opacity: 0.75;
}

/* bucket-based visual emphasis */
.plate-item[data-bucket="2"] { box-shadow: 0 1px 4px rgba(96,165,250,0.04); }
.plate-item[data-bucket="3"] { box-shadow: 0 1px 6px rgba(250,200,120,0.06); }
.plate-item[data-bucket="4"] { box-shadow: 0 2px 10px rgba(255,160,0,0.12); transform: translateY(-1px); border-left: 3px solid rgba(255,165,0,0.2); }

/* dark mode support */

</style>
