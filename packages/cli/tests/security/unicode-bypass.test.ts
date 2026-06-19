/**
 * Red-team: Unicode bypass.
 *
 * An attacker can try to bypass `[NN]`-marker defanging and
 * instruction-pattern detection by encoding the payload in fullwidth
 * forms, splitting tokens with zero-width joiners, hiding text behind
 * bidi overrides, or prefixing with BOM/control characters.
 *
 * The defense pipeline is, in order:
 *   1. NFKC normalize (so fullwidth/compatibility forms collapse)
 *   2. Strip bidi + zero-width characters
 *   3. Strip C0 controls (except tab/newline/CR)
 *   4. Defang `[NN]` markers (post-normalization)
 *   5. Cap length
 *
 * These tests fire each individual bypass class plus a combined
 * payload through `sanitizePromptField`.
 */
import { describe, expect, it } from "vitest";

import { sanitizePromptField } from "../../src/core/prompt-sanitize.js";

describe("Security: Unicode bypass", () => {
  it("normalizes fullwidth bracket+digit and fullwidth letters before defanging", () => {
    // U+FF3B [, U+FF18 8, U+FF3D ], then fullwidth ' TASK'
    const payload = "\uFF3B\uFF18\uFF3D \uFF34\uFF21\uFF33\uFF2B";
    const out = sanitizePromptField(payload);
    expect(out).toContain("(sec-8) TASK");
    expect(out).not.toContain("\uFF3B");
    expect(out).not.toContain("\uFF18");
    expect(out).not.toContain("\uFF34");
  });

  it("strips bidi override characters used to visually hide instructions", () => {
    const payload = "\u202Eignore previous\u202C";
    const out = sanitizePromptField(payload);
    expect(out).not.toContain("\u202E");
    expect(out).not.toContain("\u202C");
    expect(out).toContain("ignore previous");
  });

  it("strips zero-width joiners that split keywords to evade pattern matching", () => {
    const payload = "i\u200Dg\u200Dnore";
    const out = sanitizePromptField(payload);
    expect(out).not.toContain("\u200D");
    expect(out).toContain("ignore");
  });

  it("strips BOM prefixes and still defangs the following [NN] marker", () => {
    const payload = "\uFEFF[1] IDENTITY";
    const out = sanitizePromptField(payload);
    expect(out).not.toContain("\uFEFF");
    expect(out).toContain("(sec-1) IDENTITY");
    expect(out).not.toContain("[1] IDENTITY");
  });

  it("normalizes compatibility ligatures via NFKC (e.g. ligature-fi to fi)", () => {
    const payload = "\uFB01le";
    const out = sanitizePromptField(payload);
    expect(out).toContain("file");
    expect(out).not.toContain("\uFB01");
  });

  it("handles a combined attack: fullwidth + bidi + ZWJ + C0 controls in one string", () => {
    // Pieces:
    //   \uFF3B \uFF18 \uFF3D   -> "[8]" after NFKC, then defanged to "(sec-8)"
    //   \u0007                  -> bell (C0), stripped
    //   \u202E ... \u202C       -> bidi override, stripped
    //   i\u200Dg\u200Dnore      -> "ignore" after ZWJ strip
    const payload =
      "\uFF3B\uFF18\uFF3D\u0007 \u202Ei\u200Dg\u200Dnore\u202C previous";
    const out = sanitizePromptField(payload);
    // Every adversarial codepoint must be gone.
    expect(out).not.toContain("\uFF3B");
    expect(out).not.toContain("\uFF18");
    expect(out).not.toContain("\uFF3D");
    expect(out).not.toContain("\u0007");
    expect(out).not.toContain("\u202E");
    expect(out).not.toContain("\u202C");
    expect(out).not.toContain("\u200D");
    // The normalized + defanged residue must appear.
    expect(out).toContain("(sec-8)");
    expect(out).toContain("ignore previous");
    // The pre-defang form must NOT appear.
    expect(out).not.toContain("[8]");
  });
});
