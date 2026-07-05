/**
 * Unit tests for the shared `--experts` parsing helpers (T7).
 *
 * `convene` and `panel create` both declare `--experts` as a *variadic*
 * Commander option so that the comma form (`a,b,c`), the space form
 * (`a b c` — what PowerShell produces from an unquoted `a,b,c`) and the
 * repeated form (`--experts a --experts b`) all capture every expert
 * instead of silently keeping only the first.
 *
 * `parseExpertSlugs` normalises whatever Commander hands the action into a
 * flat, trimmed, de-duplicated, order-preserving slug list. The stray-operand
 * helpers back the "warn instead of silently drop" safety net.
 */
import { describe, expect, it } from "vitest";

import {
  findStrayOperands,
  formatStrayExpertsWarning,
  parseExpertSlugs,
} from "../../../../src/cli/commands/expert-args.js";

// Control / C1 / bidi / line-separator code points that must never reach a
// single-line terminal sink. Mirrors the class stripped by
// `toSingleLineDisplay`.
const FORBIDDEN_DISPLAY_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

describe("parseExpertSlugs", () => {
  it("splits a single comma-separated string (quoted form)", () => {
    expect(parseExpertSlugs("alpha,beta,gamma")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("flattens a variadic array (PowerShell space-split form)", () => {
    expect(parseExpertSlugs(["alpha", "beta", "gamma"])).toEqual(["alpha", "beta", "gamma"]);
  });

  it("comma-splits each element of a variadic array (mixed form)", () => {
    expect(parseExpertSlugs(["alpha,beta", "gamma"])).toEqual(["alpha", "beta", "gamma"]);
  });

  it("trims surrounding whitespace from each slug", () => {
    expect(parseExpertSlugs(["alpha , beta", " gamma "])).toEqual(["alpha", "beta", "gamma"]);
  });

  it("removes duplicates while preserving first-seen order", () => {
    // A panel can never list the same expert twice (panel_members is keyed on
    // (panel_name, expert_slug)), so de-duplication prevents a PK crash.
    expect(parseExpertSlugs(["alpha", "beta", "alpha"])).toEqual(["alpha", "beta"]);
    expect(parseExpertSlugs(["alpha,beta", "beta,gamma"])).toEqual(["alpha", "beta", "gamma"]);
    expect(parseExpertSlugs("alpha,alpha")).toEqual(["alpha"]);
  });

  it("returns an empty array for undefined / blank / commas-only input", () => {
    expect(parseExpertSlugs(undefined)).toEqual([]);
    expect(parseExpertSlugs("")).toEqual([]);
    expect(parseExpertSlugs([""])).toEqual([]);
    expect(parseExpertSlugs(" , ")).toEqual([]);
    expect(parseExpertSlugs([" , ", "  "])).toEqual([]);
  });

  it("never collapses multiple values down to just the first (no silent drop)", () => {
    const result = parseExpertSlugs(["alpha", "beta", "gamma"]);
    expect(result).toHaveLength(3);
    expect(result).not.toEqual(["alpha"]);
  });
});

describe("findStrayOperands", () => {
  it("returns nothing when operands match the declared positional count", () => {
    expect(findStrayOperands(["topic"], 1)).toEqual([]);
  });

  it("returns operands beyond the declared positionals", () => {
    expect(findStrayOperands(["topic", "alpha", "beta"], 1)).toEqual(["alpha", "beta"]);
  });

  it("treats every operand as stray when nothing is declared", () => {
    expect(findStrayOperands(["alpha", "beta"], 0)).toEqual(["alpha", "beta"]);
  });
});

describe("formatStrayExpertsWarning", () => {
  it("names every stray argument and points at --experts + PowerShell quoting", () => {
    const msg = formatStrayExpertsWarning(["beta", "gamma"]);
    expect(msg).toContain("beta");
    expect(msg).toContain("gamma");
    expect(msg).toMatch(/--experts/);
    expect(msg).toMatch(/powershell/i);
  });

  it("sanitizes control, ANSI, and bidi bytes in stray operands (single-line, injection-safe)", () => {
    // A stray operand carrying a CR, an LF, two ANSI CSI sequences, and a bidi
    // override — every class `toSingleLineDisplay` strips or collapses. The
    // operands come straight from argv, so a crafted value must not be able to
    // inject extra lines or emit escape sequences to the terminal.
    const evil = "beta\r\n\x1b[31mred\x1b[0m\u202Eevil";
    const msg = formatStrayExpertsWarning([evil, "gamma"]);

    // No untrusted control / C1 / bidi / line-separator byte reaches the TTY.
    for (const line of msg.split("\n")) {
      expect(line).not.toMatch(FORBIDDEN_DISPLAY_CHARS);
    }
    // The operand cannot inject extra lines: only the 3 template lines remain.
    expect(msg.split("\n").filter((l) => l.length > 0)).toHaveLength(3);
    // BOTH interpolation sinks — the comma-joined list AND the space-joined
    // `--experts` example — render the sanitized, single-line form.
    expect(msg).toContain("beta redevil, gamma");
    expect(msg).toContain("--experts beta redevil gamma");
  });
});
