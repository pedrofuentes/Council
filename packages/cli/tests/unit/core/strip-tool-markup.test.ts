/**
 * Tests for `stripToolMarkup()` — removes raw tool/skill-invocation markup
 * that a model may leak into an expert's prose response (F-12 / T-08).
 *
 * Real Copilot-engine debates/asks have surfaced expert turns containing raw
 * tool-call XML instead of prose (an invoke block naming a Skill, a
 * search_skill tag, a Skill tag, a list_skills tag). The sanitizer neutralizes
 * those specific tag shapes before the content reaches the terminal or the
 * transcript DB.
 *
 * The sanitizer is deliberately PRECISE: it only removes the known
 * tool-invocation tag shapes. Ordinary angle-bracket content — TypeScript
 * generics (Array<string>), comparisons (a < b), and HTML shown in prose or
 * code fences — MUST survive untouched.
 *
 * NOTE: tool-markup strings are assembled by the open/close/selfClose builders
 * below rather than written as literals, so this file stays a single source of
 * truth for each tag shape.
 */
import { describe, expect, it } from "vitest";

import { stripToolMarkup } from "../../../src/core/strip-tool-markup.js";

const open = (name: string, attrs = ""): string => `<${name}${attrs}>`;
const close = (name: string): string => `<${"/"}${name}>`;
const selfClose = (name: string, attrs = ""): string => `<${name}${attrs}${"/"}>`;

describe("stripToolMarkup — removes tool/skill-invocation markup", () => {
  it("removes a paired invoke block including its inner content", () => {
    const dirty =
      "Here is my analysis. " +
      open("invoke", ' name="Skill"') +
      "\n" +
      open("parameter", ' name="query"') +
      "inflation" +
      close("parameter") +
      "\n" +
      close("invoke") +
      " The economy is complex.";
    const clean = stripToolMarkup(dirty);
    expect(clean).not.toMatch(/<\/?invoke/);
    expect(clean).not.toMatch(/<\/?parameter/);
    expect(clean).not.toContain("query");
    expect(clean).toContain("Here is my analysis.");
    expect(clean).toContain("The economy is complex.");
  });

  it("removes a self-closing invoke tag", () => {
    const dirty = "Before " + selfClose("invoke", ' name="glob" path="src" ') + " after.";
    const clean = stripToolMarkup(dirty);
    expect(clean).not.toContain("invoke");
    expect(clean).toContain("Before");
    expect(clean).toContain("after.");
  });

  it("removes a paired search_skill block", () => {
    const dirty =
      "Answer: " +
      open("search_skill", ' query="macro"') +
      "looking" +
      close("search_skill") +
      " done.";
    const clean = stripToolMarkup(dirty);
    expect(clean).not.toContain("search_skill");
    expect(clean).not.toContain("looking");
    expect(clean).toContain("Answer:");
    expect(clean).toContain("done.");
  });

  it("removes a self-closing search_skill tag", () => {
    const dirty = "Text " + selfClose("search_skill", ' query="x"') + " more text.";
    const clean = stripToolMarkup(dirty);
    expect(clean).not.toContain("search_skill");
    expect(clean).toContain("Text");
    expect(clean).toContain("more text.");
  });

  it("removes a self-closing list_skills tag", () => {
    const dirty = "Let me check " + selfClose("list_skills") + " the available options.";
    const clean = stripToolMarkup(dirty);
    expect(clean).not.toContain("list_skills");
    expect(clean).toContain("Let me check");
    expect(clean).toContain("the available options.");
  });

  it("removes a paired Skill block (capitalized tag)", () => {
    const dirty =
      "Reasoning: " + open("Skill") + "do-the-thing" + close("Skill") + " and conclude.";
    const clean = stripToolMarkup(dirty);
    expect(clean).not.toMatch(/<\/?Skill>/);
    expect(clean).not.toContain("do-the-thing");
    expect(clean).toContain("Reasoning:");
    expect(clean).toContain("and conclude.");
  });

  it("removes a function_calls wrapper together with the nested invoke/parameter", () => {
    const dirty =
      "Summary. " +
      open("function_calls") +
      open("invoke", ' name="Skill"') +
      open("parameter", ' name="q"') +
      "value" +
      close("parameter") +
      close("invoke") +
      close("function_calls") +
      " End.";
    const clean = stripToolMarkup(dirty);
    expect(clean).not.toContain("function_calls");
    expect(clean).not.toContain("invoke");
    expect(clean).not.toContain("parameter");
    expect(clean).not.toContain("value");
    expect(clean).toContain("Summary.");
    expect(clean).toContain("End.");
  });

  it("removes a namespaced invoke form (XML namespace prefix)", () => {
    const ns = "antml:";
    const dirty =
      "Intro. " +
      open(`${ns}invoke`, ' name="Skill"') +
      open(`${ns}parameter`, ' name="q"') +
      "x" +
      close(`${ns}parameter`) +
      close(`${ns}invoke`) +
      " Outro.";
    const clean = stripToolMarkup(dirty);
    expect(clean).not.toContain("invoke");
    expect(clean).not.toContain("parameter");
    expect(clean).toContain("Intro.");
    expect(clean).toContain("Outro.");
  });

  it("removes an orphaned open invoke tag with no closing tag", () => {
    const dirty = "Prose before. " + open("invoke", ' name="Skill" query="x"') + " trailing.";
    const clean = stripToolMarkup(dirty);
    expect(clean).not.toContain("invoke");
    expect(clean).toContain("Prose before.");
    expect(clean).toContain("trailing.");
  });

  it("removes an orphaned closing search_skill tag", () => {
    const dirty = "Some answer." + close("search_skill") + " More.";
    const clean = stripToolMarkup(dirty);
    expect(clean).not.toContain("search_skill");
    expect(clean).toContain("Some answer.");
    expect(clean).toContain("More.");
  });

  it("removes multiple tool-call blocks in one response", () => {
    const dirty =
      "A " +
      open("invoke", ' name="one"') +
      "x" +
      close("invoke") +
      " B " +
      open("invoke", ' name="two"') +
      "y" +
      close("invoke") +
      " C";
    const clean = stripToolMarkup(dirty);
    expect(clean).not.toContain("invoke");
    expect(clean).toContain("A ");
    expect(clean).toContain("B ");
    expect(clean).toContain("C");
  });

  it("collapses the blank lines left behind when a block occupied whole lines", () => {
    const dirty =
      "Paragraph one.\n\n" +
      open("invoke", ' name="Skill"') +
      "\n" +
      open("parameter", ' name="q"') +
      "v" +
      close("parameter") +
      "\n" +
      close("invoke") +
      "\n\nParagraph two.";
    const clean = stripToolMarkup(dirty);
    expect(clean).toBe("Paragraph one.\n\nParagraph two.");
  });
});

