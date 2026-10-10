<script setup>
import { ref, onMounted, computed } from 'vue'
import { initDB, getPlateData, extractAndSaveAllData, getStocksWithLimitRecordsByPlate, updatePlateContinuityRate } from '../../lib/stock/db.js'
import { getTradingDays, fetchPlateDays, getTodayYYYYMMDD, getBeijingDate, recentWeekdays } from '../../lib/stock/clsApi.js'

const emit = defineEmits(['back', 'navigate-to-analysis', 'navigate-to-plate-list'])

const loading = ref(true)
const error = ref(null)
const partialError = ref(null)
const dateData = ref([]) // array of { date: 'YYYYMMDD', plates: [{ name, change }] }
const allPlates = ref([]) // array of { name, changes: { date: change } }

const formatPct = (v) => {
  if (v === null || v === undefined) return '--'
  return (v * 100).toFixed(2) + '%'
}

const formatDisplayDate = (yyyymmdd) => {
  return `${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6)}`
}

// 提取板块涨幅
const extractChange = (p) => {
  if (!p) return null
  if (p.change !== undefined && p.change !== null) {
    const n = Number(p.change)
    if (!Number.isNaN(n)) return n
  }
  return null
}

// 提取涨停数量
const extractLimitCount = (p) => {
  if (!p) return undefined

  // check a bunch of common numeric fields first
  const numericFields = [
    'up_limit_count','up_limit_cnt','up_cnt','up_count','limit_count','limit_cnt','limit_total','limit','upCount','ztCount','zt_cnt','up_num','plate_stock_up_num'
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

      // percent / change heuristics
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

  return undefined
}

// 获取最近20个交易日的数据
const fetchTwentyTradingDays = async () => {
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
    dateList = (await getTradingDays(getBeijingDate(-60), getBeijingDate())).slice(0, 20)
  } catch (e) {
    console.warn('getTradingDays 失败，回退到本地推算日期', e)
    dateList = recentWeekdays(20)
  }

  const needFetchDates = []

  for (const apiDate of dateList) {
    const isToday = apiDate === todayStr
    let plateData = null
    let plateStats = {}

    if (!isToday) {
      try {
        const plateDataResult = await getPlateData(apiDate)
        if (plateDataResult?.plateData?.length > 0) {
          console.log('PlateRanking: 从本地数据库加载数据', apiDate)
          plateData = plateDataResult.plateData
          plateStats = plateDataResult.stats || {}
        }
      } catch (e) {
        console.warn('从本地数据库查询失败', apiDate, e)
      }
    }

    if (!plateData || !Array.isArray(plateData) || plateData.length === 0) {
      needFetchDates.push(apiDate)
    } else {
      pushPlateDay(apiDate, plateData, plateStats)
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
      pushPlateDay(apiDate, updatedResult?.plateData || json.data.plate_stock, updatedResult?.stats || {})
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
  await buildAllPlates()
  loading.value = false
}

function pushPlateDay(apiDate, plateData, plateStats) {
  const plates = plateData
    .filter(p => p.secu_name)
    .filter(p => {
      const name = p.secu_name
      if (!name) return false
      if (name.toUpperCase().includes('ST')) return false
      if (name === '其他' || name === '其它') return false
      return true
    })
    .map(p => {
      const plateName = p.secu_name
      const stats = plateStats[plateName] || {}
      return {
        name: plateName,
        change: extractChange(p),
        limitCount: stats.limitCount !== undefined ? stats.limitCount : extractLimitCount(p),
        maxUpNum: stats.maxUpNum ?? null,
        raw: p
      }
    })
  if (plates.length > 0) {
    dateData.value.push({ date: apiDate, plates })
  }
}

// 构建所有板块的数据结构
const buildAllPlates = async () => {
  const plateMap = new Map()
  
  // 遍历所有日期的数据，收集所有板块
  dateData.value.forEach(dayData => {
    dayData.plates.forEach(plate => {
      if (!plateMap.has(plate.name)) {
        plateMap.set(plate.name, {
          name: plate.name,
          changes: {},
          limitCounts: {},
          continuityRates: {} // 连板率
        })
      }
      const plateInfo = plateMap.get(plate.name)
      plateInfo.changes[dayData.date] = plate.change
      plateInfo.limitCounts[dayData.date] = plate.limitCount
    })
  })
  
  allPlates.value = Array.from(plateMap.values())
  
  // 计算连板率
  await calculateContinuityRates()
  
  // 排序：按照涨幅>1的时间从近到远排序
  sortPlates()
}

// 计算连板率
const calculateContinuityRates = async () => {
  if (dateData.value.length < 2) return // 至少需要2天的数据
  
  // 遍历所有日期（从第二个日期开始，因为需要前一天的数据）
  for (let i = 0; i < dateData.value.length - 1; i++) {
    const todayData = dateData.value[i]
    const yesterdayData = dateData.value[i + 1]
    const todayDate = todayData.date
    const yesterdayDate = yesterdayData.date
    
    // 遍历所有板块
    for (const plate of allPlates.value) {
      const plateName = plate.name
      
      // 先检查数据库中是否已有连板率数据
      try {
        const plateDataResult = await getPlateData(todayDate)
        if (plateDataResult && plateDataResult.stats && plateDataResult.stats[plateName] && 
            plateDataResult.stats[plateName].continuityRate !== undefined) {
          // 使用数据库中的连板率
          plate.continuityRates[todayDate] = plateDataResult.stats[plateName].continuityRate
          continue
        }
      } catch (e) {
        console.warn(`读取板块 ${plateName} 在 ${todayDate} 的连板率失败:`, e)
      }
      
      // 检查昨天是否有此板块
      const yesterdayHasPlate = yesterdayData.plates.some(p => p.name === plateName)
      // 检查今天是否有此板块
      const todayHasPlate = todayData.plates.some(p => p.name === plateName)
      
      // 2.1 昨天没有此板块，今天有此板块 → 不显示连板率
      if (!yesterdayHasPlate && todayHasPlate) {
        plate.continuityRates[todayDate] = null
        continue
      }
      
      // 2.2 昨天有此板块，今天没有此板块 → 不用管（不显示）
      if (yesterdayHasPlate && !todayHasPlate) {
        plate.continuityRates[todayDate] = null
        continue
      }
      
      // 2.3 昨天有此板块，今天也有此板块 → 计算连板率
      if (yesterdayHasPlate && todayHasPlate) {
        try {
          // 获取昨天涨停的股票列表
          const yesterdayStocks = await getStocksWithLimitRecordsByPlate(plateName)
          const yesterdayLimitStocks = yesterdayStocks
            .filter(stock => {
              // 检查该股票在昨天是否有涨停记录
              return stock.limitDates.some(record => record.date === yesterdayDate)
            })
            .map(stock => stock.stockCode)
          
          if (yesterdayLimitStocks.length === 0) {
            // 昨天没有涨停股票，不显示连板率
            plate.continuityRates[todayDate] = null
            continue
          }
          
          // 获取今天涨停的股票列表
          const todayStocks = await getStocksWithLimitRecordsByPlate(plateName)
          const todayLimitStocks = todayStocks
            .filter(stock => {
              // 检查该股票在今天是否有涨停记录
              return stock.limitDates.some(record => record.date === todayDate)
            })
            .map(stock => stock.stockCode)
          
          // 计算昨天涨停且今天也涨停的股票数量
          const continuousLimitStocks = yesterdayLimitStocks.filter(code => 
            todayLimitStocks.includes(code)
          )
          
          // 计算连板率：昨天涨停且今天也涨停的股票数量 / 昨天涨停的股票数量
          const continuityRate = continuousLimitStocks.length / yesterdayLimitStocks.length
          plate.continuityRates[todayDate] = continuityRate
          
          // 保存连板率到数据库
          try {
            await updatePlateContinuityRate(todayDate, plateName, continuityRate)
          } catch (e) {
            console.warn(`保存板块 ${plateName} 在 ${todayDate} 的连板率失败:`, e)
          }
        } catch (e) {
          console.error(`计算板块 ${plateName} 在 ${todayDate} 的连板率失败:`, e)
          plate.continuityRates[todayDate] = null
        }
      }
    }
  }
}

// 排序逻辑：按照涨幅>1的时间从近到远排序
const sortPlates = () => {
  allPlates.value.sort((a, b) => {
    // 获取日期列表（从最新到最旧）
    const dates = dateData.value.map(d => d.date)
    
    // 从今天开始，逐日比较
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i]
      const aChange = a.changes[date]
      const bChange = b.changes[date]
      
      const aHas = aChange !== null && aChange !== undefined && aChange > 0.01
      const bHas = bChange !== null && bChange !== undefined && bChange > 0.01
      
      // 如果今天a有涨幅>1，b没有，a排在前面
      if (aHas && !bHas) return -1
      // 如果今天b有涨幅>1，a没有，b排在前面
      if (!aHas && bHas) return 1
      // 如果今天都有涨幅>1，按涨幅大小排序，涨幅大的排在前面
      if (aHas && bHas) {
        if (aChange !== bChange) {
          return bChange - aChange // 涨幅大的排在前面
        }
        // 如果涨幅相同，继续比较下一天
        continue
      }
      // 如果今天都没有涨幅>1，继续比较下一天（循环继续）
    }
    
    // 如果所有日期都相同，保持原顺序
    return 0
  })
}

