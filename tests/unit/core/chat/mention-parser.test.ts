/**
 * Tests for `parseUserInput()` — chat input router for @mention and
 * @convene (Roadmap 5.5 + 5.6).
 */
import { describe, expect, it } from "vitest";

import { parseUserInput } from "../../../../src/core/chat/mention-parser.js";

const SLUGS: readonly string[] = ["cto", "staff", "sre", "pm"];

describe("parseUserInput", () => {
  it("returns type:'general' for a plain message", () => {
    const out = parseUserInput("how do we ship faster?", SLUGS);
    expect(out.type).toBe("general");
    expect(out.targetSlugs).toEqual([]);
    expect(out.content).toBe("how do we ship faster?");
  });

  it("trims leading/trailing whitespace from a general message", () => {
    const out = parseUserInput("   hi there   ", SLUGS);
    expect(out.type).toBe("general");
    expect(out.content).toBe("hi there");
  });

  it("parses a single @mention", () => {
    const out = parseUserInput("@cto what do you think?", SLUGS);
    expect(out.type).toBe("mention");
    expect(out.targetSlugs).toEqual(["cto"]);
    expect(out.content).toBe("what do you think?");
  });

  it("parses multiple @mentions and preserves order", () => {
    const out = parseUserInput("@cto @sre What do you both think?", SLUGS);
    expect(out.type).toBe("mention");
    expect(out.targetSlugs).toEqual(["cto", "sre"]);
    expect(out.content).toBe("What do you both think?");
  });

  it("supports multi-word slugs (e.g. @staff-engineer)", () => {
    const out = parseUserInput(
      "@staff-engineer thoughts on the migration?",
      ["staff-engineer", "cto"],
    );
    expect(out.type).toBe("mention");
    expect(out.targetSlugs).toEqual(["staff-engineer"]);
    expect(out.content).toBe("thoughts on the migration?");
  });

  it("deduplicates repeated mentions, preserving first-occurrence order", () => {
    const out = parseUserInput("@cto @sre @cto are we aligned?", SLUGS);
    expect(out.type).toBe("mention");
    expect(out.targetSlugs).toEqual(["cto", "sre"]);
    expect(out.content).toBe("are we aligned?");
  });

  it("throws when @slug is unknown, listing available slugs", () => {
    expect(() => parseUserInput("@unknown hello", SLUGS)).toThrow(
      /Expert "unknown" is not in this panel/i,
    );
    expect(() => parseUserInput("@unknown hello", SLUGS)).toThrow(
      /cto, staff, sre, pm/,
    );
  });

  it("throws when one of multiple @mentions is unknown", () => {
    expect(() => parseUserInput("@cto @ghost help", SLUGS)).toThrow(
      /Expert "ghost" is not in this panel/i,
    );
  });

  it("parses @convene with a topic", () => {
    const out = parseUserInput("@convene should we adopt Rust?", SLUGS);
    expect(out.type).toBe("convene");
    expect(out.targetSlugs).toEqual([]);
    expect(out.content).toBe("should we adopt Rust?");
  });

  it("treats @convene as reserved even if an expert has slug 'convene'", () => {
    const out = parseUserInput("@convene pick a deployment target", [
      "convene",
      "cto",
    ]);
    expect(out.type).toBe("convene");
    expect(out.content).toBe("pick a deployment target");
  });

  it("throws when @convene has no topic", () => {
    expect(() => parseUserInput("@convene", SLUGS)).toThrow(
      /@convene requires a topic/i,
    );
    expect(() => parseUserInput("@convene   ", SLUGS)).toThrow(
      /@convene requires a topic/i,
    );
  });

  it("@-with-no-slug (bare '@') is treated as part of the message body", () => {
    const out = parseUserInput("contact @ the office", SLUGS);
    expect(out.type).toBe("general");
    expect(out.content).toBe("contact @ the office");
  });

  it("mentions must appear at the start; mid-sentence @cto is plain text", () => {
    const out = parseUserInput("ask @cto about deploys", SLUGS);
    expect(out.type).toBe("general");
    expect(out.content).toBe("ask @cto about deploys");
  });

  it("throws when message starts with @slug but is empty after stripping", () => {
    expect(() => parseUserInput("@cto", SLUGS)).toThrow(
      /requires a message/i,
    );
    expect(() => parseUserInput("@cto   ", SLUGS)).toThrow(
      /requires a message/i,
    );
  });

  it("matching is case-sensitive — uppercase variant is unknown", () => {
    expect(() => parseUserInput("@CTO hi", SLUGS)).toThrow(
      /Expert "CTO" is not in this panel/,
    );
  });
});
