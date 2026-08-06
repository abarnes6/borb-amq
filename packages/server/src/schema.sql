CREATE TABLE IF NOT EXISTS anime (
  id           INTEGER PRIMARY KEY,
  slug         TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  year         INTEGER,
  season       TEXT,
  media_format TEXT,
  mal_id       INTEGER,
  english_name TEXT
);

CREATE TABLE IF NOT EXISTS anime_title (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  anime_id   INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  normalized TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('main', 'synonym'))
);
CREATE INDEX        IF NOT EXISTS idx_anime_title_anime ON anime_title(anime_id);
CREATE INDEX        IF NOT EXISTS idx_anime_title_norm  ON anime_title(normalized);
CREATE UNIQUE INDEX IF NOT EXISTS idx_anime_title_uniq  ON anime_title(anime_id, normalized);

CREATE TABLE IF NOT EXISTS theme (
  id         INTEGER PRIMARY KEY,
  anime_id   INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL CHECK (type IN ('OP', 'ED', 'IN')),
  sequence   INTEGER,
  slug       TEXT    NOT NULL,
  song_title TEXT,
  artists    TEXT    NOT NULL DEFAULT '[]'  -- JSON array of artist names
);
CREATE INDEX IF NOT EXISTS idx_theme_anime ON theme(anime_id);
CREATE INDEX IF NOT EXISTS idx_theme_type  ON theme(type);

CREATE TABLE IF NOT EXISTS track (
  id          INTEGER PRIMARY KEY,     -- AnimeThemes audio id
  theme_id    INTEGER NOT NULL REFERENCES theme(id) ON DELETE CASCADE,
  video_id    INTEGER,
  audio_url   TEXT    NOT NULL,
  video_url   TEXT,
  audio_bytes INTEGER,
  duration_s  REAL,
  nsfw        INTEGER NOT NULL DEFAULT 0,
  spoiler     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_track_theme ON track(theme_id);

CREATE TABLE IF NOT EXISTS ingest_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS buzz_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       TEXT    NOT NULL,
  round_n       INTEGER NOT NULL,
  track_id      INTEGER,
  player_name   TEXT    NOT NULL,
  ms_into_round INTEGER NOT NULL,
  answer        TEXT,
  correct       INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buzz_log_room ON buzz_log(room_id, round_n);
