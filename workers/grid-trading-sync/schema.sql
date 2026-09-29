CREATE TABLE IF NOT EXISTS records (
  owner_hash TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, record_id)
);
