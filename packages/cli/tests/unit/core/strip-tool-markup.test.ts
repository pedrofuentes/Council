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

describe("stripToolMarkup — adversarial input protection (ReDoS defense)", () => {
  /**
   * The length cap policy: stripToolMarkup will sanitize up to MAX_INPUT_LENGTH
   * bytes (100KB). If the input exceeds this limit, the function sanitizes only
   * the allowed prefix and appends a truncation notice so users are aware that
   * content was capped. This prevents super-linear regex behavior from blocking
   * the event loop on adversarial model output.
   */
  const MAX_INPUT_LENGTH = 100_000; // 100KB

  it("caps input length at 100KB and appends a truncation notice", () => {
    // 120KB of legitimate prose + tool markup (exceeds the 100KB cap)
    const hugeProseChunk = "x".repeat(60_000);
    const toolBlock = open("invoke", ' name="Skill"') + "inner content" + close("invoke");
    const moreProseChunk = "y".repeat(60_000);
    const oversizedInput = hugeProseChunk + toolBlock + moreProseChunk;
    expect(oversizedInput.length).toBeGreaterThan(MAX_INPUT_LENGTH);

    const result = stripToolMarkup(oversizedInput);

    // The result should be bounded to approximately the cap
    expect(result.length).toBeLessThanOrEqual(MAX_INPUT_LENGTH + 200); // allow for truncation notice
    // The truncation notice should be present
    expect(result).toMatch(/\[content truncated.*exceeded.*limit\]/i);
    // The result should contain the start of the input
    expect(result.startsWith("x")).toBe(true);
  });

  it("handles 80KB of trailing whitespace without super-linear behavior", () => {
    // This pattern triggers catastrophic backtracking in the old `[ \t]+\n` regex
    const adversarialWhitespace =
      "Prose content. " +
      open("invoke", ' name="Skill"') +
      "parameter" +
      close("invoke") +
      " ".repeat(80_000) + // 80KB of spaces
      "\n" +
      "More prose.";

    // The function should complete in reasonable time and produce correct output
    const start = Date.now();
    const result = stripToolMarkup(adversarialWhitespace);
    const elapsed = Date.now() - start;

    // Should complete in well under 1 second (generous bound to avoid flakiness)
    expect(elapsed).toBeLessThan(500);

    // Correctness: tool markup removed, whitespace tidied
    expect(result).not.toContain("invoke");
    expect(result).toContain("Prose content.");
    expect(result).toContain("More prose.");
    // The trailing whitespace should be collapsed
    expect(result).not.toMatch(/ {100,}/); // no long runs of spaces
  });

  it("handles 500+ unmatched invoke tags without catastrophic re-scanning", () => {
    // Many unmatched opening tags can trigger super-linear behavior in global
    // lazy paired-block matching (the regex engine re-scans repeatedly)
    const unmatched = open("invoke", ' name="Skill"');
    const adversarialTags = unmatched.repeat(500) + " Legitimate prose at the end.";

    const start = Date.now();
    const result = stripToolMarkup(adversarialTags);
    const elapsed = Date.now() - start;

    // Should complete in well under 1 second
    expect(elapsed).toBeLessThan(500);

    // Correctness: all tool tags removed, prose preserved
    expect(result).not.toContain("invoke");
    expect(result).toContain("Legitimate prose at the end.");
  });

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
