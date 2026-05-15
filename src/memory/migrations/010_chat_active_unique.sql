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
-- HUMAN-REQUIRED note: per AGENTS.md DB migrations are HUMAN REQUIRED.
-- Issue #333 (linked to Sentinel SNT-329-20260512-044603) explicitly
-- requests this index as part of the rotation fix.

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_active_unique
  ON chat_sessions (target_type, target_slug)
  WHERE status = 'active';
