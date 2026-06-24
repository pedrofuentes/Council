/**
 * Tests for `stripControlChars()` — sanitizes untrusted text (e.g. an
 * auto-composed panel name produced by an LLM) before writing it to the
 * terminal. Removes ANSI escape sequences, OSC sequences, and non-printable
 * control characters that could spoof prompts, clear the screen, or
 * exfiltrate data via clipboard hyperlinks.
 */
import { describe, expect, it } from "vitest";

import { stripControlChars, toSingleLineDisplay } from "../../../src/cli/strip-control-chars.js";

describe("stripControlChars", () => {
  it("returns plain ASCII text unchanged", () => {
    expect(stripControlChars("Hello, world!")).toBe("Hello, world!");
  });

  it("preserves printable Unicode (emoji, accents, CJK, NBSP)", () => {
    expect(stripControlChars("Café 🏛️ 日本語\u00A0ok")).toBe("Café 🏛️ 日本語\u00A0ok");
  });

  it("preserves common whitespace (newlines, tabs, CR)", () => {
    expect(stripControlChars("a\nb\tc\r\nd")).toBe("a\nb\tc\r\nd");
  });

  it("strips ANSI CSI color/style sequences", () => {
    const dirty = "\x1B[31mRED\x1B[0m text \x1B[1;32mBOLD GREEN\x1B[0m";
    expect(stripControlChars(dirty)).toBe("RED text BOLD GREEN");
  });

  it("strips ANSI cursor-movement sequences", () => {
    const dirty = "before\x1B[2Aoverwrite\x1B[Hhome";
    expect(stripControlChars(dirty)).toBe("beforeoverwritehome");
  });

  it("strips ANSI clear-screen sequence", () => {
    expect(stripControlChars("\x1B[2Joops")).toBe("oops");
  });

  it("strips OSC sequences (e.g. setting terminal title or hyperlinks)", () => {
    const dirty = "\x1B]0;Evil Title\x07visible";
    expect(stripControlChars(dirty)).toBe("visible");
  });

  it("strips OSC sequences containing embedded newlines", () => {
    const dirty = "before\x1B]8;;https://evil.example/\ncontinued\x07after";
    expect(stripControlChars(dirty)).toBe("beforeafter");
  });

  it("strips an unterminated OSC sequence (no BEL/ST terminator)", () => {
    const dirty = "before\x1B]0;unterminated evil title that never ends";
    expect(stripControlChars(dirty)).toBe("before");
  });

  it("strips an OSC sequence terminated by ST (ESC backslash)", () => {
    const dirty = "a\x1B]8;;https://evil.example/\x1B\\b";
    expect(stripControlChars(dirty)).toBe("ab");
  });

  it("sanitizes many unterminated OSC introducers in linear time (ReDoS guard)", () => {
    const dirty = "\x1B]".repeat(100000);
    const start = performance.now();
    const result = stripControlChars(dirty);
    const elapsed = performance.now() - start;
    expect(result).toBe("");
    expect(elapsed).toBeLessThan(1000);
  });

  it("strips CSI sequences with private and intermediate bytes", () => {
    const dirty = "before\x1B[?25lhide\x1B[>4;2mprivate\x1B[1 qcursor";
    expect(stripControlChars(dirty)).toBe("beforehideprivatecursor");
  });

  it("strips NUL, BEL, BS, and other C0 controls", () => {
    const dirty = "a\x00b\x07c\x08d\x1Ee";
    expect(stripControlChars(dirty)).toBe("abcde");
  });

  it("strips DEL (0x7F)", () => {
    expect(stripControlChars("a\x7Fb")).toBe("ab");
  });

  it("strips C1 control characters (U+0080–U+009F)", () => {
    const dirty = "a\x80b\x9Fc\x85d\x90e";
    expect(stripControlChars(dirty)).toBe("abcde");
  });

  it("strips every C1 control codepoint in the 0x80-0x9F range", () => {
    let dirty = "x";
    for (let cp = 0x80; cp <= 0x9f; cp++) {
      dirty += String.fromCharCode(cp);
    }
    dirty += "y";
    expect(stripControlChars(dirty)).toBe("xy");
  });

  it("preserves printable Latin-1 characters above the C1 range (U+00A0+)", () => {
    expect(stripControlChars("\u00A0\u00A1\u00FF")).toBe("\u00A0\u00A1\u00FF");
  });

  it("handles empty input", () => {
    expect(stripControlChars("")).toBe("");
  });

  it("removes a malicious panel name that tries to overwrite the prior line", () => {
    const malicious = "Auto-Panel\x1B[2K\x1B[1A\x1B[2KEverything is fine.";
    expect(stripControlChars(malicious)).toBe("Auto-PanelEverything is fine.");
  });

  it("strips bidi embedding and override controls (U+202A-U+202E)", () => {
    // U+202A = LEFT-TO-RIGHT EMBEDDING
    // U+202B = RIGHT-TO-LEFT EMBEDDING
    // U+202C = POP DIRECTIONAL FORMATTING
    // U+202D = LEFT-TO-RIGHT OVERRIDE
    // U+202E = RIGHT-TO-LEFT OVERRIDE
    const dirty = "name\u202A\u202B\u202C\u202D\u202Etext";
    expect(stripControlChars(dirty)).toBe("nametext");
  });

  it("strips bidi isolate controls (U+2066-U+2069)", () => {
    // U+2066 = LEFT-TO-RIGHT ISOLATE
    // U+2067 = RIGHT-TO-LEFT ISOLATE
    // U+2068 = FIRST STRONG ISOLATE
    // U+2069 = POP DIRECTIONAL ISOLATE
    const dirty = "name\u2066\u2067\u2068\u2069text";
    expect(stripControlChars(dirty)).toBe("nametext");
  });

  it("strips weak bidi marks (U+061C, U+200E, U+200F)", () => {
    const dirty = "name\u061C\u200E\u200Ftext";
    expect(stripControlChars(dirty)).toBe("nametext");
  });

  it("strips zero-width and hidden format characters", () => {
    const dirty =
      "a\u200Bb\u200Cc\u200Dd\uFEFFe\u00ADf\u2060g\u2064h\u115Fi\u1160j\u3164k\uFFA0l\u{E0001}m";
    expect(stripControlChars(dirty)).toBe("abcdefghijklm");
  });

  it("prevents Trojan Source attack via RLO in expert display name", () => {
    // CVE-2021-42574 attack: use RLO to visually reorder text
    // Example: "Admin\u202EtseT" renders as "AdminTest" but reads right-to-left as "Admintset"
    const maliciousName = "Admin\u202EtseT";
    expect(stripControlChars(maliciousName)).toBe("AdmintseT");
  });
});

describe("toSingleLineDisplay", () => {
  it("strips hidden controls before collapsing line separators", () => {
    const dirty = "safe\x1B]0;bad\nstill bad\x07\u200Bname\r\nnext\tline\u2028last";
    expect(toSingleLineDisplay(dirty)).toBe("safename next line last");
  });
});
