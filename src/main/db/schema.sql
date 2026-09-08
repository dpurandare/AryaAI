CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL, -- JSON-serialized ContentBlock[]
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_usage (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

-- search_history: which (provider, model) — and the dimension it produced —
-- the current message_vectors index was built with. A single row (id=1).
-- message_vectors (a sqlite-vec vec0 table) can't be declared here since its
-- vector dimension isn't known until an embedding model actually runs once;
-- it's created lazily in code, keyed to this row. See src/main/search-history/indexer.ts.
CREATE TABLE IF NOT EXISTS embedding_index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Maps a message to its embedding. `id` doubles as the rowid in the
-- message_vectors vec0 table (sqlite-vec's documented pairing idiom).
CREATE TABLE IF NOT EXISTS message_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
