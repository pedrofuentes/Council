-- Migration 008 — Persona profiles for document-intelligence experts (Roadmap 6.2).
--
-- HUMAN-REQUIRED note: per AGENTS.md DB migrations are HUMAN REQUIRED.
-- This migration is purely additive (new CREATE TABLE IF NOT EXISTS block)
-- and was explicitly requested by the user as part of the Document
-- Intelligence work (Roadmap 6.2 — Persona Profile Analysis); rationale
-- captured in the PR.

CREATE TABLE IF NOT EXISTS persona_profiles (
  expert_slug         TEXT PRIMARY KEY REFERENCES expert_library(slug) ON DELETE CASCADE,
  communication_style TEXT NOT NULL,
  decision_patterns   TEXT NOT NULL,               -- JSON array of strings
  biases              TEXT NOT NULL,               -- JSON array of strings
  vocabulary          TEXT NOT NULL,               -- JSON array of strings
  epistemic_stance    TEXT NOT NULL,               -- derived from documents
  document_count      INTEGER NOT NULL DEFAULT 0,
  total_words         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
