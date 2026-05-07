/**
 * NDJSON renderer.
 *
 * Writes one JSON-encoded `DebateEvent` per line, terminated by `\n`. No
 * formatting, no colors, no buffering — designed to be piped to `jq`,
 * captured in logs, or consumed by a CI step.
 *
 * Errors are written to the same channel as success events (the discriminator
 * `kind: "error"` is sufficient for downstream filtering).
 */
import type { DebateEvent } from "../../core/types.js";
import type { Renderer, Sink } from "./types.js";

export class JsonRenderer implements Renderer {
  constructor(private readonly sink: Sink) {}

  async render(events: AsyncIterable<DebateEvent>): Promise<void> {
    for await (const evt of events) {
      this.sink.write(JSON.stringify(evt) + "\n");
    }
  }
}
