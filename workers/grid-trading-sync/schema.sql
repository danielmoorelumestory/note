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
