-- Migration 005 — Chat sessions and turns for persistent conversations.
--
-- Supports Phase 5 (Conversational Experience). Council previously only
-- modelled debates (multi-expert rounds). Chats are a complementary,
-- longer-lived shape: a user talks to a single expert OR a panel over many
-- back-and-forth turns. Older context is compressed into a rolling
-- `summary` so we can keep prompts bounded without losing continuity.
--
-- HUMAN-REQUIRED note: per AGENTS.md DB migrations are HUMAN REQUIRED.
-- This migration is purely additive (new CREATE TABLE IF NOT EXISTS blocks
-- plus an FTS5 virtual table) and was explicitly requested by the user as
-- part of the Chat Session Infrastructure work (Roadmap 5.1).

CREATE TABLE IF NOT EXISTS chat_sessions (
  id                  TEXT PRIMARY KEY,                  -- ULID
  target_type         TEXT NOT NULL,                     -- 'expert' | 'panel'
  target_slug         TEXT NOT NULL,                     -- expert slug or panel name
  status              TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'archived'
  summary             TEXT,                              -- rolling summary of older turns
  summary_through_seq INTEGER NOT NULL DEFAULT 0,        -- seq number up to which summary covers
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_target
  ON chat_sessions (target_type, target_slug, status);

CREATE TABLE IF NOT EXISTS chat_turns (
  id           TEXT PRIMARY KEY,                  -- ULID
  chat_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,                     -- 'user' | 'expert'
  expert_slug  TEXT,                              -- NULL for user turns
  content      TEXT NOT NULL,
  is_mention   INTEGER NOT NULL DEFAULT 0,        -- 1 if @mention response
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_turns_chat_seq
  ON chat_turns (chat_id, seq);

-- FTS5 for searching chat content. External content table keeps the
-- search index in sync with chat_turns.rowid; AI/AD triggers below
-- maintain the FTS index on insert/delete.
CREATE VIRTUAL TABLE IF NOT EXISTS chat_turns_fts USING fts5(
  content,
  content='chat_turns',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS chat_turns_ai AFTER INSERT ON chat_turns BEGIN
  INSERT INTO chat_turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chat_turns_ad AFTER DELETE ON chat_turns BEGIN
  INSERT INTO chat_turns_fts(chat_turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
