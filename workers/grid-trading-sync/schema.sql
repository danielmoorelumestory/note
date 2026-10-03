CREATE TABLE IF NOT EXISTS records (
  owner_hash TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, record_id)
);

-- 1 分钟 K 线（未复权，原样保存接口返回值）。ts 为 YYYYMMDDHHMM（北京时间），按 (code, ts) 去重，重复抓取不会产生重复行。
CREATE TABLE IF NOT EXISTS minute_bars (
  code TEXT NOT NULL,
  ts TEXT NOT NULL,
  open REAL NOT NULL,
  close REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (code, ts)
) WITHOUT ROWID;

-- 前复权偏移：腾讯前复权对 ETF/股票都是“价格 − 常数”（除权除息前的历史整体平移），所以只存每个交易日的偏移量，
-- 前复权价 = 未复权价 − offset。每次抓取都会按最新除权信息重写，旧日期的偏移也随之更新。date 为 YYYYMMDD。
CREATE TABLE IF NOT EXISTS daily_offsets (
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  offset REAL NOT NULL,
  PRIMARY KEY (code, date)
) WITHOUT ROWID;

-- 分钟线抓取日志：每次运行（定时 cron 或手动 manual）、每个标的一行。ok=0 表示抓取失败，error 为原因；
-- ok=1 且 error 非空表示分钟线已入库但前复权偏移更新失败。run_at 为毫秒时间戳。
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  code TEXT NOT NULL,
  ok INTEGER NOT NULL,
  fetched INTEGER NOT NULL DEFAULT 0,
  first_ts TEXT,
  last_ts TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS sync_log_code_run ON sync_log (code, run_at);

-- 日K（未复权）：收盘后不会再变，长期保存；前复权通过 daily_offsets 换算。date 为 YYYYMMDD，volume 单位为手。
CREATE TABLE IF NOT EXISTS daily_bars (
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL NOT NULL,
  close REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (code, date)
) WITHOUT ROWID;

-- 每个标的日K 已回填到的起点（YYYY-MM-DD）。用来区分“标的上市较晚所以最早日K 晚于起点”与“还没回填过更早的数据”，避免每次都整段重抓。
CREATE TABLE IF NOT EXISTS daily_meta (
  code TEXT PRIMARY KEY,
  backfilled_from TEXT NOT NULL
);
