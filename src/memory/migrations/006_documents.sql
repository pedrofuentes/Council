-- Migration 006 — Document tracking for persona experts (Roadmap 6.1).
--
-- HUMAN-REQUIRED note: per AGENTS.md DB migrations are HUMAN REQUIRED.
-- This migration is purely additive (new CREATE TABLE IF NOT EXISTS block)
-- and was explicitly requested by the user as part of the Document
-- Intelligence work; rationale captured in the PR.

CREATE TABLE IF NOT EXISTS expert_documents (
  id            TEXT PRIMARY KEY,                 -- ULID
  expert_slug   TEXT NOT NULL REFERENCES expert_library(slug) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,                    -- absolute path on disk
  filename      TEXT NOT NULL,
  checksum      TEXT NOT NULL,                    -- SHA-256 of file content
  size_bytes    INTEGER NOT NULL,
  word_count    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'processed' | 'failed' | 'removed'
  processed_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (expert_slug, file_path)
);

CREATE INDEX IF NOT EXISTS idx_expert_documents_slug
  ON expert_documents (expert_slug, status);
