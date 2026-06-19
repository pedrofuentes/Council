/**
 * Tests for the HTML extractor module (T3).
 *
 * The HTML extractor strips tags, removes <script>/<style> element
 * bodies entirely (issue #344 — code, not prose), decodes entities, and
 * collapses whitespace.
 *
 * Security focus: the extractor uses a real, tokenizer-based HTML parser
 * (`node-html-parser`) instead of hand-rolled regex/scanner stripping.
 * That defeats the regex bypass classes that produced repeated CodeQL
 * alerts (`js/incomplete-multi-character-sanitization`,
 * `js/bad-tag-filter`) and the O(n^2) generic tag-strip (issue #1212):
 *   - whitespace before `>` in a close tag (`</script >`)
 *   - case variation (`</SCRIPT>`)
 *   - attributes on the open/close tag
 *   - orphan close tags
 *   - quoted `>` inside attributes
 * and runs in linear time (no catastrophic backtracking / ReDoS).
 *
 * Spec note: a `<script>`/`<style>` element is a *raw text* element — per
 * the HTML spec its content ends at the FIRST matching close tag, and any
 * text after that close tag is ordinary, browser-VISIBLE page text. The
 * parser therefore strips every executable script/style BODY, while text
 * that a browser would render after a closed element is preserved (it is
 * not a leak — what is indexed equals what is rendered). The assertions
 * below pin both properties.
 */
import { describe, expect, it, vi } from "vitest";

import type { ContentExtractor } from "../../../../../src/core/documents/extractors/types.js";

async function loadHtmlExtractor(): Promise<{
  extractor: ContentExtractor;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/html.js");
  const registry = await import("../../../../../src/core/documents/extractors/registry.js");
  const extractor = await registry.getExtractor(".html");
  return { extractor };
}

function ctx(
  buf: Buffer,
  ext = ".html",
): {
  buffer: Buffer;
  filename: string;
  extension: string;
  sizeBytes: number;
} {
  return {
    buffer: buf,
    filename: `page${ext}`,
    extension: ext,
    sizeBytes: buf.byteLength,
  };
}

async function run(html: string): Promise<{ content: string; wordCount: number }> {
  const { extractor } = await loadHtmlExtractor();
  return extractor(ctx(Buffer.from(html, "utf-8")));
}

