/**
 * Hardening tests for the Plain renderer.
 *
 * Covers three backlog findings:
 *   - #1917 (security, dim A1): the LLM-sourced expert `displayName` is
 *     attacker-controllable in auto-composed panels. It MUST be sanitized
 *     before it reaches the terminal in BOTH header sinks (`turn.start` and
 *     `panel.assembled`), matching the treatment the file already gives other
 *     untrusted strings via its private `sanitizeLine()` helper.
 *   - #85 (resilience, dim B): when stdout/stderr is piped to a consumer that
 *     closes early (`council … | head`), writes throw EPIPE. The renderer must
 *     treat that as a graceful shutdown instead of crashing with an unhandled
 *     error.
 *   - #1960 (test-coverage gap, dim D): the non-EPIPE re-throw branch inside
 *     the private `writeError()` helper (`plain.ts:200`) was only exercised
 *     via `write()`, never via `writeError()` itself (reached from the
 *     `error` event at `plain.ts:119`). Adds a discriminating test for that
 *     branch plus its EPIPE-swallowed inverse.
 *
 * RED at the test-only commit: `plain.ts` passes the raw `displayName` to
 * `formatExpertPrefix` and has no EPIPE guard, so these assertions fail.
 */
import { describe, expect, it } from "vitest";

import type { DebateEvent } from "../../../../src/core/types.js";
import { PlainRenderer } from "../../../../src/cli/renderers/plain.js";
import type { Sink } from "../../../../src/cli/renderers/types.js";

class StringSink {
  text = "";
  errText = "";
  write(s: string): void {
    this.text += s;
  }
  writeError(s: string): void {
    this.errText += s;
  }
}

async function* events(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

/**
 * Adversarial `displayName` exercising the FULL control class the header
 * sanitizer must neutralize: ANSI CSI, C1 CSI (U+009B) / OSC (U+009D), CR/LF,
 * Unicode line/paragraph separators, a bidi override (U+202E, Trojan Source),
 * a zero-width space (U+200B), a horizontal tab (U+0009), and vertical-tab /
 * form-feed C0 controls.
 */
const EVIL_DISPLAY_NAME =
  "Evil" +
  "\u001B[31m" + // ANSI CSI: ESC [ 31 m
  "\u009B2K" + // C1 CSI (0x9B) + erase-line params
  "\u009Dset-title\u0007" + // C1 OSC (0x9D) … BEL
  "\r\nFAKE-OK" + // CR/LF injected line break
  "\u2028X\u2029Y" + // U+2028 line sep, U+2029 paragraph sep
  "\u202Ereversed" + // U+202E right-to-left override (bidi)
  "\u200Bzw" + // U+200B zero-width space
  "\u0009TAB" + // U+0009 horizontal tab — must collapse so the header stays one line
  "\u000B\u000C"; // vertical tab, form feed

// Control (C0/C1/DEL), U+2028/U+2029, and bidi override/isolate code points.
// Matches the oracle mandated by #1917's test-hardening requirement.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

describe("PlainRenderer — displayName sanitization (#1917)", () => {
  it("sanitizes a malicious displayName in the panel.assembled header", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events({
        kind: "panel.assembled",
        experts: [{ slug: "cto", displayName: EVIL_DISPLAY_NAME, model: "claude-sonnet-4" }],
      }),
    );

    const headerLine = sink.text.split("\n").find((l) => l.includes("[1]"));
    if (headerLine === undefined) throw new Error("expected a panel.assembled header line");
    // Rendered as ONE control-/bidi-free line.
    expect(headerLine).not.toMatch(CONTROL_OR_BIDI);
    expect(headerLine).not.toContain("\u200B");
    // The CR/LF-separated tail is collapsed onto the same line, not broken across lines.
    expect(headerLine).toContain("Evil");
    expect(headerLine).toContain("FAKE-OK");
  });

  it("sanitizes a malicious displayName in the turn.start header", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "cto", displayName: EVIL_DISPLAY_NAME, model: "claude-sonnet-4" }],
        },
        { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
      ),
    );

    // The turn.start header is written as `[[1] <name>]` on its own line.
    const headerLine = sink.text.split("\n").find((l) => l.startsWith("[[1]"));
    if (headerLine === undefined) throw new Error("expected a turn.start header line");
    expect(headerLine).not.toMatch(CONTROL_OR_BIDI);
    expect(headerLine).not.toContain("\u200B");
    expect(headerLine).toContain("FAKE-OK");
  });

  it("still renders a legitimate displayName unchanged in both headers", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "cto", displayName: "Dahlia Renner (CTO)", model: "claude-sonnet-4" }],
        },
        { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
      ),
    );
    expect(sink.text).toContain("Dahlia Renner (CTO)");
    expect(sink.text).toContain("[[1] Dahlia Renner (CTO)]");
  });
});

