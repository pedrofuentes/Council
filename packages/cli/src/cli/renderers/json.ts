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
 *
 * When `showCost` is disabled, `cost.update` events are omitted from the stream
 * so NDJSON honors the same cost gate as the plain/Ink renderers (#853).
 */
import type { DebateEvent } from "../../core/types.js";

import { isEpipe } from "./sink-errors.js";
import type { Renderer, Sink } from "./types.js";

export interface JsonRendererOptions {
  /** Whether to include `cost.update` events in the stream. Defaults to true. */
  readonly showCost?: boolean;
}

export class JsonRenderer implements Renderer {
  /** NDJSON must stay machine-parseable — a plain-text preamble would corrupt it. */
  readonly supportsPreamble = false;
  readonly #sink: Sink;
  readonly #showCost: boolean;

  constructor(sink: Sink, options: JsonRendererOptions = {}) {
    this.#sink = sink;
    this.#showCost = options.showCost ?? true;
  }

  async render(events: AsyncIterable<DebateEvent>): Promise<void> {
    for await (const evt of events) {
      if (evt.kind === "cost.update" && !this.#showCost) continue;
      try {
        this.#sink.write(JSON.stringify(evt) + "\n");
      } catch (err: unknown) {
        if (isEpipe(err)) return;
        throw err;
      }
    }
  }
}
