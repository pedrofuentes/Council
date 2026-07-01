/**
 * NDJSON renderer.
 *
 * Writes one JSON-encoded `DebateEvent` per line, terminated by `\n`. No
 * formatting, no colors, no buffering — designed to be piped to `jq`,
 * captured in logs, or consumed by a CI step.
 *
 * Errors are written to the same channel as success events (the discriminator
 * `kind: "error"` is sufficient for downstream filtering).
 *
 * If the downstream pipe closes early (`council … | jq | head`), the write
 * throws EPIPE; that is treated as a graceful shutdown — the render loop stops
 * and resolves cleanly. Any other write error still propagates.
 */
import type { DebateEvent } from "../../core/types.js";

import { isEpipe } from "./sink-errors.js";
import type { Renderer, Sink } from "./types.js";

export class JsonRenderer implements Renderer {
  constructor(private readonly sink: Sink) {}

  async render(events: AsyncIterable<DebateEvent>): Promise<void> {
    for await (const evt of events) {
      try {
        this.sink.write(JSON.stringify(evt) + "\n");
      } catch (err: unknown) {
        if (isEpipe(err)) return;
        throw err;
      }
    }
  }
}
