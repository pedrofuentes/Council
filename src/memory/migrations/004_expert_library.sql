-- Migration 004 — Expert library, panel library, panel membership tracking.
--
-- Supports Phase 4: Expert Library Foundation. The library tables
-- supplement the user-facing YAML definitions in ~/Council/ with runtime
-- metadata (checksum, timestamps) so the engine can detect external edits
-- and join membership rows by slug.
--
-- HUMAN-REQUIRED note: per AGENTS.md DB migrations are HUMAN REQUIRED.
-- This migration is purely additive (new CREATE TABLE IF NOT EXISTS blocks)
-- and was explicitly requested by the user as part of the Expert Library
-- foundation work; rationale captured in the PR.

-- Expert library registry (supplements YAML files with runtime metadata)
CREATE TABLE IF NOT EXISTS expert_library (
  slug          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'generic',  -- 'generic' | 'persona'
  display_name  TEXT NOT NULL,
  yaml_path     TEXT NOT NULL,                    -- path to YAML definition file
  yaml_checksum TEXT NOT NULL,                    -- SHA-256, detect external edits
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Panel registry (supplements YAML files)
CREATE TABLE IF NOT EXISTS panel_library (
  name          TEXT PRIMARY KEY,
  description   TEXT,
  yaml_path     TEXT NOT NULL,
  yaml_checksum TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Panel-expert membership (which experts are in which panels)
CREATE TABLE IF NOT EXISTS panel_members (
  panel_name   TEXT NOT NULL,
  expert_slug  TEXT NOT NULL REFERENCES expert_library(slug) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,        -- ordering within panel
  created_at   TEXT NOT NULL,
  PRIMARY KEY (panel_name, expert_slug)
);

CREATE INDEX IF NOT EXISTS idx_panel_members_expert
  ON panel_members (expert_slug);
