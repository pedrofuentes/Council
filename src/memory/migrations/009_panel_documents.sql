-- Migration 009 — Panel Document Folder (Roadmap 6.7).
--
-- HUMAN-REQUIRED note: per AGENTS.md DB migrations are HUMAN REQUIRED.
-- This migration is purely additive (two CREATE TABLE IF NOT EXISTS
-- blocks plus an index) and was explicitly requested by the user as
-- part of the Panel Document Folder work (Roadmap 6.7).
--
-- `panel_linked_folders` stores external directories that participate
-- in a panel's RAG corpus alongside the managed folder at
-- <dataHome>/panels/<name>/docs/. `panel_documents` tracks individual
-- files (managed or linked) with checksum/word-count metadata so the
-- scanner can detect changes and write into the existing FTS5
-- `document_index` (migration 007) under `source_type = 'panel'`.

CREATE TABLE IF NOT EXISTS panel_linked_folders (
  id           TEXT PRIMARY KEY,                   -- ULID
  panel_name   TEXT NOT NULL REFERENCES panel_library(name) ON DELETE CASCADE,
  folder_path  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (panel_name, folder_path)
);

CREATE TABLE IF NOT EXISTS panel_documents (
  id           TEXT PRIMARY KEY,                   -- ULID
  panel_name   TEXT NOT NULL REFERENCES panel_library(name) ON DELETE CASCADE,
  source       TEXT NOT NULL,                      -- 'managed' | 'linked'
  file_path    TEXT NOT NULL,                      -- absolute path on disk
  filename     TEXT NOT NULL,
  checksum     TEXT NOT NULL,                      -- SHA-256 of file content
  size_bytes   INTEGER NOT NULL,
  word_count   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'processed' | 'failed' | 'removed'
  processed_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (panel_name, file_path)
);

CREATE INDEX IF NOT EXISTS idx_panel_documents_panel
  ON panel_documents (panel_name, status);
