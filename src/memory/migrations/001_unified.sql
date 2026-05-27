CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- Core tables

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
  id                      TEXT PRIMARY KEY,
  panel_id                TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  slug                    TEXT NOT NULL,
  display_name            TEXT NOT NULL,
  model                   TEXT NOT NULL,
  system_message          TEXT NOT NULL,
  copilot_session_id      TEXT,
  created_at              TEXT NOT NULL,
  extracted_memory_json   TEXT,
  memory_source_debate_id TEXT,
  memory_derivation       TEXT,
  memory_trust_score      REAL,
  memory_extracted_at     TEXT,
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

-- Library tables

CREATE TABLE IF NOT EXISTS expert_library (
  slug          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'generic',
  display_name  TEXT NOT NULL,
  yaml_path     TEXT NOT NULL,
  yaml_checksum TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panel_library (
  name          TEXT PRIMARY KEY,
  description   TEXT,
  yaml_path     TEXT NOT NULL,
  yaml_checksum TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panel_members (
  panel_name   TEXT NOT NULL REFERENCES panel_library(name) ON DELETE CASCADE,
  expert_slug  TEXT NOT NULL REFERENCES expert_library(slug) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (panel_name, expert_slug)
);

-- Chat tables

CREATE TABLE IF NOT EXISTS chat_sessions (
  id                  TEXT PRIMARY KEY,
  target_type         TEXT NOT NULL,
  target_slug         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  summary             TEXT,
  summary_through_seq INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_turns (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  expert_slug  TEXT,
  content      TEXT NOT NULL,
  is_mention   INTEGER NOT NULL DEFAULT 0,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  created_at   TEXT NOT NULL,
  UNIQUE (chat_id, seq)
);

-- Document tables

CREATE TABLE IF NOT EXISTS expert_documents (
  id            TEXT PRIMARY KEY,
  expert_slug   TEXT NOT NULL REFERENCES expert_library(slug) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  filename      TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  word_count    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  processed_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (expert_slug, file_path)
);

CREATE TABLE IF NOT EXISTS persona_profiles (
  expert_slug         TEXT PRIMARY KEY REFERENCES expert_library(slug) ON DELETE CASCADE,
  communication_style TEXT NOT NULL,
  decision_patterns   TEXT NOT NULL,
  biases              TEXT NOT NULL,
  vocabulary          TEXT NOT NULL,
  epistemic_stance    TEXT NOT NULL,
  document_count      INTEGER NOT NULL DEFAULT 0,
  total_words         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panel_linked_folders (
  id           TEXT PRIMARY KEY,
  panel_name   TEXT NOT NULL REFERENCES panel_library(name) ON DELETE CASCADE,
  folder_path  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (panel_name, folder_path)
);

CREATE TABLE IF NOT EXISTS panel_documents (
  id           TEXT PRIMARY KEY,
  panel_name   TEXT NOT NULL REFERENCES panel_library(name) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  filename     TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  word_count   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  processed_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (panel_name, file_path)
);

-- Indexes

CREATE INDEX IF NOT EXISTS idx_turns_debate_round_seq
  ON turns (debate_id, round, seq);

CREATE INDEX IF NOT EXISTS idx_experts_panel_id
  ON experts (panel_id);

CREATE INDEX IF NOT EXISTS idx_panels_name ON panels(name);

CREATE INDEX IF NOT EXISTS idx_debates_panel_id ON debates(panel_id);

CREATE INDEX IF NOT EXISTS idx_panel_members_expert
  ON panel_members (expert_slug);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_target
  ON chat_sessions (target_type, target_slug, status);

CREATE INDEX IF NOT EXISTS idx_chat_turns_chat_seq
  ON chat_turns (chat_id, seq);

CREATE INDEX IF NOT EXISTS idx_expert_documents_slug
  ON expert_documents (expert_slug, status);

CREATE INDEX IF NOT EXISTS idx_panel_documents_panel
  ON panel_documents (panel_name, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_active_unique
  ON chat_sessions (target_type, target_slug)
  WHERE status = 'active';

-- FTS5 virtual tables

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  content,
  content='turns',
  content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS chat_turns_fts USING fts5(
  content,
  content='chat_turns',
  content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS document_index USING fts5(
  content,
  source_type,
  source_slug,
  file_path,
  tokenize='porter unicode61'
);

-- Triggers

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

CREATE TRIGGER IF NOT EXISTS chat_turns_ai AFTER INSERT ON chat_turns BEGIN
  INSERT INTO chat_turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chat_turns_ad AFTER DELETE ON chat_turns BEGIN
  INSERT INTO chat_turns_fts(chat_turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
