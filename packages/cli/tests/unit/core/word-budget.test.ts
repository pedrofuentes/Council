/**
 * Tests for the soft per-response word-budget helper.
 *
 * `appendWordBudget` turns the previously-ignored `maxWordsPerResponse`
 * config into an actual prompt instruction. It is a soft nudge (not a hard
 * truncation): it appends a length target plus a quality clause so experts
 * stay concise without dropping a falsifiable claim or their disagreement.
 *
 * A non-positive budget (e.g. chat passes `0`) is treated as "no cap" and
 * leaves the task untouched.
 */
import { describe, expect, it } from "vitest";

import { appendWordBudget, resolvePhaseWordBudget } from "../../../src/core/word-budget.js";

const TASK = "Deliver your position. Be specific and stake a clear claim.";

describe("appendWordBudget", () => {
  it("appends a soft length target naming the budget when maxWords > 0", () => {
    const result = appendWordBudget(TASK, 250);

    expect(result).toContain("250 words");
    expect(result).toContain("aim for about");
  });

  it("pairs the length target with a quality clause that protects substance", () => {
    const result = appendWordBudget(TASK, 250);

    // The research-backed framing: concision must not cost a falsifiable claim.
    expect(result).toContain("falsifiable");
  });

  it("preserves the original task verbatim, appending rather than replacing", () => {
    const result = appendWordBudget(TASK, 250);

    expect(result.startsWith(TASK)).toBe(true);
  });

  it("uses the supplied budget value (not a hard-coded 250)", () => {
    const result = appendWordBudget(TASK, 150);

    expect(result).toContain("150 words");
    expect(result).not.toContain("250 words");
  });

  it("returns the task unchanged when maxWords is 0 (the 'no cap' sentinel)", () => {
    expect(appendWordBudget(TASK, 0)).toBe(TASK);
  });

  it("returns the task unchanged when maxWords is negative", () => {
    expect(appendWordBudget(TASK, -5)).toBe(TASK);
  });

  it("returns the task unchanged when maxWords is not finite", () => {
    expect(appendWordBudget(TASK, Number.NaN)).toBe(TASK);
  });

  it("floors a fractional budget so the instruction reads as a whole number", () => {
    const result = appendWordBudget(TASK, 250.9);

    expect(result).toContain("250 words");
    expect(result).not.toContain("250.9");
  });
});

describe("resolvePhaseWordBudget", () => {
  it("keeps the opening phase at the base budget (the anchor)", () => {
    expect(resolvePhaseWordBudget(250, "opening")).toBe(250);
  });

  it("tightens cross-examination to a sharp-question budget", () => {
    expect(resolvePhaseWordBudget(250, "cross-examination")).toBe(150);
  });

  it("tightens rebuttal below the opening budget", () => {
    expect(resolvePhaseWordBudget(250, "rebuttal")).toBe(200);
  });

  it("widens synthesis above the opening budget", () => {
    expect(resolvePhaseWordBudget(250, "synthesis")).toBe(375);
  });

  it("scales relative to the supplied base, not a hard-coded 250", () => {
    expect(resolvePhaseWordBudget(200, "opening")).toBe(200);
    expect(resolvePhaseWordBudget(200, "cross-examination")).toBe(120);
    expect(resolvePhaseWordBudget(200, "synthesis")).toBe(300);
  });

  it("passes the 0 'no cap' sentinel through unchanged for every phase", () => {
    expect(resolvePhaseWordBudget(0, "opening")).toBe(0);
    expect(resolvePhaseWordBudget(0, "synthesis")).toBe(0);
  });

  it("passes a negative budget through unchanged", () => {
    expect(resolvePhaseWordBudget(-5, "rebuttal")).toBe(-5);
  });
});
