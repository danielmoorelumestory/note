<script setup>
import { ref } from 'vue'
import StockAnalysis from './StockAnalysis.vue'
import SectorRotation from './SectorRotation.vue'
import PlateRanking from './PlateRanking.vue'
import PlateStockList from './PlateStockList.vue'

const currentPage = ref('home')
const stockAnalysisDate = ref(null)
const selectedPlateName = ref(null)
const previousPage = ref(null)

const goToStockAnalysis = (date = null, fromPage = null) => {
  stockAnalysisDate.value = date
  if (fromPage) previousPage.value = fromPage
  currentPage.value = 'stock-analysis'
}

const goToSectorRotation = () => {
  currentPage.value = 'sector-rotation'
}

const goToPlateRanking = () => {
  currentPage.value = 'plate-ranking'
  previousPage.value = null
}

const goToPlateStockList = (plateName) => {
  selectedPlateName.value = plateName
  previousPage.value = 'plate-ranking'
  currentPage.value = 'plate-stock-list'
}

const goHome = () => {
  currentPage.value = 'home'
  stockAnalysisDate.value = null
  selectedPlateName.value = null
  previousPage.value = null
}

const handleNavigateToAnalysis = (date) => {
  goToStockAnalysis(date, 'plate-ranking')
}

const handleNavigateToPlateList = (plateName) => {
  goToPlateStockList(plateName)
}

const handleBackFromAnalysis = () => {
  if (previousPage.value === 'plate-ranking') goToPlateRanking()
  else goHome()
}

const handleBackFromPlateList = () => {
  if (previousPage.value === 'plate-ranking') goToPlateRanking()
  else goHome()
}
</script>

<template>
  <div class="stock-lab">
    <div v-if="currentPage === 'home'" class="stock-lab-home">
      <header class="hero">
        <p class="kicker">财联社行情 · 浏览器本地缓存</p>
        <h1>股市分析工具</h1>
        <p class="lede">大涨股解读、板块轮动与板块排行。数据经 CORS 代理拉取，历史日写入 IndexedDB。</p>
      </header>

      <section class="section">
        <div class="section-head">
          <h2>功能</h2>
        </div>
        <ul class="lab-grid">
          <li>
            <button type="button" class="lab-card" @click="() => goToStockAnalysis()">
              <h3>大涨股解读</h3>
              <p class="summary">涨停梯队与各板块涨停个股，可选日期与「只看涨停」。</p>
            </button>
          </li>
          <li>
            <button type="button" class="lab-card" @click="goToSectorRotation">
              <h3>板块轮动</h3>
              <p class="summary">近 7 个交易日板块涨幅（去 ST 与「其他」），横向对比每日强弱。</p>
            </button>
          </li>
          <li>
            <button type="button" class="lab-card" @click="goToPlateRanking">
              <h3>板块排行</h3>
              <p class="summary">近 20 日板块涨幅矩阵，按涨幅 &gt;1% 出现频次排序。</p>
            </button>
          </li>
        </ul>
      </section>
    </div>

    <StockAnalysis
      v-else-if="currentPage === 'stock-analysis'"
      :key="stockAnalysisDate || 'default'"
      :initial-date="stockAnalysisDate"
      @back="handleBackFromAnalysis"
    />
    <SectorRotation v-else-if="currentPage === 'sector-rotation'" @back="goHome" />
    <PlateRanking
      v-else-if="currentPage === 'plate-ranking'"
      @back="goHome"
      @navigate-to-analysis="handleNavigateToAnalysis"
      @navigate-to-plate-list="handleNavigateToPlateList"
    />
    <PlateStockList
      v-else-if="currentPage === 'plate-stock-list'"
      :plate-name="selectedPlateName"
      @back="handleBackFromPlateList"
    />
  </div>
</template>

<style scoped>
.stock-lab-home {
  padding-bottom: 2rem;
}

.stock-lab-home :deep(.lab-grid) {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
}

@media (min-width: 640px) {
  .stock-lab-home :deep(.lab-grid) {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (min-width: 1024px) {
  .stock-lab-home :deep(.lab-grid) {
    grid-template-columns: repeat(3, 1fr);
  }
}

.lab-card {
  display: block;
  width: 100%;
  min-height: 9rem;
  padding: 1.25rem;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
  background: var(--bg-card);
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  box-shadow: var(--shadow-sm);
  transition:
    transform 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.lab-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
  box-shadow: var(--shadow-md);
}

.lab-card h3 {
  margin: 0 0 0.5rem;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--ink);
}

.lab-card .summary {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--muted);
}
</style>
