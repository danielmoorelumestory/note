<script setup>
import { ref, onMounted } from 'vue'
import { initDB, getLimitRecordsByStock, getStockDetailNotes, saveStockDetailNote, updateStockDetailNote, deleteStockDetailNote } from '../../lib/stock/db.js'

const props = defineProps({
  stockCode: {
    type: String,
    required: true
  },
  stockName: {
    type: String,
    required: true
  }
})

const emit = defineEmits(['back'])

const loading = ref(true)
const error = ref(null)
const limitRecords = ref([]) // { date, time, upNum, reason }
const notes = ref([]) // { id, date, content, timestamp }
const noteInput = ref('')
const editingNoteId = ref(null)
const editingContent = ref('')

// 加载股票的涨停记录
const loadStockLimitRecords = async () => {
  loading.value = true
  error.value = null
  limitRecords.value = []

  try {
    await initDB()
    // 查询该股票的所有涨停记录（从新表）
    const limitRecordList = await getLimitRecordsByStock(props.stockCode)
    
    if (!limitRecordList || limitRecordList.length === 0) {
      loading.value = false
      return
    }

    // 转换数据格式并按日期倒序排序
    const records = limitRecordList
      .filter(record => {
        // 只显示确实涨停的记录：有 reason 或者 upNum > 0 或者 change >= 9.8%
        return record.reason || 
               (record.upNum && record.upNum > 0) || 
               (record.change && record.change >= 0.098)
      })
      .map(record => ({
        date: record.date,
        time: record.time || null,
        upNum: record.upNum || null,
        reason: record.reason || '涨停',
        change: record.change || null
      }))
      // getLimitRecordsByStock 已经按日期倒序排序了

    limitRecords.value = records
  } catch (e) {
    console.error('加载涨停记录失败:', e)
    error.value = '加载数据失败'
  } finally {
    loading.value = false
  }
}

// 加载笔记
const loadNotes = async () => {
  try {
    await initDB()
    const noteList = await getStockDetailNotes(props.stockCode)
    notes.value = noteList
  } catch (e) {
    console.error('加载笔记失败:', e)
  }
}

// 添加笔记
const addNote = async () => {
  if (!noteInput.value || !noteInput.value.trim()) {
    alert('请输入笔记内容')
    return
  }
  
  try {
    await initDB()
    await saveStockDetailNote(props.stockCode, props.stockName, noteInput.value)
    noteInput.value = ''
    await loadNotes()
  } catch (e) {
    console.error('保存笔记失败:', e)
    alert('保存笔记失败，请重试')
  }
}

// 开始编辑笔记
const startEditNote = (note) => {
  editingNoteId.value = note.id
  editingContent.value = note.content
}

// 取消编辑
const cancelEdit = () => {
  editingNoteId.value = null
  editingContent.value = ''
}

// 保存编辑
const saveEdit = async () => {
  if (!editingContent.value || !editingContent.value.trim()) {
    alert('笔记内容不能为空')
    return
  }
  
  try {
    await initDB()
    await updateStockDetailNote(editingNoteId.value, editingContent.value)
    editingNoteId.value = null
    editingContent.value = ''
    await loadNotes()
  } catch (e) {
    console.error('更新笔记失败:', e)
    alert('更新笔记失败，请重试')
  }
}

// 删除笔记
const deleteNote = async (noteId) => {
  if (!confirm('确定要删除这条笔记吗？')) {
    return
  }
  
  try {
    await initDB()
    await deleteStockDetailNote(noteId)
    await loadNotes()
  } catch (e) {
    console.error('删除笔记失败:', e)
    alert('删除笔记失败，请重试')
  }
}

