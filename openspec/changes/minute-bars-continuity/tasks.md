## 1. 数据库与配置

- [x] 1.1 在 `workers/grid-trading-sync/schema.sql` 新增 `sync_log` 表（`IF NOT EXISTS`）
- [x] 1.2 在 `wrangler.jsonc` 的 `triggers.crons` 增加 16:00 与次日 09:00 两个触发时间

## 2. Worker 抓取可靠性

- [x] 2.1 `syncMinuteBars` 写入语句改为 `ON CONFLICT(code, ts) DO UPDATE`，覆盖已有分钟
- [x] 2.2 抓取流程为每个标的写入 `sync_log`（成功与失败都记录，单个标的失败不中断其余标的）
- [x] 2.3 抽出共用的抓取函数，供定时任务与手动补抓共用，并区分触发方式
- [x] 2.4 新增 `POST /minute/sync` 手动补抓路由，复用同步密钥认证，只抓取该密钥下已保存记录的标的

## 3. 完整性检查与状态接口

- [x] 3.1 实现缺口检测：以 `daily_offsets` 交易日为基准，统计最近 30 天每日 `minute_bars` 根数，当天未收盘不判缺口
- [x] 3.2 新增 `GET /minute/status?code=` 接口，返回最近成功时间、最近失败信息和缺口列表
- [x] 3.3 用本地 SQLite 构造数据验证缺口检测与状态查询语句（完整、缺失、未收盘、无日志四种情况）

## 4. 前端提示

- [x] 4.1 在 `src/lib/grid-trading.ts` 新增 `fetchMinuteStatus`
- [x] 4.2 详情页分钟线区块读取状态，有缺口或最近成功抓取超过 4 天时显示提示，失败时静默
- [x] 4.3 在浏览器中验证有缺口、无缺口、状态接口失败三种显示，并检查手机宽度

## 5. 部署与验证

- [x] 5.1 执行 `wrangler d1 execute` 建表并 `wrangler deploy` 部署 Worker
- [x] 5.2 手动补抓一次，确认 `sync_log` 有记录、`/minute/status` 返回正常
- [ ] 5.3 提交并推送改动
