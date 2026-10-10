// IndexedDB 数据库工具类
// 数据库名: stock_rotation_db
// 版本: 6
// 表1: plate_data - 存储日期和板块数据（API响应缓存）
// 表2: stock_tag - 股票标记（中军/龙头/老龙）
// 表3: stock_detail_note - 股票详情笔记（按日期）
// 表4: stock_base - 股票基础表
// 表5: stock_limit_record - 股票涨停记录表

const DB_NAME = 'stock_rotation_db'
const DB_VERSION = 11

let dbInstance = null

// 初始化数据库
export const initDB = () => {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance)
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      console.error('IndexedDB 打开失败:', request.error)
      reject(request.error)
    }

    request.onsuccess = () => {
      dbInstance = request.result
      console.log('IndexedDB 打开成功，版本:', DB_VERSION)
      console.log('当前表列表:', Array.from(dbInstance.objectStoreNames))
      resolve(dbInstance)
    }

    request.onupgradeneeded = (event) => {
      console.log('数据库升级中，旧版本:', event.oldVersion, '新版本:', event.newVersion)
      const db = event.target.result
      console.log('升级前的表列表:', Array.from(db.objectStoreNames))

      // 删除已废弃的表
      if (event.oldVersion < 6) {
        if (db.objectStoreNames.contains('plate_stock_relation')) {
          console.log('删除废弃表: plate_stock_relation')
          db.deleteObjectStore('plate_stock_relation')
        }
        if (db.objectStoreNames.contains('stock_limit_info')) {
          console.log('删除废弃表: stock_limit_info')
          db.deleteObjectStore('stock_limit_info')
        }
        if (db.objectStoreNames.contains('stock_note')) {
          console.log('删除废弃表: stock_note')
          db.deleteObjectStore('stock_note')
        }
      }
      
      // 删除 stock_base 表中的 firstSeenDate 和 lastSeenDate 字段（版本7）
      if (event.oldVersion < 7 && db.objectStoreNames.contains('stock_base')) {
        console.log('删除 stock_base 表以移除 firstSeenDate 和 lastSeenDate 字段')
        db.deleteObjectStore('stock_base')
      }

      // 表1: plate_data - 主键: date (YYYYMMDD格式)
      if (!db.objectStoreNames.contains('plate_data')) {
        console.log('创建表: plate_data')
        const plateStore = db.createObjectStore('plate_data', { keyPath: 'date' })
        plateStore.createIndex('timestamp', 'timestamp', { unique: false })
      }

      // 表2: stock_tag - 股票标记（中军/龙头/老龙），主键: id (plateName_stockCode字符串组合)
      if (!db.objectStoreNames.contains('stock_tag')) {
        console.log('创建表: stock_tag')
        const tagStore = db.createObjectStore('stock_tag', { keyPath: 'id' })
        tagStore.createIndex('plateName', 'plateName', { unique: false })
        tagStore.createIndex('stockCode', 'stockCode', { unique: false })
        tagStore.createIndex('tag', 'tag', { unique: false })
      }

      // 表3: stock_detail_note - 股票详情笔记（按日期），主键: id (stockCode_timestamp字符串组合)
      if (!db.objectStoreNames.contains('stock_detail_note')) {
        console.log('创建表: stock_detail_note')
        const detailNoteStore = db.createObjectStore('stock_detail_note', { keyPath: 'id' })
        detailNoteStore.createIndex('stockCode', 'stockCode', { unique: false })
        detailNoteStore.createIndex('date', 'date', { unique: false })
        detailNoteStore.createIndex('timestamp', 'timestamp', { unique: false })
      }

      // 表4: stock_base - 股票基础表，主键: stockCode
      // 用途：存储股票基础信息和涨停的数值字段
      // 字段说明：
      // - stockCode: 股票代码（主键）
      // - stockName: 股票名称
      // - plateNames: 所属板块名称列表（逗号分隔，如 "AI医疗,人工智能"）
      // - dates: 出现时间列表（逗号分隔的日期，如 "20240101,20240102"）
      // - times: 涨停时间列表（逗号分隔，按日期顺序对应，如 "09:30,10:15"）
      // - upNums: 连板数列表（逗号分隔，按日期顺序对应，如 "1,2,3"）
      // - changes: 涨幅列表（逗号分隔，按日期顺序对应，如 "0.10,0.10,0.10"）
      // - lastPxs: 最新价列表（逗号分隔，按日期顺序对应）
      // - cmcs: 市值列表（逗号分隔，按日期顺序对应）
      // - createTime: 创建时间戳
      // - updateTime: 更新时间戳
      // 注意：times, upNums, changes, lastPxs, cmcs 都是按日期顺序存储，索引对应 dates 数组
      if (!db.objectStoreNames.contains('stock_base')) {
        console.log('创建表: stock_base')
        const stockBaseStore = db.createObjectStore('stock_base', { keyPath: 'stockCode' })
        stockBaseStore.createIndex('stockName', 'stockName', { unique: false })
        // 注意：plateNames, dates, times 等是逗号分隔的字符串，无法直接索引
        // 查询时需要通过 getAll() 然后过滤，或者使用专门的查询函数
      }

      // 表5: stock_limit_reason - 股票涨停原因表，主键: id (date_stockCode)
      // 用途：存储股票的涨停时间和原因（按日期）
      // 字段说明：
      // - id: 主键 "date_stockCode"（同一只股票在同一天只保存一条记录）
      // - stockCode: 股票代码
      // - stockName: 股票名称
      // - date: 日期（YYYYMMDD）
      // - time: 涨停时间
      // - reason: 涨停原因
      // - timestamp: 创建时间戳
      if (!db.objectStoreNames.contains('stock_limit_reason')) {
        console.log('创建表: stock_limit_reason')
        const reasonStore = db.createObjectStore('stock_limit_reason', { keyPath: 'id' })
        reasonStore.createIndex('stockCode', 'stockCode', { unique: false })
        reasonStore.createIndex('date', 'date', { unique: false })
        reasonStore.createIndex('stockDateKey', 'stockDateKey', { unique: false }) // stockCode_date
      }

      // 表6: plate_stock_mapping - 板块与股票映射表，主键: id (plateName_stockCode)
      // 用途：快速查询板块下的所有股票，避免遍历 stock_base 表
      // 字段说明：
      // - id: 主键 "plateName_stockCode"（同一只股票在同一板块只保存一条记录）
      // - plateName: 板块名称
      // - stockCode: 股票代码
      // - stockName: 股票名称（冗余字段，方便查询）
      // - timestamp: 创建时间戳
      if (!db.objectStoreNames.contains('plate_stock_mapping')) {
        console.log('创建表: plate_stock_mapping')
        const mappingStore = db.createObjectStore('plate_stock_mapping', { keyPath: 'id' })
        mappingStore.createIndex('plateName', 'plateName', { unique: false })
        mappingStore.createIndex('stockCode', 'stockCode', { unique: false })
      }

      // 表6: plate_stock_mapping - 板块与股票映射表，主键: id (plateName_stockCode)
      // 用途：快速查询板块下的所有股票，避免遍历 stock_base 表
      // 字段说明：
      // - id: 主键 "plateName_stockCode"（同一只股票在同一板块只保存一条记录）
      // - plateName: 板块名称
      // - stockCode: 股票代码
      // - stockName: 股票名称（冗余字段，方便查询）
      // - timestamp: 创建时间戳
      if (!db.objectStoreNames.contains('plate_stock_mapping')) {
        console.log('创建表: plate_stock_mapping')
        const mappingStore = db.createObjectStore('plate_stock_mapping', { keyPath: 'id' })
        mappingStore.createIndex('plateName', 'plateName', { unique: false })
        mappingStore.createIndex('stockCode', 'stockCode', { unique: false })
      }
      
      console.log('数据库升级完成，当前表列表:', Array.from(db.objectStoreNames))
    }
  })
}