describe("PlainRenderer — EPIPE handling (#85)", () => {
  it("stops rendering gracefully when the stdout sink throws EPIPE", async () => {
    let writeCount = 0;
    const brokenPipeSink: Sink = {
      write() {
        writeCount += 1;
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      },
    };
    const renderer = new PlainRenderer(brokenPipeSink, { color: false });

    await expect(
      renderer.render(
        events(
          {
            kind: "panel.assembled",
            experts: [{ slug: "cto", displayName: "CTO", model: "x" }],
          },
          { kind: "round.start", round: 0 },
          { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
          { kind: "turn.delta", expertSlug: "cto", text: "hi" },
        ),
      ),
    ).resolves.toBeUndefined();

    // Clean shutdown: after the first EPIPE the renderer stops writing instead
    // of hammering the closed pipe for every remaining event.
    expect(writeCount).toBe(1);
  });

  it("handles EPIPE from the error sink gracefully", async () => {
    const brokenErrorSink: Sink = {
      write: () => undefined,
      writeError() {
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      },
    };
    const renderer = new PlainRenderer(brokenErrorSink, { color: true });

    await expect(
      renderer.render(
        events({ kind: "error", expertSlug: "cto", message: "boom", recoverable: false }),
      ),
    ).resolves.toBeUndefined();
  });

  it("re-throws non-EPIPE write errors instead of swallowing them", async () => {
    const failingSink: Sink = {
      write() {
        throw new Error("disk full");
      },
    };
    const renderer = new PlainRenderer(failingSink, { color: false });

    await expect(
      renderer.render(
        events({
          kind: "panel.assembled",
          experts: [{ slug: "cto", displayName: "CTO", model: "x" }],
        }),
      ),
    ).rejects.toThrow("disk full");
  });
});

describe("PlainRenderer — writeError non-EPIPE re-throw (#1960)", () => {
  it("re-throws a non-EPIPE error raised by writeError on the error-event path", async () => {
    const failingErrorSink: Sink = {
      write: () => undefined,
      writeError() {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    };
    const renderer = new PlainRenderer(failingErrorSink, { color: false });

    const renderPromise = renderer.render(
      events({ kind: "error", expertSlug: "cto", message: "boom", recoverable: false }),
    );

    // Discriminating oracle: assert the specific re-thrown error (message AND
    // code), not a bare `toThrow()` — proves plain.ts:200's `throw err;` ran,
    // rather than some other unrelated rejection.
    await expect(renderPromise).rejects.toThrow("permission denied");
    await expect(renderPromise).rejects.toMatchObject({ code: "EACCES" });
  });

  it("swallows an EPIPE error raised by writeError on the error-event path instead of re-throwing", async () => {
    let writeErrorCount = 0;
    const brokenErrorSink: Sink = {
      write: () => undefined,
      writeError() {
        writeErrorCount += 1;
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      },
    };
    const renderer = new PlainRenderer(brokenErrorSink, { color: false });

    await expect(
      renderer.render(
        events(
          { kind: "error", expertSlug: "cto", message: "boom", recoverable: false },
          { kind: "error", expertSlug: "cto", message: "boom again", recoverable: false },
        ),
      ),
    ).resolves.toBeUndefined();

    // Clean shutdown on the writeError path too: after the first EPIPE the
    // pipe is marked closed, so the second `error` event never reaches
    // writeError() again.
    expect(writeErrorCount).toBe(1);
  });
});
