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

-- TASKS.md #95, phase 2: every time classifyAndPlan's real classifier call
-- actually runs, its result is logged alongside the deterministic gate's own
-- verdict (classify-gate.ts) — whether the gate said 'run' (unsure, so the
-- real call always happened) or 'skip' (this turn was one of the sampled
-- ones, run anyway purely to check the gate). Lets the gate's accuracy
-- against real classifier decisions be measured over time before it's ever
-- widened to skip more.
CREATE TABLE IF NOT EXISTS classify_gate_log (
  id TEXT PRIMARY KEY,
  gate_verdict TEXT NOT NULL,
  classifier_complexity TEXT NOT NULL,
  message_length INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- search_history: which (provider, model) — and the dimension it produced —
-- the current message_chunk_vectors index was built with. A single row
-- (id=1). message_chunk_vectors (a sqlite-vec vec0 table) can't be declared
-- here since its vector dimension isn't known until an embedding model
-- actually runs once; it's created lazily in code, keyed to this row. See
-- src/main/search-history/indexer.ts.
CREATE TABLE IF NOT EXISTS embedding_index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Bookkeeping only: has this message been run through the indexer at all
-- (embedded-with-chunks, or intentionally empty)? The actual searchable
-- vectors live in message_chunks/message_chunk_vectors below, not here —
-- `id` no longer doubles as any vec0 table's rowid.
CREATE TABLE IF NOT EXISTS message_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Chunk-level companion to message_embeddings: a message's searchable text
-- is split into paragraph-sized chunks (search-history/chunk-text.ts) so a
-- query matching one part of a multi-topic message doesn't drag the rest
-- along as an excerpt. `id` doubles as the rowid in message_chunk_vectors
-- (a vec0 table, created lazily in code once an embedding model's real
-- dimension is known), same pairing idiom message_embeddings used to have.
-- Added as a new table, not an ALTER TABLE on message_embeddings — this
-- file has no migration mechanism.
CREATE TABLE IF NOT EXISTS message_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