// 获取板块在指定日期的涨幅
const getPlateChange = (plateName, date) => {
  const plate = allPlates.value.find(p => p.name === plateName)
  if (!plate) return null
  return plate.changes[date] ?? null
}

// 获取板块在指定日期的涨停数量
const getPlateLimitCount = (plateName, date) => {
  const plate = allPlates.value.find(p => p.name === plateName)
  if (!plate) return null
  return plate.limitCounts[date] ?? null
}

// 获取板块在指定日期的连板率
const getPlateContinuityRate = (plateName, date) => {
  const plate = allPlates.value.find(p => p.name === plateName)
  if (!plate) return null
  return plate.continuityRates?.[date] ?? null
}

// 处理单元格点击，跳转到大涨股解读页面
const handleCellClick = (date) => {
  // 将YYYYMMDD格式转换为YYYY-MM-DD格式
  const formattedDate = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}`
  emit('navigate-to-analysis', formattedDate)
}

// 处理板块名称点击，跳转到板块股票列表页面
const handlePlateNameClick = (plateName) => {
  emit('navigate-to-plate-list', plateName)
}

onMounted(() => {
  fetchTwentyTradingDays()
})
</script>

<template>
  <div class="plate-ranking-container">
    <div class="header">
      <button class="back-btn" @click="emit('back')">← 返回</button>
      <h1 class="title">板块排行</h1>
    </div>

    <div v-if="loading" class="loading">加载中...</div>
    <div v-else-if="error" class="error">
      {{ error }}
      <button class="retry-btn" @click="fetchTwentyTradingDays">重试</button>
    </div>
    <div v-else-if="dateData.length === 0" class="empty">暂无数据</div>
    <div v-else class="ranking-table-container">
      <p v-if="partialError" class="partial-error">{{ partialError }}</p>
      <div class="table-wrapper">
        <table class="ranking-table">
          <thead>
            <tr>
              <th class="plate-name-col">板块名称</th>
              <th v-for="dayData in dateData" :key="dayData.date" class="date-col">
                {{ formatDisplayDate(dayData.date) }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="plate in allPlates" :key="plate.name">
              <td 
                class="plate-name-col clickable"
                @click="handlePlateNameClick(plate.name)"
              >
                {{ plate.name }}
              </td>
              <td 
                v-for="dayData in dateData" 
                :key="dayData.date"
                class="date-col"
                :class="{ 
                  'positive': getPlateChange(plate.name, dayData.date) !== null && getPlateChange(plate.name, dayData.date) > 0.01,
                  'positive-small': getPlateChange(plate.name, dayData.date) !== null && getPlateChange(plate.name, dayData.date) > 0 && getPlateChange(plate.name, dayData.date) <= 0.01,
                  'negative': getPlateChange(plate.name, dayData.date) !== null && getPlateChange(plate.name, dayData.date) < 0,
                  'empty': getPlateChange(plate.name, dayData.date) === null
                }"
                @click="handleCellClick(dayData.date)"
              >
                <div class="cell-content">
                  <div class="change-value">{{ formatPct(getPlateChange(plate.name, dayData.date)) }}</div>
                  <div v-if="getPlateLimitCount(plate.name, dayData.date) !== null && getPlateLimitCount(plate.name, dayData.date) > 0" class="limit-info">
                    <span class="limit-label">涨停板：</span>
                    <span class="limit-count">{{ getPlateLimitCount(plate.name, dayData.date) }}</span>
                  </div>
                  <div v-if="getPlateContinuityRate(plate.name, dayData.date) !== null" class="limit-info">
                    <span class="continuity-label">连板率：</span>
                    <span class="continuity-rate">{{ (getPlateContinuityRate(plate.name, dayData.date) * 100).toFixed(1) }}%</span>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plate-ranking-container {
  width: 100%;
  min-height: 100vh;
  background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
  padding: 20px;
  user-select: none;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
}

.header {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 30px;
}

.back-btn {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.3s ease;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.back-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
}

.title {
  font-size: 2rem;
  font-weight: bold;
  color: #2d3748;
  margin: 0;
}

.retry-btn {
  margin-left: 12px;
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.partial-error {
  margin: 0 0 8px;
  font-size: 0.85rem;
  color: #b45309;
}

.loading, .error, .empty {
  text-align: center;
  padding: 40px;
  font-size: 1.2rem;
  color: #4a5568;
}

.ranking-table-container {
  background: white;
  border-radius: 8px;
  padding: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  overflow-x: auto;
}

.table-wrapper {
  overflow-x: auto;
  width: 100%;
}

.ranking-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 640px;
}

.ranking-table thead {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.ranking-table th {
  padding: 7px 5px;
  text-align: center;
  font-weight: 600;
  font-size: 0.75rem;
  white-space: nowrap;
  border-right: 1px solid rgba(255, 255, 255, 0.2);
}

.ranking-table th:last-child {
  border-right: none;
}

.plate-name-col {
  min-width: 108px;
  text-align: left;
  padding-left: 10px;
  position: sticky;
  left: 0;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  z-index: 10;
}

.ranking-table tbody tr {
  border-bottom: 1px solid #e2e8f0;
  transition: background-color 0.2s;
}

.ranking-table tbody tr:hover {
  background-color: #f7fafc;
}

.ranking-table td {
  padding: 5px 4px;
  text-align: center;
  font-size: 0.78rem;
  border-right: 1px solid #e2e8f0;
}

.ranking-table tbody .plate-name-col {
  background: white;
  font-weight: 500;
  color: #2d3748;
  position: sticky;
  left: 0;
  z-index: 5;
}

.ranking-table tbody tr:hover .plate-name-col {
  background: #f7fafc;
}

.plate-name-col.clickable {
  cursor: pointer;
  transition: all 0.2s;
}

.plate-name-col.clickable:hover {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
  color: white;
  font-weight: 600;
  transform: translateX(2px);
}

.date-col {
  min-width: 96px;
  padding: 5px 4px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.date-col.positive {
  color: #e53e3e;
  font-weight: 600;
}

.date-col.positive-small {
  color: #c53030;
  font-weight: 500;
}

.date-col.negative {
  color: #38a169;
}

.date-col.empty {
  color: #9ca3af;
  font-weight: 500;
}

.date-col:hover {
  background-color: #edf2f7;
}

.cell-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 100%;
}

.limit-info {
  display: flex;
  align-items: center;
  gap: 3px;
  justify-content: flex-start;
  margin-top: 1px;
  font-size: 0.65rem;
  white-space: nowrap;
  width: fit-content;
  margin-left: auto;
  margin-right: auto;
}

.limit-label,
.continuity-label {
  color: #6b7280;
  font-weight: 500;
  white-space: nowrap;
}

.limit-count {
  color: #374151;
  font-weight: 600;
  background: #f3f4f6;
  padding: 1px 4px;
  border-radius: 3px;
  white-space: nowrap;
  border: 1px solid #e5e7eb;
}

.continuity-rate {
  color: #374151;
  font-weight: 600;
  background: #f3f4f6;
  padding: 1px 4px;
  border-radius: 3px;
  white-space: nowrap;
  border: 1px solid #e5e7eb;
}

.change-value {
  font-size: 0.88rem;
  font-weight: 600;
}

@media (max-width: 768px) {
  .plate-ranking-container {
    padding: 10px;
  }

  .title {
    font-size: 1.5rem;
  }

  .ranking-table-container {
    padding: 10px;
  }

  .ranking-table th,
  .ranking-table td {
    padding: 4px 3px;
    font-size: 0.7rem;
  }

  .plate-name-col {
    min-width: 90px;
  }

  .date-col {
    min-width: 72px;
  }
}
</style>
