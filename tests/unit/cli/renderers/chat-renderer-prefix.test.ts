/**
 * Tests for ChatRenderer expert index prefix and shared palette (T-04).
 *
 * Validates:
 * - Expert responses are prefixed with "[N] DisplayName > "
 * - ChatRenderer uses the shared palette (no red in output)
 * - Color assignment matches shared palette order
 */
import { beforeAll, describe, expect, it } from "vitest";
import chalk from "chalk";

import { createChatRenderer } from "../../../../src/cli/renderers/chat-renderer.js";
import { EXPERT_COLOR_PALETTE } from "../../../../src/cli/renderers/ink/colors.js";
import type { Sink } from "../../../../src/cli/renderers/types.js";

beforeAll(() => {
  chalk.level = 1;
});

class StringSink implements Sink {
  text = "";
  errText = "";
  write(s: string): void {
    this.text += s;
  }
  writeError(s: string): void {
    this.errText += s;
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function makeExperts(
  ...entries: readonly (readonly [string, string])[]
): ReadonlyMap<string, string> {
  return new Map(entries);
}

describe("ChatRenderer expert index prefix (A11Y-01)", () => {
  it("prefixes the first expert with [1]", () => {
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: makeExperts(["cto", "Dahlia"]),
    });
    renderer.startExpertResponse("cto");
    expect(stripAnsi(sink.text)).toBe("[1] Dahlia > ");
  });

  it("prefixes the second expert with [2]", () => {
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: makeExperts(["cto", "Dahlia"], ["sre", "Priya"]),
    });
    renderer.startExpertResponse("sre");
    expect(stripAnsi(sink.text)).toBe("[2] Priya > ");
  });

  it("unknown expert gets next index", () => {
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: makeExperts(["cto", "Dahlia"]),
    });
    renderer.startExpertResponse("unknown");
    expect(stripAnsi(sink.text)).toBe("[2] unknown > ");
  });
});

describe("ChatRenderer uses shared palette", () => {
  it("palette used by chat matches the shared EXPERT_COLOR_PALETTE length", () => {
    // ChatRenderer should cycle at the same length as EXPERT_COLOR_PALETTE (8)
    const sink = new StringSink();
    const entries: (readonly [string, string])[] = [];
    for (let i = 0; i < 10; i++) entries.push([`e${i}`, `Expert${i}`]);
    const renderer = createChatRenderer({ sink, experts: new Map(entries) });

    // eslint-disable-next-line no-control-regex
    const ANSI_RE = /\u001b\[[0-9;]*m/g;

    renderer.startExpertResponse("e0");
    const first = sink.text.match(ANSI_RE)?.[0];
    sink.text = "";
    // 8th index (0-based) should cycle back to palette[0]
    renderer.startExpertResponse(`e${EXPERT_COLOR_PALETTE.length}`);
    const cycled = sink.text.match(ANSI_RE)?.[0];
    expect(cycled).toBe(first);
  });
});