describe("stripToolMarkup — preserves legitimate angle-bracket content", () => {
  it("preserves TypeScript generics", () => {
    const text = "Use Array<string> and Map<string, number> and Promise<void>.";
    expect(stripToolMarkup(text)).toBe(text);
  });

  it("preserves numeric/relational comparisons", () => {
    const text = "If a < b and 5 < 3 is false, then 10 > 2 holds and x<y is compact.";
    expect(stripToolMarkup(text)).toBe(text);
  });

  it("preserves HTML tags shown inside a code fence", () => {
    const text =
      'Here is markup:\n```html\n<div class="card"><span>Hello</span></div>\n```\nThat is valid.';
    expect(stripToolMarkup(text)).toBe(text);
  });

  it("preserves inline HTML-like tags that are not tool calls", () => {
    const text = "Wrap it in a <section> and a <button> for the UI.";
    expect(stripToolMarkup(text)).toBe(text);
  });

  it("does NOT strip words that merely start with a tool-tag name", () => {
    const text = "The <invoker> pattern and a <skills> matrix are design ideas.";
    expect(stripToolMarkup(text)).toBe(text);
  });

  it("returns ordinary prose unchanged (exact no-op)", () => {
    const text =
      "Inflation is driven by supply shocks and demand. The central bank should act cautiously.";
    expect(stripToolMarkup(text)).toBe(text);
  });

  it("returns an empty string unchanged", () => {
    expect(stripToolMarkup("")).toBe("");
  });
});