describe("html extractor", () => {
  it("strips tags and decodes basic entities", async () => {
    const html =
      "<html><body><h1>Title</h1><p>Hello &amp; goodbye, 5 &lt; 10 &gt; 3, &quot;quoted&quot;.</p></body></html>";
    const out = await run(html);
    expect(out.content).not.toContain("<h1>");
    expect(out.content).not.toContain("</h1>");
    expect(out.content).not.toContain("<p>");
    expect(out.content).not.toContain("&amp;");
    expect(out.content).not.toContain("&lt;");
    expect(out.content).toContain("Title");
    expect(out.content).toContain("Hello & goodbye");
    expect(out.content).toContain("5 < 10 > 3");
    expect(out.content).toContain('"quoted"');
  });

  it("strips <script> and <style> bodies (issue #344)", async () => {
    const html = [
      "<html><head>",
      "<style>.hidden-css-token{color:#ff00aa;font-family:Inter}</style>",
      "</head><body>",
      "<h1>Visible Heading</h1>",
      "<script>var SECRET_SCRIPT_TOKEN = 'do-not-index';</script>",
      "<p>Visible body paragraph.</p>",
      "</body></html>",
    ].join("\n");
    const out = await run(html);
    expect(out.content).toContain("Visible Heading");
    expect(out.content).toContain("Visible body paragraph");
    expect(out.content).not.toMatch(/<script/i);
    expect(out.content).not.toMatch(/<style/i);
    expect(out.content).not.toContain("SECRET_SCRIPT_TOKEN");
    expect(out.content).not.toContain("hidden-css-token");
  });

  it("registers itself for both .html and .htm", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/html.js");
    const registry = await import("../../../../../src/core/documents/extractors/registry.js");
    const a = await registry.getExtractor(".html");
    const b = await registry.getExtractor(".htm");
    expect(a).toBe(b);
  });

  it("counts words after stripping markup", async () => {
    const out = await run("<p>one two three</p>");
    expect(out.wordCount).toBe(3);
  });

  describe("script/style stripping defeats regex-bypass classes", () => {
    // Each input previously bypassed the hand-rolled regex stripping; the
    // tokenizer-based parser removes the element body entirely so the
    // body token must never appear in the indexed content.
    const scriptBypasses: readonly (readonly [string, string])[] = [
      ["plain", "<script>x</script>"],
      ["whitespace before close >", "<script>x</script >"],
      ["uppercase tag", "<SCRIPT>x</SCRIPT>"],
      ["attribute on open tag", '<script foo="bar">x</script>'],
      ["quoted > in close-tag attribute", '<script>x</script foo="<script>">'],
    ];

    for (const [label, html] of scriptBypasses) {
      it(`removes script body (${label})`, async () => {
        const out = await run(html);
        expect(out.content).not.toContain("x");
        expect(out.content).not.toMatch(/<script/i);
        expect(out.content).not.toMatch(/<\/script/i);
      });
    }

    const styleBypasses: readonly (readonly [string, string])[] = [
      ["plain", "<style>x</style>"],
      ["whitespace before close >", "<style>x</style >"],
      ["uppercase tag", "<STYLE>x</STYLE>"],
      ["attribute on open tag", '<style foo="bar">x</style>'],
      ["quoted > in close-tag attribute", '<style>x</style foo="<style>">'],
    ];

    for (const [label, html] of styleBypasses) {
      it(`removes style body (${label})`, async () => {
        const out = await run(html);
        expect(out.content).not.toContain("x");
        expect(out.content).not.toMatch(/<style/i);
        expect(out.content).not.toMatch(/<\/style/i);
      });
    }

    it("orphan close tags leak nothing", async () => {
      const out = await run('</script foo="bar"></style foo="bar">');
      expect(out.content).not.toMatch(/<\/?script/i);
      expect(out.content).not.toMatch(/<\/?style/i);
    });

    it("strips a script with quoted > and trailing close-tag chain", async () => {
      // The whole `<script>body</script foo="<script>">TRAILING</script>`
      // is consumed as the script element (the quoted `>` does not end the
      // close tag); nothing leaks.
      const out = await run('<script>body</script foo="<script>">TRAILING</script>');
      expect(out.content).not.toContain("body");
      expect(out.content).not.toContain("TRAILING");
      expect(out.content).not.toMatch(/<\/?script/i);
    });
  });

  describe("nested / smuggled script & style bodies", () => {
    // A raw-text element ends at the FIRST close tag. The executable body
    // (the code inside that first element) is ALWAYS stripped. Text after
    // the first close tag is genuine browser-VISIBLE page text — a browser
    // renders it identically, so it is not a smuggling leak. We assert the
    // executable body never leaks and pin the spec-correct visible output.
    it("strips executable body of nested script, keeps spec-visible tail", async () => {
      const out = await run("<script>safe<script>code()</script>SMUGGLED</script>");
      // executable body never leaks:
      expect(out.content).not.toContain("safe");
      expect(out.content).not.toContain("code()");
      expect(out.content).not.toMatch(/<\/?script/i);
      // spec-correct, browser-visible tail:
      expect(out.content).toBe("SMUGGLED");
    });

    it("strips executable body of double-open script, keeps spec-visible tail", async () => {
      const out = await run("<script><script>evil()</script>; leaked()</script>");
      expect(out.content).not.toContain("evil()");
      expect(out.content).not.toMatch(/<\/?script/i);
      expect(out.content).toBe("; leaked()");
    });

    it("strips executable body of nested style, keeps spec-visible tail", async () => {
      const out = await run("<style>safe<style>code()</style>SMUGGLED</style>");
      expect(out.content).not.toContain("safe");
      expect(out.content).not.toContain("code()");
      expect(out.content).not.toMatch(/<\/?style/i);
      expect(out.content).toBe("SMUGGLED");
    });

    it("strips executable body of double-open style, keeps spec-visible tail", async () => {
      const out = await run("<style><style>evil()</style>; leaked()</style>");
      expect(out.content).not.toContain("evil()");
      expect(out.content).not.toMatch(/<\/?style/i);
      expect(out.content).toBe("; leaked()");
    });

    it("does not break on an HTML-comment-wrapped close tag", async () => {
      const out = await run("<script>SECRET<!-- </script> --></script>after");
      expect(out.content).not.toContain("SECRET");
      expect(out.content).toContain("after");
    });
  });

  describe("correctness preserved", () => {
    it("keeps sibling text around a stripped script", async () => {
      const out = await run("a<script>x</script>b");
      expect(out.content).toContain("a");
      expect(out.content).toContain("b");
      expect(out.content).not.toContain("x");
    });

    it("decodes named and numeric entities", async () => {
      const out = await run("<p>a&amp;b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p>");
      expect(out.content).toContain("a&b");
      expect(out.content).toContain("<c>");
      expect(out.content).toContain('"d"');
      expect(out.content).toContain("'e'");
      expect(out.content).not.toContain("&amp;");
      expect(out.content).not.toContain("&#39;");
    });

    it("produces expected plain text for normal markup", async () => {
      const out = await run("<div><p>one two</p><p>three four</p></div>");
      expect(out.content).toContain("one two");
      expect(out.content).toContain("three four");
      expect(out.wordCount).toBeGreaterThanOrEqual(4);
    });
  });

  describe("DoS resistance (linear time, no ReDoS / O(n^2))", () => {
    // The old regex/scanner stripping took 15-33s on these adversarial
    // inputs. A tokenizer-based parser is O(n) and completes in well under
    // a second.
    const BUDGET_MS = 1000;

    it("handles a long orphan-close-tag run quickly", async () => {
      const html = "</script ".repeat(50_000); // ~450 KB
      const start = performance.now();
      const out = await run(html);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(BUDGET_MS);
      expect(out.content).not.toMatch(/<\/?script/i);
    });

    it("handles a script body followed by many orphan closes quickly", async () => {
      const html = "<script>body</script>" + "</script>".repeat(100_000); // ~900 KB
      const start = performance.now();
      const out = await run(html);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(BUDGET_MS);
      expect(out.content).not.toContain("body");
      expect(out.content).not.toMatch(/<\/?script/i);
    });

    it("handles deeply nested markup quickly", async () => {
      let html = "deep";
      for (let i = 0; i < 1_000; i++) html = `<div>${html}</div>`;
      const start = performance.now();
      const out = await run(html);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(BUDGET_MS);
      expect(out.content).toContain("deep");
    });
  });
});
