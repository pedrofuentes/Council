-- Migration 010 — Single-active-per-target invariant for chat sessions (#333).
--
-- Sentinel SNT-329-20260512-044603 (CONDITIONAL follow-up on PR #329) flagged
-- that the active-session rotation in `council chat` was non-atomic and
-- carried no schema-level uniqueness. A crash between archiving the prior
-- active session and creating its replacement could leave the target with
-- zero active sessions, and concurrent launches could create multiple
-- active sessions for the same (target_type, target_slug).
--
-- Defence-in-depth: even with the new transactional `rotateActiveSession`
-- repo method, this partial unique index guarantees the invariant at the
-- schema level so any future code path that forgets to use the helper still
-- cannot violate it.
--
-- Backfill: an existing database upgraded from migration 009 may already
-- carry duplicate active rows for the same target (the very bug this
-- migration prevents). Creating the partial unique index against such a
-- corpus would fail and brick `createDatabase`. We deduplicate first,
-- archiving every active row except the most-recently-created one per
-- (target_type, target_slug). The kept row is the same one
-- `findActiveSession` would already have returned, so this is a no-op
-- semantically while making the index creation total.
--
-- HUMAN-REQUIRED note: per AGENTS.md DB migrations are HUMAN REQUIRED.
-- Issue #333 (linked to Sentinel SNT-329-20260512-044603) explicitly
-- requests this index as part of the rotation fix.

UPDATE chat_sessions
SET status = 'archived',
    updated_at = COALESCE(updated_at, created_at)
WHERE status = 'active'
  AND id NOT IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY target_type, target_slug
               ORDER BY created_at DESC, id DESC
             ) AS rn
      FROM chat_sessions
      WHERE status = 'active'
    )
    WHERE rn = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_active_unique
  ON chat_sessions (target_type, target_slug)
  WHERE status = 'active';
