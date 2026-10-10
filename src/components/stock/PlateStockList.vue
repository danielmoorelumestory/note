<script setup>
import { ref, onMounted, computed } from 'vue'
import { initDB, getStockTagsBatch, saveStockTag, getTaggedStocksByPlate, deleteStockTag, getStocksWithLimitRecordsByPlate, inspectDatabase, inspectTable } from '../../lib/stock/db.js'
import StockLimitDetail from './StockLimitDetail.vue'

const props = defineProps({
  plateName: {
    type: String,
    required: true
  }
})

const emit = defineEmits(['back'])

const loading = ref(true)
const error = ref(null)
const stocks = ref([]) // { stockCode, stockName, limitCount, lastLimitDate, limitDates, cmc, tag }
const sortConfig = ref({
  key: null, // 'limitCount', 'lastLimitDate', 'cmc'
  order: 'desc' // 'asc', 'desc'
})
const currentView = ref('list') // 'list' | 'detail'
const selectedStock = ref({ stockCode: '', stockName: '' })
const stockTags = ref(new Map()) // Map<stockCode, tag> 用于快速查找标记
const tagHistory = ref([]) // 标记历史记录 [{ stockCode, stockName, tag, timestamp }]

// 查询板块的所有股票及其涨停信息
const loadPlateStocks = async () => {
  loading.value = true
  error.value = null
  stocks.value = []

  try {
    await initDB()
    
    // 从 stock_base 和 stock_limit_reason 表获取该板块的所有股票及其涨停记录
    const stocksWithRecords = await getStocksWithLimitRecordsByPlate(props.plateName)
    console.log(`获取到 ${stocksWithRecords.length} 只股票及其涨停记录`)
    
    const stockMap = new Map()
    
    if (stocksWithRecords && stocksWithRecords.length > 0) {
      stocksWithRecords.forEach(stock => {
        stockMap.set(stock.stockCode, {
          stockCode: stock.stockCode,
          stockName: stock.stockName,
          dates: new Set(stock.dates),
          limitDates: stock.limitDates || [],
          limitCount: stock.limitCount || 0
        })
      })
    }
    
    // 检查是否有数据
    if (stockMap.size === 0) {
      console.log(`板块 "${props.plateName}" 没有找到任何股票数据`)
      stocks.value = []
      loading.value = false
      return
    }
    
    console.log(`共找到 ${stockMap.size} 只股票`)
    
    // 转换为数组并处理数据
    const stockPromises = Array.from(stockMap.values()).map(async (stock) => {
      // 按日期倒序排列涨停记录
      stock.limitDates.sort((a, b) => b.date.localeCompare(a.date))
      
      // 获取最近涨停日期
      const lastLimitDate = stock.limitDates.length > 0 ? stock.limitDates[0].date : null
      
      // 获取最近涨停记录的流通市值（cmc）
      let cmc = null
      if (stock.limitDates.length > 0) {
        const lastLimitRecord = stock.limitDates[0]
        if (lastLimitRecord.cmc) {
          cmc = lastLimitRecord.cmc
        } else {
          // 从所有涨停记录中找最新的有cmc的记录
          const sortedInfos = stock.limitDates
            .filter(info => info.cmc)
            .sort((a, b) => b.date.localeCompare(a.date))
          if (sortedInfos.length > 0) {
            cmc = sortedInfos[0].cmc
          }
        }
      }
      
      // 获取该股票在板块中出现的最后日期
      const datesArray = Array.from(stock.dates).sort().reverse()
      const lastPlateDate = datesArray.length > 0 ? datesArray[0] : null
      
      return {
        stockCode: stock.stockCode,
        stockName: stock.stockName,
        limitCount: stock.limitCount,
        lastLimitDate,
        limitDates: stock.limitDates,
        allDates: datesArray,
        lastPlateDate,
        cmc: cmc || null
      }
    })

    const stockData = await Promise.all(stockPromises)

    // 3. 加载股票标记和笔记
    try {
      await initDB()
      const stockCodes = stockData.map(s => s.stockCode)
      
      // 加载标记
      const tagsMap = await getStockTagsBatch(props.plateName, stockCodes)
      stockTags.value = tagsMap
      
      // 加载标记历史
      const taggedStocks = await getTaggedStocksByPlate(props.plateName)
      tagHistory.value = taggedStocks
      
      // 为每个股票添加标记
      stockData.forEach(stock => {
        stock.tag = tagsMap.get(stock.stockCode) || null
      })
    } catch (e) {
      console.warn('加载股票标记和笔记失败:', e)
    }

    // 4. 初始排序：按涨停次数排序（涨停次数多的在前）
    stockData.sort((a, b) => {
      // 首先按涨停次数排序（涨停次数多的在前）
      if (a.limitCount !== b.limitCount) {
        return b.limitCount - a.limitCount
      }
      
      // 涨停次数相同，有涨停记录的排在前面
      if (a.limitCount > 0 && b.limitCount === 0) return -1
      if (a.limitCount === 0 && b.limitCount > 0) return 1
      
      // 都有涨停记录，按最近涨停日期倒序
      if (a.lastLimitDate && b.lastLimitDate) {
        return b.lastLimitDate.localeCompare(a.lastLimitDate)
      }
      
      // 都没有涨停记录，按最后出现在板块的日期倒序
      if (a.lastPlateDate && b.lastPlateDate) {
        return b.lastPlateDate.localeCompare(a.lastPlateDate)
      }
      
      // 都没有日期信息，按股票名称排序
      return a.stockName.localeCompare(b.stockName)
    })

    stocks.value = stockData
    applySort()

  } catch (e) {
    console.error('加载板块股票失败:', e)
    error.value = '加载数据失败'
  } finally {
    loading.value = false
  }
}

