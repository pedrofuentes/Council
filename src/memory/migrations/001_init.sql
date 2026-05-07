-- Council schema v1
-- See DECISIONS.md ADR-002 (orchestration index) and ADR-005 (libsql backend).
--
-- Notes:
--   - All `id` columns are TEXT-stored ULIDs (lexicographically sortable by creation time).
--   - All timestamps are ISO 8601 strings (libsql/SQLite default — clearer than epoch ms).
--   - Foreign keys are enabled by libsql; ON DELETE CASCADE wired where appropriate.
--   - turns.content is also indexed by an FTS5 virtual table for search.

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  topic        TEXT,
  copilot_home TEXT NOT NULL,
  config_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experts (
  id                  TEXT PRIMARY KEY,
  panel_id            TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  slug                TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  model               TEXT NOT NULL,
  system_message      TEXT NOT NULL,
  copilot_session_id  TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (panel_id, slug)
);

CREATE TABLE IF NOT EXISTS debates (
  id            TEXT PRIMARY KEY,
  panel_id      TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  prompt        TEXT NOT NULL,
  status        TEXT NOT NULL,
  moderator     TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  cost_estimate INTEGER
);

CREATE TABLE IF NOT EXISTS turns (
  id           TEXT PRIMARY KEY,
  debate_id    TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  round        INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  speaker_kind TEXT NOT NULL,
  expert_id    TEXT REFERENCES experts(id) ON DELETE SET NULL,
  content      TEXT NOT NULL,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  latency_ms   INTEGER,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_debate_round_seq
  ON turns (debate_id, round, seq);

CREATE INDEX IF NOT EXISTS idx_experts_panel_id
  ON experts (panel_id);

-- FTS5 virtual table for transcript search.
-- Linked to turns via content='turns', content_rowid='rowid'.
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  content,
  content='turns',
  content_rowid='rowid'
);

-- Triggers keep turns_fts in sync with turns.
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;
