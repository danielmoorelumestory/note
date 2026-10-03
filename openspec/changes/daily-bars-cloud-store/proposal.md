## Why

日K 是回测的核心数据，目前只缓存在每个浏览器的 localStorage 里：缓存只在当天有效，次日整段重新下载（因为前复权会被分红改写）；每个设备、每次清缓存都要重下；12 个标的每天要下 12 份长历史，页面首次打开明显变慢，浏览器 5 MB 存储上限还在逼近。而云端 Worker 已经在抓日K 来算前复权偏移，却没有把日K 本身存下来，同一份数据被重复获取了多次。

## What Changes

- Worker 在 D1 新增 `daily_bars` 表，保存每个已保存标的的**未复权**日K（开、收、高、低、成交量）。
- 首次回填：每个标的从“最早建仓日”与“四年前 1 月 1 日”中更早的一天起回填；之后每个交易日只追加最新几天。
- `daily_offsets` 改为覆盖该标的 `daily_bars` 的全部交易日（此前只覆盖分钟线起点之后）。每次抓取先对比近期偏移，发现除权除息导致偏移变化时，才整段重算偏移；未复权日K 本身历史不变，无需重下。
- 新增读取接口 `GET /daily?code=&from=&to=&adjust=`，默认返回前复权价（未复权价减当日偏移）。对该密钥下已保存的标的，若云端还没有数据，请求时按需回填后再返回。
- 前端 `getCandles` 优先从云端读取日K；没有同步密钥、标的未保存、或云端不可用时，自动回退为现在直接请求腾讯的方式，计算器页行为不变。
- 不做：浏览器缓存改 IndexedDB（后续单独变更）、月K/年K 聚合与四年高低（后续单独变更）、云同步改造。

## Capabilities

### New Capabilities
- `daily-bar-store`: 云端日K 的存储、回填、增量更新、前复权偏移维护与读取接口。
- `daily-bar-client`: 前端优先读取云端日K，缺少条件或失败时回退直连腾讯。

### Modified Capabilities

（无。主规格里 `minute-bar-sync`、`minute-bar-health` 的需求不变；分钟线健康检查继续使用 `daily_offsets` 的交易日列表，只是覆盖范围更广。）

## Impact

- `workers/grid-trading-sync/src/index.ts`：新增日K 抓取、回填、偏移重算与 `/daily` 路由；`syncOffsets` 并入新的日K 同步流程。
- `workers/grid-trading-sync/schema.sql`：新增 `daily_bars` 与 `daily_meta` 表。需要重新建表并部署 Worker。
- `src/lib/grid-trading.ts`：`downloadCandles` 前增加云端读取与回退逻辑。
- D1 体量：约 250 条/年/标的，12 个标的四年约 1.2 万行，可忽略；每日写入为每个标的数行。
- 外部依赖不变，仍是腾讯 fqkline 接口，但由 Worker 统一抓取，浏览器直连请求大幅减少。
