-- Migration 007 — Document content index for RAG retrieval (Roadmap 6.3).
--
-- Adds a contentless FTS5 virtual table that stores document text along
-- with source metadata so chat sessions can retrieve relevant snippets
-- from an expert's or panel's document corpus.
--
-- HUMAN-REQUIRED note: per AGENTS.md DB migrations are HUMAN REQUIRED.
-- This migration is purely additive (a single CREATE VIRTUAL TABLE
-- IF NOT EXISTS plus a schema_version row) and was explicitly requested
-- by the user as part of the Content Indexing / RAG work (Roadmap 6.3).
--
-- Unlike chat_turns_fts (migration 005), document_index is a standalone
-- FTS5 table — there is no source table to mirror — so indexer.ts writes
-- directly to it via INSERT/DELETE statements. The Porter stemmer plus
-- the unicode61 tokenizer give us stemmed full-text matching that works
-- for non-ASCII content too.

CREATE VIRTUAL TABLE IF NOT EXISTS document_index USING fts5(
  content,
  source_type,
  source_slug,
  file_path,
  tokenize='porter unicode61'
);
-- Note: schema_version row is inserted by the migration runner in db.ts,
-- not by this file (see applyMigrations in src/memory/db.ts). Adding a
-- second insert here would conflict with that and break migration 007.
