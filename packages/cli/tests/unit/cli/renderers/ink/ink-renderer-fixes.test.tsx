/**
 * Failing tests for the Ink renderer cluster T-fx-051.
 *
 * Covers three anchored issues plus the untrusted-name sanitization
 * hardening they touch:
 *   - #231: cleanup must cancel the upstream async generator on unmount
 *   - #685: round-separator width must derive from the renderer's bound
 *           stdout, not the global `process.stdout`
 *   - untrusted LLM displayNames rendered to the terminal must be passed
 *     through `toSingleLineDisplay` (adversarial-byte oracle)
 *
 * RED at the `test(ink)` commit: the cleanup does not return the iterator,
 * `getSeparatorWidth` ignores its argument, and the turn-header / roster /
 * retry sinks render displayNames verbatim.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import {
  DebateApp,
  getSeparatorWidth,
} from "../../../../../src/cli/renderers/ink/InkRenderer.js";
import type { DebateEvent } from "../../../../../src/core/types.js";

async function* stream(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

// Control / bidi / line-separator code points that must never reach a
// single-line terminal sink. Mirrors the class stripped by
// `toSingleLineDisplay`.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_DISPLAY_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

async function withStubbedGlobalColumns(value: number, fn: () => void | Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value, configurable: true });
  try {
    await fn();
  } finally {
    if (original) {
      Object.defineProperty(process.stdout, "columns", original);
    } else {
      delete (process.stdout as { columns?: number }).columns;
    }
  }
}

describe("InkRenderer #231 — cancel upstream generator on cleanup", () => {
  it("returns the async iterator when the component unmounts mid-stream", async () => {
    let returnCalled = false;
    const iterable: AsyncIterable<DebateEvent> = {
      [Symbol.asyncIterator](): AsyncIterator<DebateEvent> {
        const events: DebateEvent[] = [
          {
            kind: "panel.assembled",
            experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
          },
        ];
        let index = 0;
        return {
          async next(): Promise<IteratorResult<DebateEvent>> {
            const current = events[index];
            if (current !== undefined) {
              index += 1;
              return { value: current, done: false };
            }
            // Hold the stream open — engine work is still "in flight".
            return new Promise<IteratorResult<DebateEvent>>(() => {
              /* never resolves */
            });
          },
          async return(): Promise<IteratorResult<DebateEvent>> {
            returnCalled = true;
            return { value: undefined, done: true };
          },
        };
      },
    };

    const ui = render(<DebateApp events={iterable} onComplete={() => undefined} />);
    await flush();
    // Nothing has cancelled yet — the stream is still active.
    expect(returnCalled).toBe(false);

    ui.unmount();
    await flush();

    // The effect cleanup must actively terminate the upstream generator so
    // engine work stops instead of running until the next yield point.
    expect(returnCalled).toBe(true);
  });

  it("swallows a rejection thrown by the iterator's return() during unmount", async () => {
    const iterable: AsyncIterable<DebateEvent> = {
      [Symbol.asyncIterator](): AsyncIterator<DebateEvent> {
        const events: DebateEvent[] = [
          {
            kind: "panel.assembled",
            experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
          },
        ];
        let index = 0;
        return {
          async next(): Promise<IteratorResult<DebateEvent>> {
            const current = events[index];
            if (current !== undefined) {
              index += 1;
              return { value: current, done: false };
            }
            return new Promise<IteratorResult<DebateEvent>>(() => {
              /* never resolves */
            });
          },
          async return(): Promise<IteratorResult<DebateEvent>> {
            throw new Error("return() blew up");
          },
        };
      },
    };

    const ui = render(<DebateApp events={iterable} onComplete={() => undefined} />);
    await flush();
    expect(() => ui.unmount()).not.toThrow();
    await flush();
  });
});

describe("getSeparatorWidth #685 — derives from the provided stream", () => {
  it("returns the stream's column count when below the clamp", () => {
    expect(getSeparatorWidth({ columns: 42 })).toBe(42);
  });

  it("clamps wide streams to 100 columns", () => {
    expect(getSeparatorWidth({ columns: 240 })).toBe(100);
  });

  it("falls back to 80 when the stream reports no columns", () => {
    expect(getSeparatorWidth({ columns: undefined })).toBe(80);
    expect(getSeparatorWidth(undefined)).toBe(80);
  });

  it("reads the provided stream, not the global process.stdout", async () => {
    await withStubbedGlobalColumns(200, () => {
      // Global would clamp to 100; the injected stream reports 37.
      expect(getSeparatorWidth({ columns: 37 })).toBe(37);
    });
  });
});