// 获取数据库实例
const getDB = async () => {
  if (!dbInstance) {
    await initDB()
  }
  return dbInstance
}

// ==================== plate_data 操作 ====================

// 保存或更新板块数据
// plateDataStats: { plateName: { plate_stock_up_num, maxUp, maxUpNum, continuityRate } }
// plate_stock_up_num: 接口返回的涨停板数量
// maxUp: 板块中所有股票的最大 up_num 值（字符串格式，例如 "9天6板"）
// maxUpNum: 板块中所有股票的最大板数（数字，例如 "9天6板" -> 6）
// continuityRate: 连板率
export const savePlateData = async (date, plateData, plateDataStats = null) => {
  // 在创建事务之前先读取已有数据（避免事务冲突）
  let finalStats = plateDataStats || {}
  if (plateDataStats !== null) {
    // 如果提供了新的统计数据，合并保留已有的连板率
    try {
      const existing = await getPlateData(date)
      if (existing && existing.stats) {
        // 合并统计数据：保留已有的连板率，使用新的 maxUp 和 maxUpNum
        Object.keys(existing.stats).forEach(plateName => {
          if (existing.stats[plateName].continuityRate !== undefined) {
            if (!finalStats[plateName]) {
              finalStats[plateName] = {}
            }
            finalStats[plateName].continuityRate = existing.stats[plateName].continuityRate
          }
        })
      }
    } catch (e) {
      console.warn('合并已有统计数据失败:', e)
    }
  } else {
    // 如果没有提供新的统计数据，使用已有的统计数据
    try {
      const existing = await getPlateData(date)
      if (existing && existing.stats) {
        finalStats = existing.stats
      }
    } catch (e) {
      console.warn('读取已有统计数据失败:', e)
    }
  }
  
  // 将统计数据合并到 plateData 中
  const mergedPlateData = Array.isArray(plateData) ? plateData.map(plate => {
    const plateName = plate.secu_name
    if (!plateName || !finalStats[plateName]) {
      return plate
    }
    
    // 合并统计数据到板块对象中
    return {
      ...plate,
      ...finalStats[plateName]
    }
  }) : plateData
  
  // 现在创建事务并保存数据
  const db = await getDB()
  const tx = db.transaction(['plate_data'], 'readwrite')
  const store = tx.objectStore('plate_data')
  
  const data = {
    date: date,
    plateData: mergedPlateData, // 已合并统计数据的板块数据
    stats: finalStats, // 保留 stats 字段以兼容旧代码和单独更新（如连板率）
    timestamp: Date.now()
  }
  
  return new Promise((resolve, reject) => {
    const request = store.put(data)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// 获取指定日期的板块数据
export const getPlateData = async (date) => {
  const db = await getDB()
  const tx = db.transaction(['plate_data'], 'readonly')
  const store = tx.objectStore('plate_data')
  
  return new Promise((resolve, reject) => {
    const request = store.get(date)
    request.onsuccess = () => {
      const result = request.result
      if (result) {
        resolve({
          plateData: result.plateData,
          stats: result.stats || {} // 返回统计数据
        })
      } else {
        resolve(null)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

// 更新板块的连板率
export const updatePlateContinuityRate = async (date, plateName, continuityRate) => {
  const db = await getDB()
  const tx = db.transaction(['plate_data'], 'readwrite')
  const store = tx.objectStore('plate_data')
  
  return new Promise((resolve, reject) => {
    const request = store.get(date)
    request.onsuccess = () => {
      const result = request.result
      if (result) {
        if (!result.stats) {
          result.stats = {}
        }
        if (!result.stats[plateName]) {
          result.stats[plateName] = {}
        }
        result.stats[plateName].continuityRate = continuityRate
        
        const putRequest = store.put(result)
        putRequest.onsuccess = () => resolve(result)
        putRequest.onerror = () => reject(putRequest.error)
      } else {
        reject(new Error('数据不存在'))
      }
    }
    request.onerror = () => reject(request.error)
  })
}

// 获取多个日期的板块数据
export const getPlateDataBatch = async (dates) => {
  const db = await getDB()
  const tx = db.transaction(['plate_data'], 'readonly')
  const store = tx.objectStore('plate_data')
  
  const results = []
  let completed = 0
  
  return new Promise((resolve, reject) => {
    if (dates.length === 0) {
      resolve([])
      return
    }
    
    dates.forEach(date => {
      const request = store.get(date)
      request.onsuccess = () => {
        const result = request.result
        if (result) {
          results.push({ 
            date, 
            plateData: result.plateData,
            stats: result.stats || {}
          })
        }
        completed++
        if (completed === dates.length) {
          resolve(results.sort((a, b) => a.date.localeCompare(b.date)))
        }
      }
      request.onerror = () => {
        completed++
        if (completed === dates.length) {
          reject(request.error)
        }
      }
    })
  })
}


// ==================== stock_tag 操作 ====================

// 保存或更新股票标记（记录历史）
export const saveStockTag = async (plateName, stockCode, stockName, tag) => {
  const db = await getDB()
  const tx = db.transaction(['stock_tag'], 'readwrite')
  const store = tx.objectStore('stock_tag')
  
  // 使用 plateName_stockCode 作为主键
  const id = `${plateName}_${stockCode}`
  
  const timestamp = Date.now()
  
  // 如果标记为 null，删除记录
  if (!tag || tag.trim() === '') {
    return new Promise((resolve, reject) => {
      const request = store.delete(id)
      request.onsuccess = () => resolve(null)
      request.onerror = () => reject(request.error)
    })
  }
  
  const data = {
    id,
    plateName,
    stockCode,
    stockName,
    tag: tag.trim(), // '中军', '龙头', '老龙'
    timestamp: timestamp, // 标记时间
    updateTime: timestamp // 更新时间
  }
  
  return new Promise((resolve, reject) => {
    const request = store.put(data)
    request.onsuccess = () => resolve({ ...data })
    request.onerror = () => reject(request.error)
  })
}

// 根据板块和股票代码查询标记
export const getStockTag = async (plateName, stockCode) => {
  const db = await getDB()
  const tx = db.transaction(['stock_tag'], 'readonly')
  const store = tx.objectStore('stock_tag')
  
  const id = `${plateName}_${stockCode}`
  
  return new Promise((resolve, reject) => {
    const request = store.get(id)
    request.onsuccess = () => {
      const result = request.result
      resolve(result ? result.tag : null)
    }
    request.onerror = () => reject(request.error)
  })
}

// 根据板块查询所有标记的股票（带时间戳）
export const getTaggedStocksByPlate = async (plateName) => {
  const db = await getDB()
  const tx = db.transaction(['stock_tag'], 'readonly')
  const store = tx.objectStore('stock_tag')
  const index = store.index('plateName')
  
  return new Promise((resolve, reject) => {
    const request = index.getAll(plateName)
    request.onsuccess = () => {
      const result = request.result
        .filter(item => item.tag !== null && item.tag !== '') // 只返回有标记的
        .map(item => ({
          id: item.id,
          stockCode: item.stockCode,
          stockName: item.stockName,
          tag: item.tag,
          timestamp: item.timestamp || item.updateTime || Date.now()
        }))
        .sort((a, b) => b.timestamp - a.timestamp) // 按时间倒序排列
      resolve(result)
    }
    request.onerror = () => reject(request.error)
  })
}

// 删除标记记录
export const deleteStockTag = async (plateName, stockCode) => {
  const db = await getDB()
  const tx = db.transaction(['stock_tag'], 'readwrite')
  const store = tx.objectStore('stock_tag')
  
  const id = `${plateName}_${stockCode}`
  
  return new Promise((resolve, reject) => {
    const request = store.delete(id)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

// 批量获取股票标记（用于列表显示）
export const getStockTagsBatch = async (plateName, stockCodes) => {
  const db = await getDB()
  const tx = db.transaction(['stock_tag'], 'readonly')
  const store = tx.objectStore('stock_tag')
  
  const tagsMap = new Map()
  
  return new Promise((resolve, reject) => {
    if (stockCodes.length === 0) {
      resolve(tagsMap)
      return
    }
    
    let completed = 0
    stockCodes.forEach(stockCode => {
      const id = `${plateName}_${stockCode}`
      const request = store.get(id)
      request.onsuccess = () => {
        const result = request.result
        if (result && result.tag) {
          tagsMap.set(stockCode, result.tag)
        }
        completed++
        if (completed === stockCodes.length) {
          resolve(tagsMap)
        }
      }
      request.onerror = () => {
        completed++
        if (completed === stockCodes.length) {
          reject(request.error)
        }
      }
    })
  })
}


// ==================== stock_detail_note 操作 ====================

// 保存股票详情笔记（按日期存储，支持多条）
export const saveStockDetailNote = async (stockCode, stockName, content) => {
  const db = await getDB()
  const tx = db.transaction(['stock_detail_note'], 'readwrite')
  const store = tx.objectStore('stock_detail_note')
  
  const timestamp = Date.now()
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '') // YYYYMMDD
  const id = `${stockCode}_${timestamp}`
  
  if (!content || content.trim() === '') {
    return Promise.reject(new Error('笔记内容不能为空'))
  }
  
  const data = {
    id,
    stockCode,
    stockName,
    date,
    content: content.trim(),
    timestamp
  }
  
  return new Promise((resolve, reject) => {
    const request = store.add(data)
    request.onsuccess = () => resolve({ ...data })
    request.onerror = () => reject(request.error)
  })
}

// 获取股票的所有详情笔记（按时间倒序）
export const getStockDetailNotes = async (stockCode) => {
  const db = await getDB()
  const tx = db.transaction(['stock_detail_note'], 'readonly')
  const store = tx.objectStore('stock_detail_note')
  const index = store.index('stockCode')
  
  return new Promise((resolve, reject) => {
    const request = index.getAll(stockCode)
    request.onsuccess = () => {
      const result = request.result
        .map(item => ({
          id: item.id,
          stockCode: item.stockCode,
          stockName: item.stockName,
          date: item.date,
          content: item.content,
          timestamp: item.timestamp
        }))
        .sort((a, b) => b.timestamp - a.timestamp) // 按时间倒序
      resolve(result)
    }
    request.onerror = () => reject(request.error)
  })
}

// 更新股票详情笔记
export const updateStockDetailNote = async (noteId, content) => {
  const db = await getDB()
  const tx = db.transaction(['stock_detail_note'], 'readwrite')
  const store = tx.objectStore('stock_detail_note')
  
  if (!content || content.trim() === '') {
    return Promise.reject(new Error('笔记内容不能为空'))
  }
  
  return new Promise((resolve, reject) => {
    const getRequest = store.get(noteId)
    getRequest.onsuccess = () => {
      const note = getRequest.result
      if (!note) {
        reject(new Error('笔记不存在'))
        return
      }
      
      note.content = content.trim()
      note.timestamp = Date.now() // 更新修改时间
      
      const putRequest = store.put(note)
      putRequest.onsuccess = () => resolve({ ...note })
      putRequest.onerror = () => reject(putRequest.error)
    }
    getRequest.onerror = () => reject(getRequest.error)
  })
}

// 删除股票详情笔记
export const deleteStockDetailNote = async (noteId) => {
  const db = await getDB()
  const tx = db.transaction(['stock_detail_note'], 'readwrite')
  const store = tx.objectStore('stock_detail_note')
  
  return new Promise((resolve, reject) => {
    const request = store.delete(noteId)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

// ==================== stock_base 操作 ====================

// 保存或更新股票基础信息
// 如果 isLimit 为 true，还需要保存涨停的数值字段（time, upNum, change, lastPx, cmc）
export const saveStockBase = async (stockCode, stockName, plateName, date, isLimit = false, time = null, upNum = null, change = null, lastPx = null, cmc = null) => {
  const db = await getDB()
  const tx = db.transaction(['stock_base'], 'readwrite')
  const store = tx.objectStore('stock_base')
  
  return new Promise((resolve, reject) => {
    const getRequest = store.get(stockCode)
    getRequest.onsuccess = () => {
      const existing = getRequest.result
      
      if (existing) {
        // 更新现有记录
        // 更新板块列表
        const plateNames = existing.plateNames ? existing.plateNames.split(',').filter(p => p) : []
        if (!plateNames.includes(plateName)) {
          plateNames.push(plateName)
        }
        
        // 更新时间列表和对应的数值字段
        const dates = existing.dates ? existing.dates.split(',').filter(d => d) : []
        const times = existing.times ? existing.times.split(',') : []
        const upNums = existing.upNums ? existing.upNums.split(',') : []
        const changes = existing.changes ? existing.changes.split(',') : []
        const lastPxs = existing.lastPxs ? existing.lastPxs.split(',') : []
        const cmcs = existing.cmcs ? existing.cmcs.split(',') : []
        
        // 找到日期在数组中的位置，如果不存在则添加
        const dateIndex = dates.indexOf(date)
        if (dateIndex === -1) {
          // 新日期，添加到末尾
          dates.push(date)
          // 保持数组长度一致
          while (times.length < dates.length) times.push('')
          while (upNums.length < dates.length) upNums.push('')
          while (changes.length < dates.length) changes.push('')
          while (lastPxs.length < dates.length) lastPxs.push('')
          while (cmcs.length < dates.length) cmcs.push('')
          
          // 按日期排序，同时调整其他数组
          const sortedIndices = dates.map((d, i) => ({ date: d, index: i }))
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(item => item.index)
          
          const sortedDates = sortedIndices.map(i => dates[i])
          const sortedTimes = sortedIndices.map(i => times[i])
          const sortedUpNums = sortedIndices.map(i => upNums[i])
          const sortedChanges = sortedIndices.map(i => changes[i])
          const sortedLastPxs = sortedIndices.map(i => lastPxs[i])
          const sortedCmcs = sortedIndices.map(i => cmcs[i])
          
          dates.length = 0
          dates.push(...sortedDates)
          times.length = 0
          times.push(...sortedTimes)
          upNums.length = 0
          upNums.push(...sortedUpNums)
          changes.length = 0
          changes.push(...sortedChanges)
          lastPxs.length = 0
          lastPxs.push(...sortedLastPxs)
          cmcs.length = 0
          cmcs.push(...sortedCmcs)
          
          // 找到新日期在排序后的位置
          const newDateIndex = dates.indexOf(date)
          if (isLimit) {
            times[newDateIndex] = time || ''
            upNums[newDateIndex] = upNum !== null && upNum !== undefined ? String(upNum) : ''
            changes[newDateIndex] = change !== null && change !== undefined ? String(change) : ''
            lastPxs[newDateIndex] = lastPx !== null && lastPx !== undefined ? String(lastPx) : ''
            cmcs[newDateIndex] = cmc !== null && cmc !== undefined ? String(cmc) : ''
          }
        } else {
          // 日期已存在，更新对应位置的数值字段
          if (isLimit) {
            if (time) times[dateIndex] = time
            if (upNum !== null && upNum !== undefined) upNums[dateIndex] = String(upNum)
            if (change !== null && change !== undefined) changes[dateIndex] = String(change)
            if (lastPx !== null && lastPx !== undefined) lastPxs[dateIndex] = String(lastPx)
            if (cmc !== null && cmc !== undefined) cmcs[dateIndex] = String(cmc)
          }
        }
        
        existing.stockName = stockName // 更新股票名称（使用最新的）
        existing.plateNames = plateNames.join(',')
        existing.dates = dates.join(',')
        existing.times = times.join(',')
        existing.upNums = upNums.join(',')
        existing.changes = changes.join(',')
        existing.lastPxs = lastPxs.join(',')
        existing.cmcs = cmcs.join(',')
        existing.updateTime = Date.now()
        
        const putRequest = store.put(existing)
        putRequest.onsuccess = () => resolve(existing)
        putRequest.onerror = () => reject(putRequest.error)
      } else {
        // 创建新记录
        const data = {
          stockCode,
          stockName,
          plateNames: plateName, // 逗号分隔的板块名称
          dates: date, // 逗号分隔的日期列表
          times: isLimit && time ? time : '', // 涨停时间列表
          upNums: isLimit && upNum !== null && upNum !== undefined ? String(upNum) : '', // 连板数列表
          changes: isLimit && change !== null && change !== undefined ? String(change) : '', // 涨幅列表
          lastPxs: isLimit && lastPx !== null && lastPx !== undefined ? String(lastPx) : '', // 最新价列表
          cmcs: isLimit && cmc !== null && cmc !== undefined ? String(cmc) : '', // 市值列表
          createTime: Date.now(),
          updateTime: Date.now()
        }
        
        const addRequest = store.add(data)
        addRequest.onsuccess = () => resolve(data)
        addRequest.onerror = () => reject(addRequest.error)
      }
    }
    getRequest.onerror = () => reject(getRequest.error)
  })
}

// 根据股票代码获取股票基础信息
export const getStockBase = async (stockCode) => {
  const db = await getDB()
  const tx = db.transaction(['stock_base'], 'readonly')
  const store = tx.objectStore('stock_base')
  
  return new Promise((resolve, reject) => {
    const request = store.get(stockCode)
    request.onsuccess = () => {
      const result = request.result
      if (result) {
        // 将逗号分隔的字符串转换为数组
        if (result.plateNames) {
          result.plateNamesArray = result.plateNames.split(',').filter(p => p)
        }
        if (result.dates) {
          result.datesArray = result.dates.split(',').filter(d => d)
        }
        if (result.times) {
          result.timesArray = result.times.split(',').filter(t => t)
        }
        if (result.upNums) {
          result.upNumsArray = result.upNums.split(',').filter(u => u).map(u => u ? Number(u) : null)
        }
        if (result.changes) {
          result.changesArray = result.changes.split(',').filter(c => c).map(c => c ? Number(c) : null)
        }
        if (result.lastPxs) {
          result.lastPxsArray = result.lastPxs.split(',').filter(p => p).map(p => p ? Number(p) : null)
        }
        if (result.cmcs) {
          result.cmcsArray = result.cmcs.split(',').filter(c => c).map(c => c ? Number(c) : null)
        }
      }
      resolve(result || null)
    }
    request.onerror = () => reject(request.error)
  })
}

// ==================== plate_stock_mapping 操作 ====================

// 保存板块与股票的映射关系
export const savePlateStockMapping = async (plateName, stockCode, stockName) => {
  const db = await getDB()
  const tx = db.transaction(['plate_stock_mapping'], 'readwrite')
  const store = tx.objectStore('plate_stock_mapping')
  
  const id = `${plateName}_${stockCode}`
  
  return new Promise((resolve, reject) => {
    const data = {
      id,
      plateName,
      stockCode,
      stockName,
      timestamp: Date.now()
    }
    
    const request = store.put(data)
    request.onsuccess = () => resolve(data)
    request.onerror = () => reject(request.error)
  })
}

// 根据板块名称获取该板块下的所有股票（从映射表，性能优化）
export const getStocksByPlateFromMapping = async (plateName) => {
  const db = await getDB()
  const tx = db.transaction(['plate_stock_mapping'], 'readonly')
  const store = tx.objectStore('plate_stock_mapping')
  const index = store.index('plateName')
  
  return new Promise((resolve, reject) => {
    const request = index.getAll(plateName)
    request.onsuccess = () => {
      const stocks = request.result.map(mapping => ({
        stockCode: mapping.stockCode,
        stockName: mapping.stockName
      }))
      resolve(stocks)
    }
    request.onerror = () => reject(request.error)
  })
}

// 根据板块名称获取该板块下的所有股票（从基础表）
export const getStocksByPlateFromBase = async (plateName) => {
  const db = await getDB()
  const tx = db.transaction(['stock_base'], 'readonly')
  const store = tx.objectStore('stock_base')
  
  return new Promise((resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => {
      const stocks = request.result
        .filter(stock => {
          if (!stock.plateNames) return false
          const plateNames = stock.plateNames.split(',').filter(p => p)
          return plateNames.includes(plateName)
        })
        .map(stock => {
          const dates = stock.dates ? stock.dates.split(',').filter(d => d) : []
          const times = stock.times ? stock.times.split(',') : []
          const upNums = stock.upNums ? stock.upNums.split(',').filter(u => u).map(u => u ? Number(u) : null) : []
          const changes = stock.changes ? stock.changes.split(',').filter(c => c).map(c => c ? Number(c) : null) : []
          const lastPxs = stock.lastPxs ? stock.lastPxs.split(',').filter(p => p).map(p => p ? Number(p) : null) : []
          const cmcs = stock.cmcs ? stock.cmcs.split(',').filter(c => c).map(c => c ? Number(c) : null) : []
          
          return {
            stockCode: stock.stockCode,
            stockName: stock.stockName,
            plateNames: stock.plateNames ? stock.plateNames.split(',').filter(p => p) : [],
            dates,
            times,
            upNums,
            changes,
            lastPxs,
            cmcs
          }
        })
      resolve(stocks)
    }
    request.onerror = () => reject(request.error)
  })
}

// ==================== stock_limit_reason 操作 ====================

// 保存股票涨停原因（按日期）
export const saveStockLimitReason = async (stockCode, stockName, date, time, reason) => {
  const db = await getDB()
  const tx = db.transaction(['stock_limit_reason'], 'readwrite')
  const store = tx.objectStore('stock_limit_reason')
  
  // 主键：date_stockCode（同一只股票在同一天只保存一条记录）
  const id = `${date}_${stockCode}`
  
  return new Promise((resolve, reject) => {
    const data = {
      id,
      stockCode,
      stockName,
      date,
      time: time || null,
      reason: reason || null,
      timestamp: Date.now()
    }
    
    const request = store.put(data)
    request.onsuccess = () => resolve(data)
    request.onerror = () => reject(request.error)
  })
}

// 根据股票代码获取所有涨停原因记录
export const getLimitReasonsByStock = async (stockCode) => {
  const db = await getDB()
  const tx = db.transaction(['stock_limit_reason'], 'readonly')
  const store = tx.objectStore('stock_limit_reason')
  const index = store.index('stockCode')
  
  return new Promise((resolve, reject) => {
    const request = index.getAll(stockCode)
    request.onsuccess = () => {
      resolve(request.result.sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date) // 日期倒序
        return (a.time || '').localeCompare(b.time || '')
      }))
    }
    request.onerror = () => reject(request.error)
  })
}

// 根据日期获取涨停原因记录
export const getLimitReasonsByDate = async (date) => {
  const db = await getDB()
  const tx = db.transaction(['stock_limit_reason'], 'readonly')
  const store = tx.objectStore('stock_limit_reason')
  const index = store.index('date')
  
  return new Promise((resolve, reject) => {
    const request = index.getAll(date)
    request.onsuccess = () => {
      resolve(request.result.sort((a, b) => (a.time || '').localeCompare(b.time || '')))
    }
    request.onerror = () => reject(request.error)
  })
}

// 根据股票代码和日期获取涨停原因
export const getLimitReasonByStockAndDate = async (stockCode, date) => {
  const db = await getDB()
  const tx = db.transaction(['stock_limit_reason'], 'readonly')
  const store = tx.objectStore('stock_limit_reason')
  
  const id = `${date}_${stockCode}`
  
  return new Promise((resolve, reject) => {
    const request = store.get(id)
    request.onsuccess = () => {
      resolve(request.result || null)
    }
    request.onerror = () => reject(request.error)
  })
}

// ==================== 辅助函数 ====================

// 根据板块名称获取该板块下的所有股票及其涨停记录（合并 stock_base 和 stock_limit_reason）
export const getStocksWithLimitRecordsByPlate = async (plateName) => {
  // 1. 从映射表快速获取股票代码列表（性能优化）
  const stockMappings = await getStocksByPlateFromMapping(plateName)
  const stockCodes = stockMappings.map(s => s.stockCode)
  
  if (stockCodes.length === 0) {
    return []
  }
  
  // 2. 从 stock_base 获取这些股票的详细信息
  const db = await getDB()
  const tx = db.transaction(['stock_base'], 'readonly')
  const store = tx.objectStore('stock_base')
  
  const stocks = await Promise.all(
    stockCodes.map(stockCode => {
      return new Promise((resolve, reject) => {
        const request = store.get(stockCode)
        request.onsuccess = () => {
          const stock = request.result
          if (stock) {
            const dates = stock.dates ? stock.dates.split(',').filter(d => d) : []
            const times = stock.times ? stock.times.split(',') : []
            const upNums = stock.upNums ? stock.upNums.split(',').filter(u => u).map(u => u ? Number(u) : null) : []
            const changes = stock.changes ? stock.changes.split(',').filter(c => c).map(c => c ? Number(c) : null) : []
            const lastPxs = stock.lastPxs ? stock.lastPxs.split(',').filter(p => p).map(p => p ? Number(p) : null) : []
            const cmcs = stock.cmcs ? stock.cmcs.split(',').filter(c => c).map(c => c ? Number(c) : null) : []
            
            resolve({
              stockCode: stock.stockCode,
              stockName: stock.stockName,
              plateNames: stock.plateNames ? stock.plateNames.split(',').filter(p => p) : [],
              dates,
              times,
              upNums,
              changes,
              lastPxs,
              cmcs
            })
          } else {
            resolve(null)
          }
        }
        request.onerror = () => reject(request.error)
      })
    })
  )
  
  // 过滤掉 null 值
  const validStocks = stocks.filter(s => s !== null)
  
  // 3. 为每只股票获取涨停原因记录
  const stockPromises = validStocks.map(async (stock) => {
    const reasons = await getLimitReasonsByStock(stock.stockCode)
    
    // 合并数据：将 stock_base 中的数值字段和 stock_limit_reason 中的 reason 合并
    const dates = stock.dates || []
    const times = stock.times || []
    const upNums = stock.upNums || []
    const changes = stock.changes || []
    const lastPxs = stock.lastPxs || []
    const cmcs = stock.cmcs || []
    
    // 创建日期到索引的映射
    const dateToIndex = new Map()
    dates.forEach((d, i) => {
      dateToIndex.set(d, i)
    })
    
    // 创建日期到 reason 的映射
    const dateToReason = new Map()
    reasons.forEach(r => {
      dateToReason.set(r.date, r)
    })
    
    // 构建完整的涨停记录列表
    const limitDates = dates.map((date, index) => {
      const reasonData = dateToReason.get(date)
      return {
        date,
        time: reasonData?.time || times[index] || null,
        reason: reasonData?.reason || null,
        upNum: upNums[index] || null,
        change: changes[index] || null,
        lastPx: lastPxs[index] || null,
        cmc: cmcs[index] || null
      }
    }).filter(record => {
      // 只返回有涨停信息的记录（有 reason 或者有数值字段）
      return record.reason || record.upNum || record.change || record.time
    })
    
    return {
      ...stock,
      limitDates,
      limitCount: limitDates.length
    }
  })
  
  return Promise.all(stockPromises)
}

// 根据股票代码获取所有涨停记录（合并 stock_base 和 stock_limit_reason）
export const getLimitRecordsByStock = async (stockCode) => {
  // 1. 从 stock_base 获取股票基础信息
  const stockBase = await getStockBase(stockCode)
  if (!stockBase) {
    return []
  }
  
  // 2. 从 stock_limit_reason 获取涨停原因
  const reasons = await getLimitReasonsByStock(stockCode)
  
  // 3. 合并数据
  const dates = stockBase.datesArray || []
  const times = stockBase.timesArray || []
  const upNums = stockBase.upNumsArray || []
  const changes = stockBase.changesArray || []
  const lastPxs = stockBase.lastPxsArray || []
  const cmcs = stockBase.cmcsArray || []
  
  // 创建日期到 reason 的映射
  const dateToReason = new Map()
  reasons.forEach(r => {
    dateToReason.set(r.date, r)
  })
  
  // 构建完整的涨停记录列表
  const limitRecords = dates.map((date, index) => {
    const reasonData = dateToReason.get(date)
    return {
      date,
      time: reasonData?.time || times[index] || null,
      reason: reasonData?.reason || null,
      upNum: upNums[index] || null,
      change: changes[index] || null,
      lastPx: lastPxs[index] || null,
      cmc: cmcs[index] || null
    }
  }).filter(record => {
    // 只返回有涨停信息的记录
    return record.reason || record.upNum || record.change || record.time
  }).sort((a, b) => b.date.localeCompare(a.date)) // 按日期倒序
  
  return limitRecords
}

// 从 API 响应中提取并保存所有相关数据
export const extractAndSaveAllData = async (date, apiResponse) => {
  // 确保数据库已初始化
  await initDB()
  
  if (!apiResponse || apiResponse.code !== 200 || !Array.isArray(apiResponse.data?.plate_stock)) {
    return
  }

  const plateData = apiResponse.data.plate_stock
  const stockBaseMap = new Map() // 用于收集股票基础信息
  const limitReasons = [] // 涨停原因记录（只存储 time 和 reason）
  const plateStats = {} // 板块统计数据：{ plateName: { plate_stock_up_num, maxUp, maxUpNum } }
  // plate_stock_up_num: 接口返回的涨停板数量
  // maxUp: 板块中所有股票的最大 up_num 值（字符串格式，例如 "9天6板"）
  // maxUpNum: 板块中所有股票的最大板数（数字，例如 "9天6板" -> 6）

  // 遍历每个板块
  plateData.forEach(plate => {
    const plateName = plate.secu_name
    if (!plateName) return

    // 提取接口返回的涨停板数量
    const plateStockUpNum = plate.plate_stock_up_num !== undefined && plate.plate_stock_up_num !== null 
      ? (typeof plate.plate_stock_up_num === 'number' ? plate.plate_stock_up_num : parseInt(plate.plate_stock_up_num))
      : null

    // 提取股票列表（可能有多个字段名）
    const stockList = plate.stock_list || plate.stocks || plate.stockList || plate.stocks_list || []
    
    // 初始化板块统计数据
    let maxUp = null // 最大 up_num 值（字符串格式，例如 "3天3板"）
    let maxUpNum = null // 最大连板天数（数字，例如 3）
    
    if (Array.isArray(stockList) && stockList.length > 0) {
      stockList.forEach(stock => {
        const stockCode = stock.secu_code || stock.code || stock.stock_code
        const stockName = stock.secu_name || stock.name || stock.stock_name
        
        if (stockCode && stockName) {
          // 收集股票基础信息
          if (!stockBaseMap.has(stockCode)) {
            stockBaseMap.set(stockCode, {
              stockCode,
              stockName,
              plateNames: new Set([plateName]),
              dates: new Set([date])
            })
          } else {
            const baseInfo = stockBaseMap.get(stockCode)
            baseInfo.plateNames.add(plateName)
            baseInfo.dates.add(date)
            baseInfo.stockName = stockName // 使用最新的股票名称
          }

          // 如果是涨停股票，保存涨停信息
          const isLimit = stock.limit === 1 || 
                         stock.is_limit === true || 
                         stock.up_limit === 1 || 
                         stock.zdt === 1 || 
                         stock.isZt === true ||
                         (stock.change && stock.change >= 0.089) ||
                         (stock.pct && parseFloat(stock.pct) >= 9.8)

          // 如果是涨停股票，保存涨停的详细信息
          if (isLimit) {
            const time = stock.time || null
            const reason = stock.up_reason || plate.up_reason || null
            const upNum = (stock.up_num !== undefined && stock.up_num !== null && stock.up_num !== '') 
              ? stock.up_num 
              : (stock.limit_num !== undefined && stock.limit_num !== null && stock.limit_num !== '') 
                ? stock.limit_num 
                : null
            
            // 解析 up_num 字段，提取板数
            // maxUp: 板块中所有股票的最大 up_num 值（字符串格式，例如 "9天6板"）
            // maxUpNum: 板块中所有股票的最大板数（数字，例如 "9天6板" -> 6）
            if (upNum !== null && upNum !== undefined) {
              let upNumStr = String(upNum)
              let boards = null // 板数
              let days = null   // 天数（用于比较，取板数最大的）
              
              // 尝试解析格式：X天X板
              if (upNumStr.includes('板')) {
                const boardMatch = upNumStr.match(/(\d+)板/)
                if (boardMatch) {
                  boards = parseInt(boardMatch[1])
                }
                // 如果有"天"，也提取天数用于比较
                if (upNumStr.includes('天')) {
                  const dayMatch = upNumStr.match(/(\d+)天/)
                  if (dayMatch) {
                    days = parseInt(dayMatch[1])
                  }
                }
              } else if (upNumStr.includes('天')) {
                // 如果只有"天"没有"板"，假设板数等于天数
                const dayMatch = upNumStr.match(/(\d+)天/)
                if (dayMatch) {
                  days = parseInt(dayMatch[1])
                  boards = days
                }
              } else {
                // 如果只是数字，假设是板数
                const numValue = parseInt(upNumStr)
                if (!isNaN(numValue)) {
                  boards = numValue
                }
              }
              
              // 更新 maxUp 和 maxUpNum：取板数最大的 up_num 值
              if (boards !== null && boards !== undefined) {
                if (maxUpNum === null || boards > maxUpNum) {
                  maxUp = upNumStr
                  maxUpNum = boards
                } else if (boards === maxUpNum && maxUp === null) {
                  // 如果板数相同且 maxUp 为空，也保存
                  maxUp = upNumStr
                }
              } else if (maxUp === null) {
                // 如果无法解析板数，但 maxUp 为空，也保存
                maxUp = upNumStr
              }
            }
            
            const change = stock.change || stock.pct || null
            const lastPx = stock.last_px || stock.price || null
            const cmc = stock.cmc || stock.market_cap || null
            
            // 保存到 stock_base 表（包含数值字段）
            // 注意：这里需要更新 baseInfo，以便后续保存时包含这些信息
            const baseInfo = stockBaseMap.get(stockCode)
            if (baseInfo) {
              // 确保日期在 dates 中
              baseInfo.dates.add(date)
              // 存储涨停的数值信息（按日期）
              if (!baseInfo.limitData) {
                baseInfo.limitData = new Map()
              }
              baseInfo.limitData.set(date, {
                time,
                upNum,
                change,
                lastPx,
                cmc
              })
            }
            
            // 保存到涨停原因表（只存储 time 和 reason）
            limitReasons.push({
              stockCode,
              stockName,
              date,
              time,
              reason
            })
          }
        }
      })
      
      // 保存板块统计数据
      // 只要有任何一个字段有值，就保存该板块的统计数据
      if (plateStockUpNum !== null || maxUp !== null || maxUpNum !== null) {
        plateStats[plateName] = {
          plate_stock_up_num: plateStockUpNum !== null && !isNaN(plateStockUpNum) ? plateStockUpNum : null, // 接口返回的涨停板数量
          maxUp: maxUp !== null ? maxUp : null, // 最大 up_num 值（字符串格式，例如 "9天6板"）
          maxUpNum: maxUpNum !== null ? maxUpNum : null // 最大板数（数字，例如 "9天6板" -> 6）
        }
      }
    }
  })

    // 批量保存
  try {
    console.log(`开始保存数据: 日期=${date}, 板块数=${plateData.length}, 股票数=${stockBaseMap.size}`)
    
    // 1. 保存板块数据（包含统计数据）
    await savePlateData(date, plateData, plateStats)
    console.log('板块数据已保存，统计数据:', plateStats)
    
    // 1.5. 保存板块与股票的映射关系（用于快速查询）
    const mappingPromises = Array.from(stockBaseMap.values()).flatMap(baseInfo => {
      const plateNamesArray = Array.from(baseInfo.plateNames)
      return plateNamesArray.map(plateName =>
        savePlateStockMapping(plateName, baseInfo.stockCode, baseInfo.stockName)
      )
    })
    await Promise.all(mappingPromises)
    console.log(`映射关系已保存: ${mappingPromises.length} 条记录`)
    
    // 2. 保存股票基础信息（每个股票只保存一次，合并所有板块名称和日期）
    const stockBasePromises = Array.from(stockBaseMap.values()).map(async (baseInfo) => {
      const plateNamesArray = Array.from(baseInfo.plateNames)
      const datesArray = Array.from(baseInfo.dates).sort() // 按日期排序
      
      // 为每个板块和日期的组合调用 saveStockBase
      // saveStockBase 内部会合并板块和日期，所以多次调用是安全的
      for (const plateName of plateNamesArray) {
        for (const dateStr of datesArray) {
          // 获取该日期的涨停数据
          const limitData = baseInfo.limitData?.get(dateStr)
          if (limitData) {
            // 有涨停数据，保存数值字段
            await saveStockBase(
              baseInfo.stockCode,
              baseInfo.stockName,
              plateName,
              dateStr,
              true, // isLimit
              limitData.time,
              limitData.upNum,
              limitData.change,
              limitData.lastPx,
              limitData.cmc
            )
          } else {
            // 没有涨停数据，只保存基础信息（板块和日期）
            await saveStockBase(
              baseInfo.stockCode,
              baseInfo.stockName,
              plateName,
              dateStr,
              false // isLimit
            )
          }
        }
      }
    })
    await Promise.all(stockBasePromises)
    console.log(`股票基础信息已保存: ${stockBasePromises.length} 只股票`)
    
    // 3. 保存股票涨停原因（time 和 reason）
    if (limitReasons.length > 0) {
      const limitReasonPromises = limitReasons.map(reason =>
        saveStockLimitReason(
          reason.stockCode,
          reason.stockName,
          reason.date,
          reason.time,
          reason.reason
        )
      )
      await Promise.all(limitReasonPromises)
    }
    
    console.log(`已保存数据: 日期=${date}, 板块数=${plateData.length}, 涨停数=${limitReasons.length}, 股票基础数=${stockBaseMap.size}`)
  } catch (error) {
    console.error('保存数据到数据库失败:', error)
    throw error
  }
}

// ==================== 调试函数 ====================

// 查看数据库结构和数据（调试用）
export const inspectDatabase = async () => {
  const db = await getDB()
  const stores = Array.from(db.objectStoreNames)
  
  console.log('=== 数据库结构 ===')
  console.log(`数据库名: ${DB_NAME}`)
  console.log(`版本: ${DB_VERSION}`)
  console.log(`表列表:`, stores)
  
  const results = {}
  
  for (const storeName of stores) {
    const tx = db.transaction([storeName], 'readonly')
    const store = tx.objectStore(storeName)
    const request = store.getAll()
    
    await new Promise((resolve, reject) => {
      request.onsuccess = () => {
        results[storeName] = {
          count: request.result.length,
          sample: request.result.slice(0, 3), // 只显示前3条作为示例
          all: request.result // 完整数据
        }
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
  }
  
  console.log('\n=== 各表数据统计 ===')
  for (const [storeName, data] of Object.entries(results)) {
    console.log(`\n【${storeName}】`)
    console.log(`  总记录数: ${data.count}`)
    if (data.count > 0) {
      console.log(`  示例数据（前3条）:`, data.sample)
      console.log(`  完整数据:`, data.all)
    }
  }
  
  return results
}

// 查看指定表的数据
export const inspectTable = async (tableName) => {
  const db = await getDB()
  const tx = db.transaction([tableName], 'readonly')
  const store = tx.objectStore(tableName)
  const request = store.getAll()
  
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      console.log(`=== ${tableName} 表数据 ===`)
      console.log(`总记录数: ${request.result.length}`)
      console.log('数据:', request.result)
      resolve(request.result)
    }
    request.onerror = () => reject(request.error)
  })
}

// 清空指定表（谨慎使用）
export const clearTable = async (tableName) => {
  const db = await getDB()
  const tx = db.transaction([tableName], 'readwrite')
  const store = tx.objectStore(tableName)
  const request = store.clear()
  
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      console.log(`已清空表: ${tableName}`)
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}
