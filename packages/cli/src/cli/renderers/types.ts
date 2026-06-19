/**
 * Renderer interface — consumes a `DebateEvent` stream and produces output.
 *
 * Implementations:
 *   - `JsonRenderer` — NDJSON, one event per line. For CI / scripts / pipes.
 *   - `PlainRenderer` — human-readable text, optional ANSI color.
 *   - `InkRenderer` (Phase 3.4) — rich React-based TTY UI. Deferred.
 *
 * The `Sink` abstraction lets tests inject a string buffer instead of stdout.
 * Production code uses `StdoutSink` / `StderrSink` (or a combined wrapper).
 */
import type { DebateEvent } from "../../core/types.js";

export interface Sink {
  write(text: string): void;
  /** Optional separate channel for errors. Defaults to `write` if absent. */
  writeError?(text: string): void;
}

export interface Renderer {
  render(events: AsyncIterable<DebateEvent>): Promise<void>;
}

/**
 * Default `Sink` over `process.stdout` / `process.stderr`. Production CLI
 * commands instantiate this and pass it to the chosen renderer.
 */
export class StreamSink implements Sink {
  write(text: string): void {
    process.stdout.write(text);
  }
  writeError(text: string): void {
    process.stderr.write(text);
  }
}
