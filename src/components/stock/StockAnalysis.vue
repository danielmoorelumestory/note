<script setup>
import { ref, onMounted, watch } from 'vue'
import { initDB, getPlateData, extractAndSaveAllData } from '../../lib/stock/db.js'
import { getClsSignature, fetchPlateUpDownAnalysis, getTodayYYYYMMDD, getBeijingDate, getLatestTradingDay } from '../../lib/stock/clsApi.js'
import StockLimitDetail from './StockLimitDetail.vue'

const props = defineProps({
  initialDate: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['back'])

const stockData = ref([])
const ladderData = ref([])
const loading = ref(true)
const error = ref(null)
const isFromCache = ref(false)
const detailStock = ref(null)

// Feature Restoration: Date and Filter
const getTodayStr = () => getBeijingDate()
const hasInitialDate = () => Boolean(props.initialDate && props.initialDate.length > 0)

const selectedDate = ref(hasInitialDate() ? props.initialDate : getTodayStr())
const limitUpOnly = ref(true)
let requestId = 0

const fetchStocks = async () => {
  const id = ++requestId
  const isStale = () => id !== requestId
  try {
    loading.value = true
    error.value = null

    const apiDate = selectedDate.value.replace(/-/g, '')
    const upLimit = limitUpOnly.value ? 1 : 0
    const cacheKey = `STOCK_CACHE_${apiDate}_${upLimit}`
    const todayStr = getTodayYYYYMMDD()
    const isToday = apiDate === todayStr

    await initDB()
    if (isStale()) return

    if (!isToday) {
      const cached = localStorage.getItem(cacheKey)
      if (cached) {
        const parsed = JSON.parse(cached)
        stockData.value = parsed.plate_stock || []
        ladderData.value = parsed.continuous_limit_up || []
        isFromCache.value = true
        return
      }
      const plateResult = await getPlateData(apiDate)
      if (isStale()) return
      if (plateResult?.plateData?.length > 0) {
        stockData.value = plateResult.plateData
        ladderData.value = []
        isFromCache.value = true
        return
      }
    }

    const targetUrl = `https://x-quote.cls.cn/v2/quote/a/plate/up_down_analysis?up_limit=${upLimit}&date=${apiDate}`
    const signature = await getClsSignature(targetUrl)
    const json = await fetchPlateUpDownAnalysis({ date: apiDate, upLimit, signature })
    if (isStale()) return

    stockData.value = json.data.plate_stock || []
    ladderData.value = json.data.continuous_limit_up || []
    isFromCache.value = false

    localStorage.setItem(cacheKey, JSON.stringify({
      plate_stock: json.data.plate_stock,
      continuous_limit_up: json.data.continuous_limit_up,
      timestamp: Date.now()
    }))

    try {
      await extractAndSaveAllData(apiDate, json)
      console.log('StockAnalysis: 已保存数据到数据库', apiDate)
    } catch (saveError) {
      console.warn('保存数据到数据库失败', apiDate, saveError)
    }
  } catch (e) {
    if (isStale()) return
    console.warn('StockAnalysis fetch failed', e)
    error.value = e instanceof Error && e.message ? `${e.message}（且无缓存）` : '网络请求错误，且无缓存数据'
    const apiDate = selectedDate.value.replace(/-/g, '')
    const upLimit = limitUpOnly.value ? 1 : 0
    const cacheKey = `STOCK_CACHE_${apiDate}_${upLimit}`
    const cached = localStorage.getItem(cacheKey)
    if (cached) {
      const parsed = JSON.parse(cached)
      stockData.value = parsed.plate_stock || []
      ladderData.value = parsed.continuous_limit_up || []
      isFromCache.value = true
      error.value = null
    }
  } finally {
    if (!isStale()) loading.value = false
  }
}

const formatCode = (code) => {
  if (!code) return ''
  const market = code.substring(0, 2)
  const num = code.substring(2)
  return `${num}.${market}`
}

const formatCmc = (cmc) => {
  if (!cmc) return '--'
  return (cmc / 100000000).toFixed(2) + '亿'
}

const formatTime = (time) => {
  if (!time) return '--'
  return time.split(' ')[1]
}

// Sorting and Expansion logic
const sortConfig = ref({
  key: null, // 'last_px', 'change', 'time', 'cmc'
  order: 'desc' // 'asc', 'desc'
})

const expandedStocks = ref(new Set())

const toggleSort = (key) => {
  if (sortConfig.value.key === key) {
    sortConfig.value.order = sortConfig.value.order === 'desc' ? 'asc' : 'desc'
  } else {
    sortConfig.value.key = key
    sortConfig.value.order = 'desc'
  }
}

const toggleExpand = (code) => {
  if (expandedStocks.value.has(code)) {
    expandedStocks.value.delete(code)
  } else {
    expandedStocks.value.add(code)
  }
}

const openStockDetail = (stock) => {
  detailStock.value = {
    stockCode: stock.secu_code,
    stockName: stock.secu_name,
  }
}

const openKlinePage = (stockCode) => {
  let formattedCode = stockCode || ''
  if (formattedCode.length >= 8) formattedCode = formattedCode.substring(2)
  window.open(`https://stockpage.10jqka.com.cn/${formattedCode}`, '_blank', 'noopener,noreferrer')
}

const copyStatus = ref('')
const copyAllStocks = () => {
  if (!stockData.value || stockData.value.length === 0) return
  
  const allNames = []
  stockData.value.forEach(plate => {
    // 跳过"其他"板块
    if (!plate.secu_name || plate.secu_name.includes('其他')) return
    
    if (plate.stock_list) {
      plate.stock_list.forEach(stock => {
        // 过滤掉ST和*ST股票
        if (!stock.secu_name || stock.secu_name.startsWith('ST') || stock.secu_name.startsWith('*ST')) return
        allNames.push(stock.secu_name)
      })
    }
  })
  
  const textToCopy = allNames.join('    ')
  navigator.clipboard.writeText(textToCopy).then(() => {
    copyStatus.value = '已复制股票列表'
    setTimeout(() => {
      copyStatus.value = ''
    }, 2000)
  }).catch(err => {
    console.error('Copy failed: ', err)
    copyStatus.value = '复制失败'
  })
}

const getSortedStocks = (stocks) => {
  if (!sortConfig.value.key) return stocks
  
  return [...stocks].sort((a, b) => {
    let valA = a[sortConfig.value.key]
    let valB = b[sortConfig.value.key]
    
    // Sort logic
    if (sortConfig.value.order === 'asc') {
      return valA > valB ? 1 : -1
    } else {
      return valA < valB ? 1 : -1
    }
  })
}

// Re-fetch data when inputs change
watch([selectedDate, limitUpOnly], () => {
  fetchStocks()
})

// Copy logic per plate
const copyPlateStatus = ref({}) // map of plate name -> status text
const copyPlateStocks = (plate) => {
  if (!plate || !plate.stock_list) return
  
  // 过滤掉ST和*ST股票
  const names = plate.stock_list
    .filter(s => s.secu_name && !s.secu_name.startsWith('ST') && !s.secu_name.startsWith('*ST'))
    .map(s => s.secu_name)
    .join('    ')
  
  navigator.clipboard.writeText(names).then(() => {
    copyPlateStatus.value[plate.secu_name] = '已复制'
    setTimeout(() => {
      delete copyPlateStatus.value[plate.secu_name]
    }, 2000)
  }).catch(err => {
    console.error('Copy failed', err)
  })
}

watch(() => props.initialDate, (newDate) => {
  if (newDate && newDate.length > 0) selectedDate.value = newDate
})

onMounted(async () => {
  if (!hasInitialDate()) {
    const latest = await getLatestTradingDay()
    if (latest !== selectedDate.value) {
      selectedDate.value = latest
      return
    }
  }
  fetchStocks()
})
</script>

<template>
  <StockLimitDetail
    v-if="detailStock"
    :stock-code="detailStock.stockCode"
    :stock-name="detailStock.stockName"
    @back="detailStock = null"
  />
  <div v-else class="stock-analysis-page">
    <!-- Tool Bar -->
    <div class="control-header">
      <div class="logo-area">
        <button class="back-btn" @click="emit('back')">← 返回</button>
        <span class="page-title">大涨股解读</span>
      </div>
      
      <div class="controls">
        <div class="date-picker-wrapper">
          <label>选择日期:</label>
          <input 
            type="date" 
            v-model="selectedDate" 
            :max="getTodayStr()"
            class="date-input"
          >
        </div>
        
        <div class="filter-wrapper">
          <label class="switch">
            <input type="checkbox" v-model="limitUpOnly">
            <span class="slider round"></span>
          </label>
          <span class="filter-label">只看涨停</span>
        </div>

        <button @click="copyAllStocks" class="copy-all-btn" :disabled="loading || !stockData.length">
          {{ copyStatus || '复制全部' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="loader"></div>
      <p>正在加载实时行情...</p>
    </div>

    <div v-else-if="error" class="error-state">
      {{ error }}
      <button @click="fetchStocks" class="retry-btn">重试</button>
    </div>

    <div v-else class="content-area">
      <!-- Ladder Chart -->
      <div v-if="ladderData && ladderData.length > 0" class="ladder-section">
        <h3 class="section-title">涨停梯队图</h3>
        <div class="ladder-container">
          <div v-for="tier in ladderData" :key="tier.height" class="ladder-tier">
            <div class="tier-label">{{ tier.height }}板</div>
            <div class="tier-stocks">
              <span v-for="stock in tier.stock_list" :key="stock.secu_code" class="tier-stock-item">
                {{ stock.secu_name }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Plate List -->
      <div v-if="stockData && stockData.length > 0" class="plate-list">
        <div v-for="plate in stockData" :key="plate.secu_code" class="plate-item">
          <div class="plate-header">
            <div class="plate-title-group">
              <h2 class="plate-name">{{ plate.secu_name }}</h2>
              <div class="plate-perf" :class="{ 'up': plate.change > 0 }">
                {{ plate.change > 0 ? '+' : '' }}{{ (plate.change * 100).toFixed(2) }}%
              </div>
              <span class="plate-info">({{ plate.plate_stock_up_num }}只涨停)</span>
              <span v-if="isFromCache" class="cache-tag">缓存数据</span>
            </div>
            
            <button class="copy-all-btn plate-copy-btn" @click="copyPlateStocks(plate)">
              {{ copyPlateStatus[plate.secu_name] || '复制' }}
            </button>
          </div>
          <p class="plate-reason">{{ plate.up_reason }}</p>

          <!-- List View Table -->
          <div class="stock-list-container">
            <div class="stock-list-header">
              <div class="col-name">简称</div>
              <div class="col-code">代码</div>
              <div class="col-num">板数</div>
              <div class="col-time sortable" @click="toggleSort('time')" :class="{ active: sortConfig.key === 'time' }">
                涨停时间 <span class="sort-icon">{{ sortConfig.key === 'time' ? (sortConfig.order === 'desc' ? '↓' : '↑') : '⇅' }}</span>
              </div>
              <div class="col-cmc sortable" @click="toggleSort('cmc')" :class="{ active: sortConfig.key === 'cmc' }">
                流通市值 <span class="sort-icon">{{ sortConfig.key === 'cmc' ? (sortConfig.order === 'desc' ? '↓' : '↑') : '⇅' }}</span>
              </div>
              <div class="col-change sortable" @click="toggleSort('change')" :class="{ active: sortConfig.key === 'change' }">
                涨幅 <span class="sort-icon">{{ sortConfig.key === 'change' ? (sortConfig.order === 'desc' ? '↓' : '↑') : '⇅' }}</span>
              </div>
              <div class="col-price sortable" @click="toggleSort('last_px')" :class="{ active: sortConfig.key === 'last_px' }">
                现价 <span class="sort-icon">{{ sortConfig.key === 'last_px' ? (sortConfig.order === 'desc' ? '↓' : '↑') : '⇅' }}</span>
              </div>
              <div class="col-action">详情</div>
              <div class="col-kline">行情</div>
            </div>
            
            <div v-for="stock in getSortedStocks(plate.stock_list)" :key="stock.secu_code" class="stock-list-item-wrapper">
              <div class="stock-list-item" @click="toggleExpand(stock.secu_code)" :class="{ expanded: expandedStocks.has(stock.secu_code) }">
                <div class="col-name">
                  <span class="expand-icon">{{ expandedStocks.has(stock.secu_code) ? '▼' : '▶' }}</span>
                  {{ stock.secu_name }}
                </div>
                <div class="col-code">{{ formatCode(stock.secu_code) }}</div>
                <div class="col-num">
                  <span class="stock-tag">{{ stock.up_num || '1天1板' }}</span>
                </div>
                <div class="col-time">{{ formatTime(stock.time) }}</div>
                <div class="col-cmc">{{ formatCmc(stock.cmc) }}</div>
                <div class="col-change" :class="{ 'up': stock.change > 0 }">
                  {{ stock.change > 0 ? '+' : '' }}{{ (stock.change * 100).toFixed(2) }}%
                </div>
                <div class="col-price">{{ stock.last_px.toFixed(2) }}</div>
                <div class="col-action" @click.stop>
                  <button type="button" class="detail-btn" title="查看详情" @click="openStockDetail(stock)">详情</button>
                </div>
                <div class="col-kline" @click.stop>
                  <button type="button" class="kline-btn" title="查看行情走势" @click="openKlinePage(stock.secu_code)">📈</button>
                </div>
              </div>
              <div v-show="expandedStocks.has(stock.secu_code)" class="stock-expanded-content">
                <div class="reason-label">涨停原因：</div>
                <div class="reason-text">{{ stock.up_reason }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <div v-if="(!stockData || stockData.length === 0) && (!ladderData || ladderData.length === 0)" class="empty-state">
        <p>该日期暂无数据</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stock-analysis-page {
  width: 100%;
  min-height: 100vh;
  padding: 90px 24px 40px 24px;
  background: linear-gradient(to bottom, #f8fafc 0%, #f1f5f9 100%);
  color: #1e293b;
  box-sizing: border-box;
}

.control-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 70px;
  background: linear-gradient(to right, #ffffff 0%, #f8fafc 100%);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.05);
  z-index: 100;
  backdrop-filter: blur(10px);
}

.logo-area {
  display: flex;
  align-items: center;
  gap: 15px;
}

.back-btn {
  background: linear-gradient(135deg, #e63946 0%, #dc2626 100%);
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 600;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 6px rgba(230, 57, 70, 0.3);
}

.back-btn:hover {
  background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
  transform: translateX(-3px);
  box-shadow: 0 4px 12px rgba(230, 57, 70, 0.4);
}

.back-btn:active {
  transform: translateX(-1px);
}

.logo {
  height: 30px;
}

.page-title {
  font-weight: 700;
  font-size: 1.6rem;
  color: #0f172a;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, #0f172a 0%, #475569 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.controls {
  display: flex;
  align-items: center;
  gap: 20px;
}

.copy-all-btn {
  background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
  color: #475569;
  border: 1px solid #cbd5e1;
  padding: 10px 18px;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  min-width: 100px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}

.copy-all-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #e2e8f0 0%, #cbd5e1 100%);
  border-color: #94a3b8;
  color: #334155;
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
}

.copy-all-btn:active:not(:disabled) {
  transform: translateY(0);
}

.copy-all-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  border-color: #e2e8f0;
  color: #94a3b8;
}

.date-picker-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9rem;
  color: #666;
  position: relative;
  z-index: 10;
}

.date-input {
  border: 1.5px solid #cbd5e1;
  padding: 8px 12px;
  padding-right: 35px;
  border-radius: 8px;
  outline: none;
  font-family: inherit;
  font-size: 0.9rem;
  color: #475569;
  background: white;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  cursor: pointer;
  min-width: 150px;
  position: relative;
  box-sizing: border-box;
  display: block;
  width: auto;
  z-index: 1;
}

.date-input::-webkit-calendar-picker-indicator {
  cursor: pointer;
  opacity: 1;
  width: 24px;
  height: 24px;
  padding: 0;
  margin-left: 5px;
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Cpath fill='%23475569' d='M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
}

.date-input::-webkit-inner-spin-button,
.date-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.date-input::-moz-calendar-picker-indicator {
  cursor: pointer;
  opacity: 1;
  width: 24px;
  height: 24px;
  padding: 0;
  margin-left: 5px;
}

.date-input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.12);
}

.date-input:hover {
  border-color: #94a3b8;
  background-color: #f8fafc;
}

.filter-wrapper {
  display: flex;
  align-items: center;
  gap: 10px;
}

.filter-label {
  font-size: 0.9rem;
  color: #666;
}

/* Switch Styling */
.switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #ccc;
  transition: .4s;
}

.slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: .4s;
}