const formatDate = (yyyymmdd) => {
  if (!yyyymmdd) return '--'
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

const formatTime = (time) => {
  if (!time) return '--'
  if (time.includes(' ')) {
    return time.split(' ')[1].slice(0, 5)
  }
  return time.slice(0, 5)
}

const formatUpNum = (upNum) => {
  if (upNum === null || upNum === undefined || upNum === '') {
    return '首板'
  }
  
  if (typeof upNum === 'string') {
    return upNum
  }
  
  if (typeof upNum === 'number') {
    if (upNum > 0) {
      return `${upNum}板`
    }
    return '首板'
  }
  
  return '首板'
}

const formatCode = (code) => {
  if (!code) return '--'
  if (code.length < 8) return code
  const market = code.substring(0, 2)
  const num = code.substring(2)
  return `${num}.${market}`
}

const formatTimestamp = (timestamp) => {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

onMounted(async () => {
  await loadStockLimitRecords()
  await loadNotes()
})
</script>

<template>
  <div class="stock-limit-detail-page">
    <div class="header-bar">
      <button class="back-btn" @click="emit('back')">← 返回</button>
      <h2 class="page-title">{{ stockName }} - 股票详情</h2>
      <div class="stock-code">{{ formatCode(stockCode) }}</div>
    </div>

    <div v-if="loading" class="loading">正在加载数据…</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <div v-else class="detail-container">
      <!-- 笔记区域 -->
      <div class="notes-section">
        <div class="notes-header">
          <h3>笔记</h3>
        </div>
        <div class="note-input-area">
          <textarea
            v-model="noteInput"
            class="note-textarea"
            placeholder="输入笔记内容..."
            rows="3"></textarea>
          <button class="add-note-btn" @click="addNote">添加笔记</button>
        </div>
        <div v-if="notes.length > 0" class="notes-list">
          <div
            v-for="note in notes"
            :key="note.id"
            class="note-item">
            <div class="note-date">{{ formatDate(note.date) }}</div>
            <div v-if="editingNoteId === note.id" class="note-edit-area">
              <textarea
                v-model="editingContent"
                class="note-edit-textarea"
                rows="2"></textarea>
              <div class="note-edit-actions">
                <button class="save-edit-btn" @click="saveEdit">保存</button>
                <button class="cancel-edit-btn" @click="cancelEdit">取消</button>
              </div>
            </div>
            <div v-else class="note-content">
              <div class="note-text">{{ note.content }}</div>
              <div class="note-actions">
                <button class="edit-btn" @click="startEditNote(note)">修改</button>
                <button class="delete-btn" @click="deleteNote(note.id)">删除</button>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="no-notes">暂无笔记</div>
      </div>

      <!-- 涨停记录区域 -->
      <div v-if="limitRecords.length > 0" class="records-section">
        <div class="stats-bar">
          <span class="stat-item">涨停次数: <strong>{{ limitRecords.length }}</strong></span>
          <span class="stat-item">最早记录: <strong>{{ formatDate(limitRecords[limitRecords.length - 1].date) }}</strong></span>
          <span class="stat-item">最近记录: <strong>{{ formatDate(limitRecords[0].date) }}</strong></span>
        </div>

        <div class="records-table">
          <div class="table-header">
            <div class="col-date">涨停日期</div>
            <div class="col-time">涨停时间</div>
            <div class="col-num">板数</div>
            <div class="col-reason">涨停原因</div>
          </div>

          <div 
            v-for="(record, index) in limitRecords" 
            :key="record.date + '_' + index" 
            class="table-row"
            :class="{ 'recent': index < 3 }">
            <div class="col-date">{{ formatDate(record.date) }}</div>
            <div class="col-time">{{ formatTime(record.time) }}</div>
            <div class="col-num">
              <span class="up-num-badge">{{ formatUpNum(record.upNum) }}</span>
            </div>
            <div class="col-reason">{{ record.reason || '--' }}</div>
          </div>
        </div>
      </div>
      <div v-else class="empty">暂无涨停记录</div>
    </div>
  </div>
</template>

<style scoped>
.stock-limit-detail-page {
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
  flex: 1;
}

.stock-code {
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  font-size: 0.9rem;
  color: #64748b;
  background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
  padding: 6px 14px;
  border-radius: 6px;
  font-weight: 500;
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

.detail-container {
  max-width: 1200px;
  margin: 0 auto;
}

.notes-section {
  background: white;
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 24px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(226, 232, 240, 0.8);
}

.notes-header h3 {
  margin: 0 0 20px 0;
  font-size: 1.3rem;
  font-weight: 700;
  color: #0f172a;
  letter-spacing: -0.02em;
}

.note-input-area {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
}

.note-textarea {
  flex: 1;
  padding: 12px;
  border: 1.5px solid #cbd5e1;
  border-radius: 8px;
  font-size: 0.95rem;
  font-family: inherit;
  resize: vertical;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  line-height: 1.6;
  color: #1e293b;
}

.note-textarea:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.12);
  background: #fafbfc;
}

.add-note-btn {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 6px rgba(59, 130, 246, 0.3);
  white-space: nowrap;
}

.add-note-btn:hover {
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
}

.notes-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.note-item {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 16px;
  background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.note-item:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  transform: translateY(-2px);
}

.note-date {
  font-size: 0.85rem;
  color: #64748b;
  font-weight: 600;
  margin-bottom: 12px;
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
}

.note-content {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.note-text {
  flex: 1;
  color: #1e293b;
  font-size: 0.95rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.note-actions {
  display: flex;
  gap: 8px;
}

.edit-btn, .delete-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.edit-btn {
  background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
  color: #475569;
  border: 1px solid #cbd5e1;
}

.edit-btn:hover {
  background: linear-gradient(135deg, #e2e8f0 0%, #cbd5e1 100%);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
}

.delete-btn {
  background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
  color: #dc2626;
  border: 1px solid #fca5a5;
}

.delete-btn:hover {
  background: linear-gradient(135deg, #fecaca 0%, #fca5a5 100%);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(239, 68, 68, 0.3);
}

.note-edit-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.note-edit-textarea {
  width: 100%;
  padding: 12px;
  border: 1.5px solid #3b82f6;
  border-radius: 8px;
  font-size: 0.95rem;
  font-family: inherit;
  resize: vertical;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  line-height: 1.6;
  color: #1e293b;
}

.note-edit-textarea:focus {
  outline: none;
  box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.12);
  background: #fafbfc;
}

.note-edit-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.save-edit-btn, .cancel-edit-btn {
  padding: 8px 18px;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.save-edit-btn {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;
  box-shadow: 0 2px 6px rgba(59, 130, 246, 0.3);
}

.save-edit-btn:hover {
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
}

.cancel-edit-btn {
  background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
  color: #475569;
  border: 1px solid #cbd5e1;
}

.cancel-edit-btn:hover {
  background: linear-gradient(135deg, #e2e8f0 0%, #cbd5e1 100%);
  transform: translateY(-1px);
}

.no-notes {
  text-align: center;
  color: #94a3b8;
  font-size: 0.95rem;
  padding: 40px 0;
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
  flex-wrap: wrap;
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

.records-section {
  margin-top: 24px;
}

.records-table {
  background: white;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(226, 232, 240, 0.8);
}

.table-header {
  display: grid;
  grid-template-columns: 140px 100px 80px 1fr;
  gap: 12px;
  padding: 18px 24px;
  background: linear-gradient(to bottom, #f8fafc 0%, #f1f5f9 100%);
  border-bottom: 2px solid #e2e8f0;
  font-weight: 700;
  font-size: 0.9rem;
  color: #334155;
  letter-spacing: -0.01em;
}

.table-row {
  display: grid;
  grid-template-columns: 140px 100px 80px 1fr;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid rgba(241, 245, 249, 0.8);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  align-items: center;
}

.table-row:hover {
  background: linear-gradient(to right, #f8fafc 0%, #ffffff 100%);
}

.table-row.recent {
  background: linear-gradient(to right, #fff7ed 0%, #ffffff 100%);
  border-left: 3px solid #f59e0b;
}

.col-date {
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  font-size: 0.9rem;
  color: #475569;
  font-weight: 500;
}

.col-time {
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  font-size: 0.9rem;
  color: #64748b;
  text-align: center;
  font-weight: 500;
}

.col-num {
  text-align: center;
}

.up-num-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
  color: #dc2626;
  padding: 6px 12px;
  border-radius: 8px;
  font-weight: 700;
  font-size: 0.85rem;
  min-width: 48px;
}

.col-reason {
  color: #334155;
  font-size: 0.9rem;
  line-height: 1.5;
  word-break: break-word;
}

@media (max-width: 768px) {
  .stock-limit-detail-page {
    padding: 85px 16px 32px 16px;
  }

  .header-bar {
    flex-wrap: wrap;
    gap: 12px;
    padding: 14px 16px;
  }

  .page-title {
    font-size: 1.3rem;
  }

  .note-input-area {
    flex-direction: column;
  }

  .note-content {
    flex-direction: column;
    align-items: stretch;
  }

  .note-actions {
    justify-content: flex-end;
  }

  .table-header,
  .table-row {
    grid-template-columns: 100px 80px 70px 1fr;
    gap: 8px;
    padding: 12px 16px;
    font-size: 0.85rem;
  }
}
</style>
