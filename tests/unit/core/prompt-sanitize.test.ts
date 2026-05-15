/**
 * Direct unit tests for `sanitizePromptField()` (issue #409).
 *
 * Covers Unicode hardening — NFKC normalization, bidi override stripping,
 * and zero-width character stripping — alongside the previously existing
 * defenses (C0 strip, line-break collapse, `[NN]` defang, length cap).
 */
import { describe, expect, it } from "vitest";

import { sanitizePromptField } from "../../../src/core/prompt-sanitize.js";

describe("sanitizePromptField", () => {
  describe("NFKC normalization", () => {
    it("normalizes fullwidth ASCII letters to plain ASCII", () => {
      // "ＡＢＣ" — U+FF21..U+FF23
      expect(sanitizePromptField("\uFF21\uFF22\uFF23")).toBe("ABC");
    });

    it("normalizes compatibility ligatures", () => {
      // U+FB01 LATIN SMALL LIGATURE FI -> "fi"
      expect(sanitizePromptField("of\uFB01ce")).toBe("office");
    });

    it("normalizes fullwidth digits and brackets", () => {
      // "［１２］" -> "[12]" then defanged to "(sec-12)"
      expect(sanitizePromptField("\uFF3B\uFF11\uFF12\uFF3D")).toBe("(sec-12)");
    });
  });

  describe("bidi override stripping", () => {
    it("strips LRE/RLE/PDF/LRO/RLO (U+202A..U+202E)", () => {
      const input = "a\u202Ab\u202Bc\u202Cd\u202De\u202Ef";
      expect(sanitizePromptField(input)).toBe("abcdef");
    });

    it("strips LRI/RLI/FSI/PDI (U+2066..U+2069)", () => {
      const input = "a\u2066b\u2067c\u2068d\u2069e";
      expect(sanitizePromptField(input)).toBe("abcde");
    });

    it("strips LRM and RLM (U+200E, U+200F)", () => {
      expect(sanitizePromptField("a\u200Eb\u200Fc")).toBe("abc");
    });
  });

  describe("zero-width stripping", () => {
    it("strips ZWSP, ZWNJ, ZWJ (U+200B..U+200D)", () => {
      expect(sanitizePromptField("a\u200Bb\u200Cc\u200Dd")).toBe("abcd");
    });

    it("strips BOM / ZWNBS (U+FEFF)", () => {
      expect(sanitizePromptField("\uFEFFhello\uFEFFworld")).toBe("helloworld");
    });
  });

  describe("existing behavior preserved", () => {
    it("strips C0 control characters but keeps tab/newline/CR for collapsing", () => {
      const input = "a\u0000b\u0001c\u0007d\u007Fe";
      expect(sanitizePromptField(input)).toBe("abcde");
    });

    it("collapses runs of CR/LF/NEL/LS/PS to a single space", () => {
      const input = "line1\r\n\r\nline2\u0085line3\u2028line4\u2029line5";
      expect(sanitizePromptField(input)).toBe("line1 line2 line3 line4 line5");
    });

    it("defangs bracketed numeric section markers", () => {
      expect(sanitizePromptField("[01] hello [42] world")).toBe(
        "(sec-01) hello (sec-42) world",
      );
    });

    it("caps length at 2000 characters with ellipsis", () => {
      const result = sanitizePromptField("x".repeat(2500));
      expect(result.length).toBe(2001); // 2000 + ellipsis
      expect(result.endsWith("…")).toBe(true);
      expect(result.slice(0, 2000)).toBe("x".repeat(2000));
    });

    it("returns short input unchanged when no special characters present", () => {
      expect(sanitizePromptField("plain text")).toBe("plain text");
    });
  });

  describe("combined hardening", () => {
    it("applies NFKC + bidi strip + zero-width strip + C0 strip + defang", () => {
      // fullwidth "[01]" with embedded RLO, ZWSP, NUL, and an extra newline
      const input =
        "\uFF3B\uFF10\uFF11\uFF3D\u202E\u200B\u0000 hello\nworld";
      expect(sanitizePromptField(input)).toBe("(sec-01) hello world");
    });
  });
});