describe("InkRenderer #685 — separator width from the bound stdout", () => {
  it("sizes the round separator from the bound stream, not global process.stdout", async () => {
    // ink-testing-library binds a 100-column stdout; the global is stubbed
    // narrow. The separator must follow the bound stream (100), not 47.
    await withStubbedGlobalColumns(47, async () => {
      const ui = render(
        <DebateApp
          events={stream(
            {
              kind: "panel.assembled",
              experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
            },
            { kind: "round.start", round: 0 },
            { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
            { kind: "turn.delta", expertSlug: "alice", text: "hi" },
            { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "hi" },
            { kind: "round.end", round: 0 },
          )}
        />,
      );
      await flush();
      const frame = stripAnsi(ui.lastFrame() ?? "");
      const rules = frame.match(/─+/g) ?? [];
      const longestRule = Math.max(0, ...rules.map((r) => r.length));
      expect(longestRule).toBe(100);
      ui.unmount();
    });
  });
});

describe("InkRenderer — untrusted displayName sanitization (adversarial bytes)", () => {
  it("collapses a multi-line displayName to a single line in the turn header", async () => {
    const ui = render(
      <DebateApp
        events={stream(
          {
            kind: "panel.assembled",
            experts: [{ slug: "alice", displayName: "Top\r\nInjected", model: "gpt-5" }],
          },
          { kind: "round.start", round: 0 },
          { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
          { kind: "turn.delta", expertSlug: "alice", text: "hi" },
          { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "hi" },
        )}
      />,
    );
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("Top Injected");
  });

  it("strips control/bidi/line-separator bytes from the turn header displayName", async () => {
    const displayName = "SAFE\u0009\u0000\u0001\u009b\u007f\u202e\u2066\u2028\u2029\r\nTAG";
    const ui = render(
      <DebateApp
        events={stream(
          {
            kind: "panel.assembled",
            experts: [{ slug: "alice", displayName, model: "gpt-5" }],
          },
          { kind: "round.start", round: 0 },
          { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
          { kind: "turn.delta", expertSlug: "alice", text: "hi" },
          { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "hi" },
        )}
      />,
    );
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("SAFE TAG");
    const line = frame.split("\n").find((l) => l.includes("SAFE TAG"));
    expect(line, "expected a rendered line carrying the sanitized name").toBeDefined();
    expect(line ?? "").not.toMatch(FORBIDDEN_DISPLAY_CHARS);
    for (const ch of ["\u0000", "\u0001", "\u009b", "\u007f", "\u202e", "\u2066", "\u2028", "\u2029"]) {
      expect(frame).not.toContain(ch);
    }
  });

  it("strips control/bidi bytes from the panel roster displayName", async () => {
    const displayName = "ROS\u0000\u202e\u2028TER";
    const ui = render(
      <DebateApp
        events={stream({
          kind: "panel.assembled",
          experts: [{ slug: "alice", displayName, model: "gpt-5" }],
        })}
      />,
    );
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("ROS TER");
    const line = frame.split("\n").find((l) => l.includes("ROS TER"));
    expect(line, "expected a rendered roster line carrying the sanitized name").toBeDefined();
    expect(line ?? "").not.toMatch(FORBIDDEN_DISPLAY_CHARS);
    for (const ch of ["\u0000", "\u202e", "\u2028"]) {
      expect(frame).not.toContain(ch);
    }
  });

  it("strips control/bidi bytes from the retry indicator displayName", async () => {
    const displayName = "RET\u0000\u202eRY";
    const neverEnd = async function* (): AsyncIterable<DebateEvent> {
      yield {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName, model: "gpt-5" }],
      };
      yield { kind: "round.start", round: 0 };
      yield { kind: "turn.retry", expertSlug: "alice", attempt: 1, reason: "RATE_LIMITED" };
      await new Promise((_resolve) => {
        /* hold open */
      });
    };
    const ui = render(<DebateApp events={neverEnd()} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    const retryLine = frame.split("\n").find((l) => /retry|retrying/i.test(l));
    expect(retryLine, "expected a retry indicator line").toBeDefined();
    expect(retryLine ?? "").toContain("RETRY");
    expect(retryLine ?? "").not.toMatch(FORBIDDEN_DISPLAY_CHARS);
    ui.unmount();
  });
});
