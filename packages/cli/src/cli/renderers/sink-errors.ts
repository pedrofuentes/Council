/**
 * Shared sink-write error classification for renderers.
 *
 * When stdout/stderr is piped to a consumer that closes early
 * (`council … | head`, or `… | less` then `q`), the underlying stream write
 * fails with EPIPE. Renderers treat that single case as a graceful shutdown —
 * they stop writing and resolve cleanly. EVERY other write error must still
 * propagate, so real failures (disk full, permission denied, …) are never
 * swallowed.
 *
 * `JsonRenderer` and `PlainRenderer` share this predicate so their broken-pipe
 * behavior stays consistent.
 */

/** True when `err` is a broken-pipe (EPIPE) failure from a closed sink. */
export function isEpipe(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "EPIPE";
}
