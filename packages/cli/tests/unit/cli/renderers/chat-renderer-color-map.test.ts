/**
 * Tests for the typed expert chalk color map (#711).
 *
 * The chat renderer previously indexed chalk with an unsafe cast:
 *   chalk[colorName as keyof typeof chalk]
 * which would throw at runtime if the palette ever held a string that
 * isn't a Chalk method. These tests pin a typed `Record<ExpertColor,
 * ChalkInstance>` map that covers every palette color plus the reserved
 * human color, and verify the human (`whiteBright`) path renders.
 */
import { beforeAll, describe, expect, it } from "vitest";
import chalk from "chalk";

import {
  createChatRenderer,
  EXPERT_CHALK_COLORS,
} from "../../../../src/cli/renderers/chat-renderer.js";
import { EXPERT_COLOR_PALETTE, HUMAN_COLOR } from "../../../../src/cli/renderers/ink/colors.js";
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

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

describe("EXPERT_CHALK_COLORS", () => {
  it("maps every palette color to a callable chalk instance", () => {
    for (const name of EXPERT_COLOR_PALETTE) {
      const color = EXPERT_CHALK_COLORS[name];
      expect(typeof color).toBe("function");
      expect(color("x")).toContain("x");
    }
  });

  it("maps the reserved human color to a callable chalk instance", () => {
    const color = EXPERT_CHALK_COLORS[HUMAN_COLOR];
    expect(typeof color).toBe("function");
    expect(color("x")).toContain("x");
  });

  it("has no extra keys beyond the palette plus human color", () => {
    const expected = new Set<string>([...EXPERT_COLOR_PALETTE, HUMAN_COLOR]);
    expect(new Set(Object.keys(EXPERT_CHALK_COLORS))).toEqual(expected);
  });
});

describe("human participant color", () => {
  it("renders a distinct color for human slugs", () => {
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: new Map([["alice", "Alice"]]),
      humanSlugs: new Set(["alice"]),
    });
    renderer.startExpertResponse("alice");
    const codes = sink.text.match(ANSI_RE) ?? [];
    expect(codes.length).toBeGreaterThan(0);
    // whiteBright is SGR 97; assert the human color was applied.
    expect(codes[0]).toBe("\u001b[97m");
  });

  it("applies HUMAN_COLOR (SGR 97) at the showThinking call site for human slugs", () => {
    // Verifies that the showThinking call site also uses HUMAN_COLOR, not a
    // palette color, for human participants (#714).
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: new Map([["user", "You"]]),
      humanSlugs: new Set(["user"]),
    });
    renderer.showThinking("user");
    const codes = sink.text.match(ANSI_RE) ?? [];
    expect(codes.length).toBeGreaterThan(0);
    // SGR 97 = whiteBright = HUMAN_COLOR. A palette color (e.g. SGR 36 cyan) here is a regression.
    expect(codes[0]).toBe("\u001b[97m");
  });

  it("human color differs from the first palette color at startExpertResponse", () => {
    // Discriminating: dropping humanSlugs would assign palette index 0 (cyan/SGR 36) instead.
    const sink1 = new StringSink();
    const humanRenderer = createChatRenderer({
      sink: sink1,
      experts: new Map([["user", "You"]]),
      humanSlugs: new Set(["user"]),
    });
    humanRenderer.startExpertResponse("user");

    const sink2 = new StringSink();
    const expertRenderer = createChatRenderer({
      sink: sink2,
      experts: new Map([["alice", "Alice"]]),
    });
    expertRenderer.startExpertResponse("alice");

    const humanCodes = sink1.text.match(ANSI_RE) ?? [];
    const expertCodes = sink2.text.match(ANSI_RE) ?? [];
    expect(humanCodes[0]).not.toBe(expertCodes[0]);
    expect(humanCodes[0]).toBe("\u001b[97m");
  });
});
