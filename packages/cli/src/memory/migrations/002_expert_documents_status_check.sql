-- Migration 002 (#340): constrain expert_documents.status to the
-- DocumentStatus union via a CHECK. SQLite cannot add a CHECK to an existing
-- column, so we use the supported table-rebuild procedure
-- (https://sqlite.org/lang_altertable.html): create the new table with the
-- CHECK plus identical columns/defaults/FK/UNIQUE, copy every row verbatim,
-- drop the old table, rename the new one into place, and recreate the lookup
-- index.
--
-- The runner wraps this in BEGIN IMMEDIATE/COMMIT and gates it by
-- schema_version, so it runs exactly once per database. No other table has a
-- foreign key that references expert_documents, so the drop/rename is safe with
-- foreign-key enforcement left ON (the node:sqlite default); the copy preserves
-- each row's expert_slug FK to expert_library. Council only ever writes the
-- four valid statuses, so existing rows satisfy the new CHECK; any out-of-set
-- legacy value makes the copy fail and rolls the whole migration back rather
-- than silently corrupting data. On a fresh database the table already carries
-- this CHECK (migration 001) and is empty, so the rebuild copies zero rows and
-- converges to the identical schema.
CREATE TABLE expert_documents_new (
  id            TEXT PRIMARY KEY,
  expert_slug   TEXT NOT NULL REFERENCES expert_library(slug) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  filename      TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  word_count    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processed', 'failed', 'removed')),
  processed_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (expert_slug, file_path)
);

INSERT INTO expert_documents_new
    (id, expert_slug, file_path, filename, checksum, size_bytes, word_count, status, processed_at, created_at)
  SELECT id, expert_slug, file_path, filename, checksum, size_bytes, word_count, status, processed_at, created_at
  FROM expert_documents;

DROP TABLE expert_documents;

ALTER TABLE expert_documents_new RENAME TO expert_documents;

CREATE INDEX IF NOT EXISTS idx_expert_documents_slug
  ON expert_documents (expert_slug, status);
