CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,          -- when it happened, ms since 1970
  type    TEXT NOT NULL,             -- feed diaper sleep_start sleep_end cry_start cry_end soothe medicine note
  amount  REAL,
  unit    TEXT,
  detail  TEXT,
  source  TEXT,                      -- band-voice, band-auto, phone, seed
  who     TEXT,
  raw     TEXT                       -- the words as spoken or typed
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
