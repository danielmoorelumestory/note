## Why

“已保存标的”页的“四年最高/最低”现在靠浏览器逐个标的直连腾讯月K 接口取得，每个标的一次请求、结果只缓存当天，12 个标的打开页面就是 12 次直连请求。而云端已经保存了完整的日K 和前复权偏移，四年高低点本来就是这份数据的一条聚合查询，没必要再单独请求一份重复的月K 数据。

## What Changes

- Worker 新增接口 `GET /daily/extremes?codes=601318,159901,...`：用云端日K 一次性算出多个标的“今年及前四个自然年”（如 2026 年取 2022-01-01 起）内的前复权最高价与最低价。
- 前端“已保存标的”页改为先用这个接口一次取回所有标的的四年高低；云端没有某个标的的数据、没有同步密钥或请求失败时，对这些标的回退为现有的直连月K 方式。
- 现有的月K 直连与按代码按天的 localStorage 缓存保留，仅作为回退路径。
- 不做：年K/月K 的云端存储（高低点直接由日K 聚合，不需要单独存储）、四年窗口的口径调整、浏览器缓存改 IndexedDB。

## Capabilities

### New Capabilities
- `four-year-extremes`: 基于云端日K 计算多个标的近四年前复权最高/最低价，并在前端优先使用、失败时回退。

### Modified Capabilities

（无。`daily-bar-store`、`daily-bar-client` 的需求不变，本变更只新增一个读取聚合结果的接口。）

## Impact

- `workers/grid-trading-sync/src/index.ts`：新增 `/daily/extremes` 路由与聚合查询。无需新增表，沿用 `daily_bars`、`daily_offsets`、`daily_meta`，所以只需重新部署 Worker，不需要重新建表。
- `src/lib/grid-trading.ts`：新增读取云端四年高低的函数。
- `src/pages/lab/grid-trading/saved.astro`：`loadExtremes` 先批量读取云端结果，缺失的标的再逐个回退。
- 页面打开时的外部请求从“每个标的一次直连腾讯”变为“一次读取自家 Worker”。
