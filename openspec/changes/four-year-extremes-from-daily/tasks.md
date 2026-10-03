## 1. Worker 聚合接口

- [x] 1.1 在 `workers/grid-trading-sync/src/index.ts` 新增 `GET /daily/extremes`：解析并校验 `codes`（6 位代码、至多 50 个）
- [x] 1.2 只保留该密钥名下已保存且已回填（有 `daily_meta`）的标的，按窗口起点（今年−4 的 1 月 1 日）聚合前复权最高/最低价，返回结果与参与计算的最后交易日
- [x] 1.3 用本地 SQLite 验证聚合语句：偏移换算、窗口边界、最低价排除 0、无数据的标的不出现

## 2. 前端

- [x] 2.1 在 `src/lib/grid-trading.ts` 新增 `fetchCloudExtremes(codes)`，无密钥、失败或超时返回空结果
- [x] 2.2 `saved.astro` 的 `loadExtremes` 先批量读取云端结果并渲染，再对缺失的标的逐个回退到 `getFourYearExtremes`
- [x] 2.3 在浏览器中验证：有密钥只发一次聚合请求、无密钥走原有直连、部分缺失时回退补齐，三种情况页面都显示全部标的的四年高低

## 3. 部署与验证

- [x] 3.1 部署 Worker（无需建表）
- [x] 3.2 对已保存的全部标的，比较云端结果与直连月K 结果，确认一致（允许仅当天数据造成的差异）
- [x] 3.3 提交并推送改动