const formatDate = (yyyymmdd) => {
  if (!yyyymmdd) return '--'
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

const formatTime = (time) => {
  if (!time) return '--'
  // time 可能是 "2024-01-01 09:30:00" 格式，只取时间部分
  if (time.includes(' ')) {
    return time.split(' ')[1].slice(0, 5)
  }
  return time.slice(0, 5)
}

const formatCode = (code) => {
  if (!code) return '--'
  if (code.length < 8) return code
  const market = code.substring(0, 2)
  const num = code.substring(2)
  return `${num}.${market}`
}

const formatCmc = (cmc) => {
  if (!cmc || cmc === null || cmc === undefined) return '--'
  // cmc 单位是元，转换为亿
  return (cmc / 100000000).toFixed(2) + '亿'
}

// 切换排序
const toggleSort = (key) => {
  if (sortConfig.value.key === key) {
    // 同一列，切换升序/降序
    sortConfig.value.order = sortConfig.value.order === 'desc' ? 'asc' : 'desc'
  } else {
    // 不同列，设置为降序
    sortConfig.value.key = key
    sortConfig.value.order = 'desc'
  }
  applySort()
}

// 应用排序
const applySort = () => {
  if (!sortConfig.value.key) return

  const key = sortConfig.value.key
  const order = sortConfig.value.order

  stocks.value.sort((a, b) => {
    let valA, valB

    switch (key) {
      case 'limitCount':
        valA = a.limitCount || 0
        valB = b.limitCount || 0
        break
      case 'lastLimitDate':
        valA = a.lastLimitDate || ''
        valB = b.lastLimitDate || ''
        // 日期字符串比较，空字符串排最后
        if (!valA && !valB) return 0
        if (!valA) return 1
        if (!valB) return -1
        break
      case 'cmc':
        valA = a.cmc || 0
        valB = b.cmc || 0
        // 如果都为0或null，保持原顺序
        if (valA === 0 && valB === 0) return 0
        // 如果只有一个有值，有值的排在前面
        if (valA === 0) return 1
        if (valB === 0) return -1
        break
      default:
        return 0
    }

    // 数值比较
    if (key === 'limitCount' || key === 'cmc') {
      return order === 'desc' ? valB - valA : valA - valB
    }
    
    // 字符串比较（日期）
    if (key === 'lastLimitDate') {
      return order === 'desc' ? valB.localeCompare(valA) : valA.localeCompare(valB)
    }

    return 0
  })
}

const getSortIcon = (key) => {
  if (sortConfig.value.key !== key) return '⇅'
  return sortConfig.value.order === 'desc' ? '↓' : '↑'
}

const handleStockClick = (stock) => {
  selectedStock.value = {
    stockCode: stock.stockCode,
    stockName: stock.stockName
  }
  currentView.value = 'detail'
}


const openKlinePage = (stockCode) => {
  // 格式化股票代码用于第三方 K 线页面
  // 股票代码格式：前两位是市场代码（00/30=深交所，60=上交所），后面是股票代码
  // 只取数字部分，去掉市场代码前缀
  let formattedCode = stockCode
  
  if (stockCode && stockCode.length >= 8) {
    // 提取数字部分（去掉前两位市场代码）
    formattedCode = stockCode.substring(2)
  }
  
  // 使用同花顺股票页面
  // URL 格式: https://stockpage.10jqka.com.cn//${数字代码}
  const klineUrl = `https://stockpage.10jqka.com.cn/${formattedCode}`
  
  // 打开新窗口
  window.open(klineUrl, '_blank', 'noopener,noreferrer')
}

const handleBackToList = () => {
  currentView.value = 'list'
  selectedStock.value = { stockCode: '', stockName: '' }
}

// 更新股票标记
const updateStockTag = async (stockCode, stockName, tag) => {
  try {
    await initDB()
    const result = await saveStockTag(props.plateName, stockCode, stockName, tag)
    
    // 更新本地状态
    if (tag) {
      stockTags.value.set(stockCode, tag)
      // 更新标记历史
      const existingIndex = tagHistory.value.findIndex(t => t.stockCode === stockCode)
      const newTagRecord = {
        stockCode,
        stockName,
        tag,
        timestamp: result?.timestamp || Date.now()
      }
      if (existingIndex >= 0) {
        tagHistory.value[existingIndex] = newTagRecord
      } else {
        tagHistory.value.unshift(newTagRecord)
      }
      // 按时间倒序排列
      tagHistory.value.sort((a, b) => b.timestamp - a.timestamp)
    } else {
      stockTags.value.delete(stockCode)
      // 从标记历史中移除
      tagHistory.value = tagHistory.value.filter(t => t.stockCode !== stockCode)
    }
    
    const stock = stocks.value.find(s => s.stockCode === stockCode)
    if (stock) {
      stock.tag = tag || null
    }
  } catch (e) {
    console.error('更新股票标记失败:', e)
    alert('更新标记失败，请重试')
  }
}

// 删除标记
const removeTag = async (stockCode) => {
  try {
    await initDB()
    await deleteStockTag(props.plateName, stockCode)
    
    // 更新本地状态
    stockTags.value.delete(stockCode)
    tagHistory.value = tagHistory.value.filter(t => t.stockCode !== stockCode)
    
    const stock = stocks.value.find(s => s.stockCode === stockCode)
    if (stock) {
      stock.tag = null
    }
  } catch (e) {
    console.error('删除标记失败:', e)
    alert('删除标记失败，请重试')
  }
}

// 格式化时间戳
const formatTimestamp = (timestamp) => {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}


// 调试：在控制台查看数据库（开发环境）
onMounted(async () => {
  loadPlateStocks()
  
  // 开发环境：将调试函数挂载到 window，方便在控制台调用
  if (import.meta.env.DEV) {
    window.inspectDB = inspectDatabase
    window.inspectTable = inspectTable
    console.log('💡 调试提示:')
    console.log('  - inspectDB() - 查看所有表数据')
    console.log('  - inspectTable("表名") - 查看指定表')
  }
})
</script>

<template>
  <StockLimitDetail 
    v-if="currentView === 'detail'"
    :stock-code="selectedStock.stockCode"
    :stock-name="selectedStock.stockName"
    @back="handleBackToList"
  />
  
  <div v-else class="plate-stock-list-page">
    <div class="header-bar">
      <button class="back-btn" @click="emit('back')">← 返回</button>
      <h2 class="page-title">{{ plateName }} - 热门股列表</h2>
    </div>

    <div v-if="loading" class="loading">正在加载股票数据…</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <div v-else-if="stocks.length === 0" class="empty">该板块暂无股票数据</div>
    <div v-else class="stock-list-container">
      <div class="stats-bar">
        <span class="stat-item">股票总数: <strong>{{ stocks.length }}</strong></span>
        <span class="stat-item">有涨停记录: <strong>{{ stocks.filter(s => s.limitCount > 0).length }}</strong></span>
      </div>

      <!-- 标记历史 -->
      <div v-if="tagHistory.length > 0" class="tag-history-bar">
        <div class="tag-history-title">标记记录</div>
        <div class="tag-history-list">
          <div
            v-for="tagRecord in tagHistory"
            :key="tagRecord.stockCode"
            class="tag-history-item"
            :class="`tag-${tagRecord.tag}`">
            <span class="tag-label">{{ tagRecord.tag }}</span>
            <span class="tag-stock-name">{{ tagRecord.stockName }}</span>
            <span class="tag-time">{{ formatTimestamp(tagRecord.timestamp) }}</span>
            <button class="tag-delete-btn" @click="removeTag(tagRecord.stockCode)" title="删除标记">×</button>
          </div>
        </div>
      </div>

      <div class="stock-table">
        <div class="table-header">
          <div class="col-rank">排名</div>
          <div class="col-name">股票名称</div>
          <div class="col-code">代码</div>
          <div class="col-tag">风向标</div>
          <div class="col-count sortable" @click="toggleSort('limitCount')" :class="{ active: sortConfig.key === 'limitCount' }">
            涨停次数<span class="sort-icon">{{ getSortIcon('limitCount') }}</span>
          </div>
          <div class="col-date sortable" @click="toggleSort('lastLimitDate')" :class="{ active: sortConfig.key === 'lastLimitDate' }">
            最近涨停日期 <span class="sort-icon">{{ getSortIcon('lastLimitDate') }}</span>
          </div>
          <div class="col-cmc sortable" @click="toggleSort('cmc')" :class="{ active: sortConfig.key === 'cmc' }">
            流通市值 <span class="sort-icon">{{ getSortIcon('cmc') }}</span>
          </div>
          <div class="col-action">详情</div>
          <div class="col-note">行情走势</div>
        </div>

        <div 
          v-for="(stock, index) in stocks" 
          :key="stock.stockCode" 
          class="table-row"
          :class="{ 'has-limit': stock.limitCount > 0 }">
          <div class="col-rank">{{ index + 1 }}</div>
          <div class="col-name">{{ stock.stockName }}</div>
          <div class="col-code">{{ formatCode(stock.stockCode) }}</div>
          <div class="col-tag" @click.stop>
            <select
              :value="stock.tag || ''"
              @change="updateStockTag(stock.stockCode, stock.stockName, $event.target.value || null)"
              class="tag-select"
              :class="stock.tag ? `tag-${stock.tag}` : ''"
              @click.stop>
              <option value="">请选择</option>
              <option value="中军">中军</option>
              <option value="龙头">龙头</option>
              <option value="老龙">老龙</option>
            </select>
          </div>
          <div class="col-count">
            <span v-if="stock.limitCount > 0" class="limit-count-badge">{{ stock.limitCount }}</span>
            <span v-else class="no-limit">0</span>
          </div>
          <div class="col-date">{{ formatDate(stock.lastLimitDate) }}</div>
          <div class="col-cmc">{{ formatCmc(stock.cmc) }}</div>
          <div class="col-action">
            <button 
              v-if="stock.limitCount > 0" 
              class="detail-btn"
              @click.stop="handleStockClick(stock)"
              title="查看详情">
              详情
            </button>
            <span v-else class="no-action">--</span>
          </div>
          <div class="col-note">
            <button
              class="kline-btn"
              @click.stop="openKlinePage(stock.stockCode)"
              title="查看行情走势">
              📈
            </button>
          </div>
        </div>
      </div>
    </div>
    
  </div>
</template>

<style scoped>
.plate-stock-list-page {
  padding: 90px 24px 40px 24px;
  min-height: 100vh;
  background: linear-gradient(to bottom, #f8fafc 0%, #f1f5f9 100%);
  color: #1e293b;
}

.header-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  background: linear-gradient(to right, #ffffff 0%, #f8fafc 100%);
  padding: 18px 24px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.05);
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 20px;
  backdrop-filter: blur(10px);
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

.page-title {
  margin: 0;
  font-size: 1.6rem;
  font-weight: 700;
  color: #0f172a;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, #0f172a 0%, #475569 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.loading, .error, .empty {
  padding: 80px 24px;
  text-align: center;
  color: #64748b;
  font-size: 1.05rem;
  background: white;
  border-radius: 12px;
  margin: 24px 0;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(226, 232, 240, 0.8);
}

.error {
  color: #ef4444;
  background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%);
  border: 1px solid #fecaca;
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.15), 0 0 1px rgba(239, 68, 68, 0.3);
}

