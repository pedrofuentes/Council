/**
 * Hardening tests for the JSON (NDJSON) renderer.
 *
 * Covers backlog finding #85 (resilience): when stdout is piped to a consumer
 * that closes early (`council … | jq | head`), `sink.write` throws EPIPE. The
 * renderer MUST treat that as a graceful shutdown — stop writing and resolve
 * cleanly — instead of crashing with an unhandled error. Every OTHER write
 * error MUST still propagate; the renderer must not swallow real failures.
 *
 * Mirrors the EPIPE coverage the Plain renderer already has in
 * `plain-hardening.test.ts`, so both renderers stay consistent.
 *
 * RED at the test-only commit: `json.ts` calls `sink.write` with no EPIPE
 * guard, so an EPIPE rejects `render()` and the graceful-shutdown assertion
 * fails.
 */
import { describe, expect, it } from "vitest";

import type { DebateEvent } from "../../../../src/core/types.js";
import { JsonRenderer } from "../../../../src/cli/renderers/json.js";
import type { Sink } from "../../../../src/cli/renderers/types.js";

async function* events(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

const FOUR_EVENTS: readonly DebateEvent[] = [
  { kind: "round.start", round: 0 },
  { kind: "turn.delta", expertSlug: "cto", text: "alpha" },
  { kind: "turn.delta", expertSlug: "cto", text: "beta" },
  { kind: "debate.end", reason: "completed" },
];

function epipeError(): Error {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

describe("JsonRenderer — EPIPE handling (#85)", () => {
  it("stops rendering gracefully when the sink throws EPIPE mid-stream", async () => {
    let writeCount = 0;
    const brokenPipeSink: Sink = {
      write() {
        writeCount += 1;
        if (writeCount === 2) throw epipeError();
      },
    };
    const renderer = new JsonRenderer(brokenPipeSink);

    // Graceful: the broken pipe resolves cleanly rather than rejecting.
    await expect(renderer.render(events(...FOUR_EVENTS))).resolves.toBeUndefined();

    // Clean shutdown: the first line is written, the second throws EPIPE and
    // halts the loop, so the remaining two events are never written (the
    // renderer stops hammering a closed pipe).
    expect(writeCount).toBe(2);
  });

  it("stops on an EPIPE thrown by the very first write", async () => {
    let writeCount = 0;
    const brokenPipeSink: Sink = {
      write() {
        writeCount += 1;
        throw epipeError();
      },
    };
    const renderer = new JsonRenderer(brokenPipeSink);

    await expect(renderer.render(events(...FOUR_EVENTS))).resolves.toBeUndefined();
    expect(writeCount).toBe(1);
  });

  it("re-throws non-EPIPE write errors instead of swallowing them", async () => {
    let writeCount = 0;
    const failingSink: Sink = {
      write() {
        writeCount += 1;
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    };
    const renderer = new JsonRenderer(failingSink);

    // Inverse invariant: a non-EPIPE error must propagate, not be swallowed.
    await expect(renderer.render(events(...FOUR_EVENTS))).rejects.toThrow("permission denied");
    // And it must fail fast on the first write, not keep looping.
    expect(writeCount).toBe(1);
  });
});