describe("stripToolMarkup — adversarial input protection (ReDoS defense, #2413)", () => {
  /**
   * #2413 remediation. `stripToolMarkup` sanitizes the FULL input in linear
   * time: there is NO input-length cap and NO truncation, so tool markup can
   * never survive by being cut at a boundary. These tests exercise both
   * documented super-linear vectors — a long horizontal-whitespace run NOT
   * terminated by a newline, and many unmatched tool tags — plus the former
   * truncate-before-sanitize bypass. Oracles assert output CORRECTNESS; a
   * modest per-test timeout (not an in-test wall-clock assertion) is the guard
   * against a super-linear hang, which is deterministic and CI-load tolerant.
   */
  const REDOS_TIMEOUT_MS = 2_000;

  it(
    "fully sanitizes oversized input without truncating or emitting a notice",
    () => {
      // ~200KB of prose wrapping a tool block — well beyond the former 100KB
      // cap. The whole input is sanitized; nothing is dropped or truncated.
      const input =
        "x".repeat(100_000) +
        open("invoke", ' name="Skill"') +
        "inner-secret" +
        close("invoke") +
        "y".repeat(100_000);

      const result = stripToolMarkup(input);

      expect(result).not.toMatch(/<\/?invoke/);
      expect(result).not.toContain("inner-secret");
      // No cap ⇒ no truncation and no sanitizer metadata injected into prose.
      expect(result).not.toMatch(/truncat/i);
      expect(result.startsWith("x")).toBe(true);
      expect(result.endsWith("y")).toBe(true);
    },
    REDOS_TIMEOUT_MS,
  );

  it(
    "closes the truncate-before-sanitize bypass at the former cap boundary",
    () => {
      // A tool block straddles the old 100,000-char slice point: the open tag
      // is cut mid-token, and its close tag + inner payload sit beyond the cut.
      // The rejected implementation leaked a `<invoke na` fragment (no closing
      // `>`, so neither strip regex matched) and dropped the inner payload; the
      // linear sanitizer strips the entire block instead.
      const input =
        "z".repeat(99_990) +
        '<invoke name="Skill">secret-inner</invoke>' +
        "y".repeat(2_000);

      const result = stripToolMarkup(input);

      expect(result).not.toContain("<invoke");
      expect(result).not.toMatch(/<\/?invoke/);
      expect(result).not.toContain("secret-inner");
      expect(result).toContain("z");
      expect(result).toContain("y");
    },
    REDOS_TIMEOUT_MS,
  );

  it(
    "strips tool markup before a long non-newline-terminated whitespace run (under former cap)",
    () => {
      // The `[ \t]+$` vector: a long space run NOT followed by a newline (so the
      // end-anchor fails and a global multiline regex backtracks quadratically).
      // A tool tag is present so the whitespace-tidy path runs; the total stays
      // under the former 100KB cap, so no truncation is involved. The rejected
      // `/[ \t]+$/gm` implementation hangs ~12s here and trips the timeout.
      const input = open("skill") + close("skill") + " ".repeat(99_000) + "x";

      const result = stripToolMarkup(input);

      expect(result).not.toMatch(/<\/?skill>/);
      expect(result).toBe("x"); // tags removed, surrounding whitespace tidied
    },
    REDOS_TIMEOUT_MS,
  );

  it(
    "strips tool markup before a long non-newline-terminated whitespace run (beyond former cap)",
    () => {
      // Same `[ \t]+$` vector on the former truncation path (>100KB). With no
      // cap the entire input is sanitized: no truncation notice, no hang.
      const input =
        open("skill") + close("skill") + " ".repeat(99_000) + "x" + " ".repeat(60_000);

      const result = stripToolMarkup(input);

      expect(result).not.toMatch(/<\/?skill>/);
      expect(result).not.toMatch(/truncat/i);
      expect(result).toBe("x");
    },
    REDOS_TIMEOUT_MS,
  );

  it(
    "strips a very large run of unmatched tool tags in linear time (no cap, no rescanning)",
    () => {
      // The second #2413 vector: many unmatched open tags. Global lazy paired-
      // block matching rescans to end-of-string per tag (super-linear); the
      // tokenizer removes each in a single linear pass. ~2.1MB — far beyond the
      // former cap — so trailing prose must survive and no notice is injected.
      const input =
        open("invoke", ' name="Skill"').repeat(100_000) + " Legitimate closing prose.";

      const result = stripToolMarkup(input);

      expect(result).not.toContain("invoke");
      expect(result).not.toMatch(/truncat/i);
      expect(result).toContain("Legitimate closing prose.");
    },
    REDOS_TIMEOUT_MS,
  );

  it("preserves correct stripping on normal-sized input with tool markup", () => {
    // Ensure the fix doesn't break existing behavior for normal inputs
    const normal =
      "Introduction. " +
      open("invoke", ' name="Skill"') +
      open("parameter", ' name="q"') +
      "value" +
      close("parameter") +
      close("invoke") +
      " Conclusion.";

    const result = stripToolMarkup(normal);
    expect(result).not.toContain("invoke");
    expect(result).not.toContain("parameter");
    expect(result).toContain("Introduction.");
    expect(result).toContain("Conclusion.");
  });
});
