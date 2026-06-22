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

import { appendWordBudget } from "../../../src/core/word-budget.js";

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