.stats-bar {
  display: flex;
  gap: 32px;
  padding: 24px 28px;
  background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%);
  border-radius: 12px;
  margin-bottom: 24px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(226, 232, 240, 0.8);
}

.tag-history-bar {
  background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%);
  border-radius: 12px;
  padding: 20px 24px;
  margin-bottom: 24px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(226, 232, 240, 0.8);
}

.tag-history-title {
  font-weight: 700;
  font-size: 1rem;
  color: #0f172a;
  margin-bottom: 16px;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 8px;
}

.tag-history-title::before {
  content: '🏷️';
  font-size: 1.1rem;
}

.tag-history-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.tag-history-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 8px;
  font-size: 0.875rem;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  cursor: default;
}

.tag-history-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
}

.tag-history-item.tag-中军 {
  background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
  border: 1px solid #fcd34d;
  box-shadow: 0 2px 8px rgba(245, 158, 11, 0.2);
}

.tag-history-item.tag-龙头 {
  background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
  border: 1px solid #fca5a5;
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.2);
}

.tag-history-item.tag-老龙 {
  background: linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%);
  border: 1px solid #a5b4fc;
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.2);
}

.tag-label {
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 0.75rem;
  letter-spacing: 0.5px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.tag-history-item.tag-中军 .tag-label {
  background: linear-gradient(135deg, #fcd34d 0%, #fbbf24 100%);
  color: #78350f;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.3);
}

.tag-history-item.tag-龙头 .tag-label {
  background: linear-gradient(135deg, #fca5a5 0%, #f87171 100%);
  color: #7f1d1d;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.3);
}

.tag-history-item.tag-老龙 .tag-label {
  background: linear-gradient(135deg, #a5b4fc 0%, #818cf8 100%);
  color: #312e81;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.3);
}

.tag-stock-name {
  font-weight: 600;
  color: #0f172a;
  flex: 1;
  min-width: 80px;
  letter-spacing: -0.01em;
}

.tag-time {
  color: #64748b;
  font-size: 0.8rem;
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  white-space: nowrap;
  font-weight: 500;
}

.tag-delete-btn {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border: 1.5px solid rgba(239, 68, 68, 0.3);
  border-radius: 50%;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 1.2rem;
  font-weight: 700;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  padding: 0;
  line-height: 1;
  flex-shrink: 0;
}

.tag-delete-btn:hover {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: white;
  border-color: #dc2626;
  transform: scale(1.15) rotate(90deg);
  box-shadow: 0 4px 10px rgba(239, 68, 68, 0.4);
}

.tag-delete-btn:active {
  transform: scale(1.05) rotate(90deg);
}

.stat-item {
  font-size: 0.95rem;
  color: #475569;
  font-weight: 500;
  display: flex;
  align-items: center;
}

.stat-item strong {
  color: #e63946;
  font-size: 1.2rem;
  margin-left: 6px;
  font-weight: 700;
  background: linear-gradient(135deg, #e63946 0%, #dc2626 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.stock-table {
  background: white;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.05);
  margin-bottom: 32px;
  border: 1px solid rgba(226, 232, 240, 0.8);
}

.table-header {
  display: grid;
  grid-template-columns: 60px 150px 90px 100px 130px 140px 120px 90px 90px;
  gap: 14px;
  padding: 18px 24px;
  background: linear-gradient(to bottom, #f8fafc 0%, #f1f5f9 100%);
  border-bottom: 2px solid #e2e8f0;
  font-weight: 700;
  font-size: 0.9rem;
  color: #334155;
  letter-spacing: -0.01em;
  white-space: nowrap;
  align-items: center;
}

.table-header > div {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  line-height: 1.2;
  text-align: center;
}

.sortable {
  cursor: pointer;
  user-select: none;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  padding: 0;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 100%;
}

.sortable:hover {
  background: linear-gradient(135deg, #e2e8f0 0%, #cbd5e1 100%);
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
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

.table-row {
  display: grid;
  grid-template-columns: 60px 150px 90px 100px 130px 140px 120px 90px 90px;
  gap: 14px;
  padding: 16px 24px;
  border-bottom: 1px solid rgba(241, 245, 249, 0.8);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  align-items: center;
  position: relative;
}

.table-row::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: transparent;
  transition: all 0.3s;
}

.table-row.has-limit {
  background: linear-gradient(to right, #fff7ed 0%, #ffffff 100%);
  border-left: 3px solid #f59e0b;
}

.table-row:last-child {
  border-bottom: none;
}

.col-rank {
  text-align: center;
  font-weight: 700;
  color: #64748b;
  font-size: 0.95rem;
  background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  margin: 0 auto;
}

.col-name {
  font-weight: 600;
  color: #0f172a;
  font-size: 0.95rem;
  letter-spacing: -0.01em;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
}

.col-code {
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  font-size: 0.875rem;
  color: #64748b;
  font-weight: 500;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
}

.col-count {
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
}

.limit-count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #e63946 0%, #dc2626 100%);
  color: white;
  padding: 6px 12px;
  border-radius: 8px;
  font-weight: 700;
  font-size: 0.875rem;
  min-width: 36px;
  height: 28px;
  box-shadow: 0 2px 6px rgba(230, 57, 70, 0.3);
  transition: all 0.3s;
}

.limit-count-badge:hover {
  transform: scale(1.05);
  box-shadow: 0 4px 10px rgba(230, 57, 70, 0.4);
}

.no-limit {
  color: #cbd5e1;
  font-size: 0.9rem;
  font-weight: 500;
}

.col-date {
  font-size: 0.875rem;
  color: #475569;
  text-align: center;
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
}

.col-cmc {
  font-size: 0.875rem;
  color: #475569;
  text-align: center;
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
}

.col-tag {
  text-align: center;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tag-select {
  padding: 10px 14px;
  border: 1.5px solid #cbd5e1;
  border-radius: 10px;
  background: white;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  min-width: 100px;
  width: 100%;
  color: #64748b;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14'%3E%3Cpath fill='%2364748b' d='M7 10L2 5h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  padding-right: 38px;
}

.tag-select:hover {
  border-color: #3b82f6;
  background-color: #f8fafc;
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.15);
  transform: translateY(-1px);
}

.tag-select:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.12);
  background-color: white;
}

/* 选中后的样式 */
.tag-select.tag-中军 {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14'%3E%3Cpath fill='%2378350f' d='M7 10L2 5h10z'/%3E%3C/svg%3E"),
                    linear-gradient(135deg, #fef3c7 0%, #fde68a 50%, #fcd34d 100%);
  background-position: right 12px center, center;
  background-repeat: no-repeat, no-repeat;
  background-size: 14px 14px, auto;
  color: #78350f;
  border-color: #f59e0b;
  font-weight: 700;
  box-shadow: 0 3px 8px rgba(245, 158, 11, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

.tag-select.tag-龙头 {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14'%3E%3Cpath fill='%237f1d1d' d='M7 10L2 5h10z'/%3E%3C/svg%3E"),
                    linear-gradient(135deg, #fee2e2 0%, #fecaca 50%, #fca5a5 100%);
  background-position: right 12px center, center;
  background-repeat: no-repeat, no-repeat;
  background-size: 14px 14px, auto;
  color: #7f1d1d;
  border-color: #ef4444;
  font-weight: 700;
  box-shadow: 0 3px 8px rgba(239, 68, 68, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

.tag-select.tag-老龙 {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14'%3E%3Cpath fill='%23312e81' d='M7 10L2 5h10z'/%3E%3C/svg%3E"),
                    linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 50%, #a5b4fc 100%);
  background-position: right 12px center, center;
  background-repeat: no-repeat, no-repeat;
  background-size: 14px 14px, auto;
  color: #312e81;
  border-color: #6366f1;
  font-weight: 700;
  box-shadow: 0 3px 8px rgba(99, 102, 241, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

.tag-select.tag-中军:hover,
.tag-select.tag-龙头:hover,
.tag-select.tag-老龙:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

.tag-select.tag-中军:focus,
.tag-select.tag-龙头:focus,
.tag-select.tag-老龙:focus {
  outline: none;
  box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.12), 0 3px 8px rgba(245, 158, 11, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

.col-action {
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
}

.detail-btn {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;
  border: none;
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 600;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 6px rgba(59, 130, 246, 0.3);
  letter-spacing: 0.3px;
}

.detail-btn:hover {
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
}

.detail-btn:active {
  transform: translateY(0) scale(0.98);
}

.col-note {
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
}

.kline-btn {
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  color: #64748b;
  border: 1.5px solid #cbd5e1;
  padding: 8px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 1.1rem;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  min-width: 48px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}

.kline-btn:hover {
  background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
  border-color: #3b82f6;
  color: #1e40af;
  transform: translateY(-2px) scale(1.05);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
}

.no-action {
  color: #cbd5e1;
  font-size: 0.9rem;
  font-weight: 500;
}


@media (max-width: 768px) {
  .plate-stock-list-page {
    padding: 85px 16px 32px 16px;
  }

  .header-bar {
    padding: 14px 16px;
  }

  .page-title {
    font-size: 1.3rem;
  }

  .stats-bar {
    padding: 20px;
    gap: 20px;
    flex-direction: column;
    gap: 12px;
  }

  .tag-history-bar {
    padding: 16px 18px;
  }

  .tag-history-title {
    font-size: 0.95rem;
    margin-bottom: 12px;
  }

  .tag-history-list {
    gap: 8px;
  }

  .tag-history-item {
    font-size: 0.8rem;
    padding: 8px 12px;
    gap: 8px;
  }

  .tag-stock-name {
    min-width: 60px;
    font-size: 0.85rem;
  }

  .tag-time {
    font-size: 0.75rem;
  }

  .tag-delete-btn {
    width: 20px;
    height: 20px;
    font-size: 1rem;
  }

  .table-header,
  .table-row {
    grid-template-columns: 50px 120px 80px 90px 100px 100px 80px 70px 70px;
    gap: 8px;
    padding: 12px 16px;
    font-size: 0.85rem;
  }

  .col-date,
  .col-cmc {
    display: none;
  }
  
  .tag-select {
    min-width: 80px;
    padding: 7px 10px;
    font-size: 0.85rem;
    padding-right: 30px;
  }
  
  .kline-btn {
    padding: 6px 10px;
    font-size: 1rem;
    min-width: 40px;
  }

  .detail-btn {
    padding: 6px 14px;
    font-size: 0.8rem;
  }

  .col-rank {
    width: 28px;
    height: 28px;
    font-size: 0.85rem;
  }
}
</style>
