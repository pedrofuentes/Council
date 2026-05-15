/**
 * Tests for `stripControlChars()` — sanitizes untrusted text (e.g. an
 * auto-composed panel name produced by an LLM) before writing it to the
 * terminal. Removes ANSI escape sequences, OSC sequences, and non-printable
 * control characters that could spoof prompts, clear the screen, or
 * exfiltrate data via clipboard hyperlinks.
 */
import { describe, expect, it } from "vitest";

import { stripControlChars } from "../../../src/cli/strip-control-chars.js";

describe("stripControlChars", () => {
  it("returns plain ASCII text unchanged", () => {
    expect(stripControlChars("Hello, world!")).toBe("Hello, world!");
  });

  it("preserves printable Unicode (emoji, accents, CJK)", () => {
    expect(stripControlChars("Café 🏛️ 日本語")).toBe("Café 🏛️ 日本語");
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
});