input:checked + .slider {
  background: linear-gradient(135deg, #e63946 0%, #dc2626 100%);
  box-shadow: 0 2px 4px rgba(230, 57, 70, 0.3);
}

input:checked + .slider:before {
  transform: translateX(20px);
}

.slider.round {
  border-radius: 24px;
}

.slider.round:before {
  border-radius: 50%;
}

.ladder-section {
  background: white;
  padding: 24px;
  border-radius: 12px;
  margin-bottom: 32px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(226, 232, 240, 0.8);
}

.section-title {
  font-size: 1.3rem;
  font-weight: 700;
  margin-bottom: 24px;
  color: #0f172a;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: 12px;
}

.section-title::before {
  content: "";
  display: block;
  width: 4px;
  height: 20px;
  background: linear-gradient(135deg, #e63946 0%, #dc2626 100%);
  border-radius: 2px;
  box-shadow: 0 2px 4px rgba(230, 57, 70, 0.3);
}

.ladder-container {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.ladder-tier {
  display: flex;
  align-items: flex-start;
  gap: 15px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.ladder-tier:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.tier-label {
  min-width: 60px;
  background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
  color: #991b1b;
  font-weight: 700;
  font-size: 0.95rem;
  padding: 6px 0;
  border-radius: 8px;
  text-align: center;
  box-shadow: 0 2px 4px rgba(239, 68, 68, 0.2);
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.tier-stocks {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.tier-stock-item {
  font-size: 0.9rem;
  color: #334155;
  font-weight: 600;
  padding: 6px 14px;
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  border-radius: 8px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.tier-stock-item:hover {
  background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
  transform: translateY(-2px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
}

.plate-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 15px;
}

.plate-perf {
  font-weight: 700;
  font-size: 1.1rem;
  padding: 6px 14px;
  border-radius: 8px;
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  color: #64748b;
  border: 1px solid rgba(226, 232, 240, 0.8);
}

.plate-perf.up {
  background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
  color: #991b1b;
  border-color: rgba(239, 68, 68, 0.3);
  box-shadow: 0 2px 4px rgba(239, 68, 68, 0.2);
}

.stock-list-container {
  background: white;
  border-radius: 12px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  overflow: hidden;
  margin-bottom: 24px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.05);
}

.stock-list-header {
  display: flex;
  background: linear-gradient(to bottom, #f8fafc 0%, #f1f5f9 100%);
  border-bottom: 2px solid #e2e8f0;
  padding: 18px 24px;
  font-weight: 700;
  font-size: 0.9rem;
  color: #334155;
  letter-spacing: -0.01em;
  white-space: nowrap;
  align-items: center;
}

.stock-list-header > div {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  height: 100%;
  line-height: 1.2;
}

.stock-list-item-wrapper {
  border-bottom: 1px solid rgba(241, 245, 249, 0.8);
}

.stock-list-item-wrapper:last-child {
  border-bottom: none;
}

.stock-list-item {
  display: flex;
  padding: 16px 24px;
  font-size: 0.95rem;
  align-items: center;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  border-bottom: 1px solid rgba(241, 245, 249, 0.8);
}

.stock-list-item:hover {
  background: linear-gradient(to right, #f8fafc 0%, #ffffff 100%);
  transform: translateX(2px);
}

.stock-list-item.expanded {
  background: linear-gradient(to right, #fff7ed 0%, #ffffff 100%);
  border-left: 3px solid #f59e0b;
}

.col-name { 
  flex: 1; 
  font-weight: 600; 
  color: #0f172a; 
  display: flex; 
  align-items: center; 
  justify-content: center; 
  gap: 8px;
  font-size: 0.95rem;
  letter-spacing: -0.01em;
}
.expand-icon { 
  font-size: 0.65rem; 
  color: #64748b; 
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); 
  width: 14px;
}
.col-code { 
  flex: 1; 
  color: #64748b; 
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace; 
  font-size: 0.875rem; 
  text-align: center;
  font-weight: 500;
}
.col-num { 
  flex: 1; 
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
}

.stock-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
  color: #991b1b;
  padding: 4px 10px;
  border-radius: 8px;
  font-weight: 700;
  font-size: 0.85rem;
  min-width: 50px;
  border: 1px solid rgba(239, 68, 68, 0.3);
  box-shadow: 0 2px 4px rgba(239, 68, 68, 0.2);
}
.col-price { 
  flex: 1; 
  text-align: center; 
  font-weight: 600; 
  color: #475569;
  font-size: 0.95rem;
}
.col-change { 
  flex: 1; 
  text-align: center; 
  font-weight: 700; 
  color: #64748b;
  font-size: 0.95rem;
  display: flex;
  align-items: center;
  justify-content: center;
}
.col-action,
.col-kline {
  flex: 0 0 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.detail-btn {
  background: linear-gradient(135deg, #e63946 0%, #dc2626 100%);
  color: white;
  border: none;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
}
.detail-btn:hover {
  filter: brightness(0.95);
}
.kline-btn {
  background: #f8fafc;
  color: #64748b;
  border: 1px solid #cbd5e1;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 1rem;
}
.kline-btn:hover {
  background: #dbeafe;
  border-color: #3b82f6;
  color: #1e40af;
}

.col-change.up {
  color: #e63946;
}
.col-time { 
  flex: 1; 
  text-align: center; 
  color: #64748b; 
  font-size: 0.875rem;
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  font-weight: 500;
}
.col-cmc { 
  flex: 1; 
  text-align: center; 
  color: #64748b; 
  font-size: 0.875rem;
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  font-weight: 500;
}

.sortable {
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.sortable:hover {
  background: linear-gradient(135deg, #e2e8f0 0%, #cbd5e1 100%);
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  color: #0f172a;
}

.sortable.active {
  background: linear-gradient(135deg, #cbd5e1 0%, #94a3b8 100%);
  color: #0f172a;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
}

.sort-icon {
  font-size: 0.9rem;
  opacity: 0.6;
  transition: all 0.3s;
}

.sortable.active .sort-icon {
  opacity: 1;
  font-weight: 900;
  color: #0f172a;
}

.stock-expanded-content {
  padding: 20px 24px;
  background: linear-gradient(135deg, #fff7ed 0%, #ffffff 100%);
  border-top: 1px dashed rgba(245, 158, 11, 0.3);
  font-size: 0.95rem;
  line-height: 1.6;
}

.reason-label {
  font-weight: 700;
  color: #dc2626;
  margin-bottom: 8px;
  font-size: 0.95rem;
}

.reason-text {
  color: #475569;
  font-size: 0.9rem;
  line-height: 1.7;
}



@media (max-width: 900px) {
  .stock-list-header .col-code,
  .stock-list-item .col-code,
  .stock-list-header .col-cmc,
  .stock-list-item .col-cmc {
    display: none;
  }
}

@media (max-width: 750px) {
  .stock-list-header .col-price,
  .stock-list-item .col-price {
    display: none;
  }
}

@media (max-width: 600px) {
  .stock-list-header .col-change,
  .stock-list-item .col-change {
    display: none;
  }
}

@media (max-width: 480px) {
  .stock-list-header .col-time,
  .stock-list-item .col-time {
    display: none;
  }
}

.loading-state, .error-state, .empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 60vh;
}

.retry-btn {
  margin-top: 15px;
  padding: 8px 20px;
  background-color: #e63946;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.retry-btn:hover {
  background-color: #d62839;
}

.loader {
  border: 4px solid #f3f3f3;
  border-top: 4px solid #e63946;
  border-radius: 50%;
  width: 40px;
  height: 40px;
  animation: spin 1s linear infinite;
  margin-bottom: 20px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.plate-item {
  margin-bottom: 48px;
  background: white;
  padding: 24px;
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(226, 232, 240, 0.8);
}

.plate-title-group {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.plate-name {
  font-size: 1.6rem;
  color: #0f172a;
  font-weight: 700;
  border-left: 5px solid #e63946;
  padding-left: 18px;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, #0f172a 0%, #475569 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.plate-info {
  font-size: 0.9rem;
  color: #64748b;
  font-weight: 500;
}

.plate-perf {
  font-weight: 700;
  font-size: 1rem;
  padding: 6px 14px;
  border-radius: 8px;
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  color: #64748b;
  border: 1px solid rgba(226, 232, 240, 0.8);
}

.cache-tag {
  font-size: 0.8rem;
  background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
  color: #64748b;
  padding: 4px 10px;
  border-radius: 6px;
  font-weight: 500;
  margin-left: 12px;
  border: 1px solid rgba(203, 213, 225, 0.5);
}

.plate-reason {
  background: linear-gradient(135deg, #f8fafc 0%, #ffffff 100%);
  padding: 20px 24px;
  border-radius: 12px;
  font-size: 0.95rem;
  line-height: 1.7;
  color: #475569;
  margin-bottom: 24px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}


/* Mobile adjustments */
@media (max-width: 600px) {
  .control-header {
    height: auto;
    padding: 10px 15px;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  .stock-analysis-page {
    padding-top: 110px;
  }
  .controls {
    width: 100%;
    justify-content: space-between;
    gap: 10px;
  }
  .date-picker-wrapper label {
    display: none;
  }
}

.plate-copy-btn {
  font-size: 0.8rem;
  padding: 4px 12px;
  min-width: 60px;
}

</style>
