/**
 * Tests for the HTML extractor module (T3).
 *
 * The HTML extractor strips tags, removes <script>/<style> bodies
 * entirely (issue #344), decodes a small set of common entities, and
 * collapses whitespace.
 */
import { describe, expect, it, vi } from "vitest";

import type { ContentExtractor } from "../../../../../src/core/documents/extractors/types.js";

async function loadHtmlExtractor(): Promise<{
  extractor: ContentExtractor;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/html.js");
  const registry = await import(
    "../../../../../src/core/documents/extractors/registry.js"
  );
  const extractor = await registry.getExtractor(".html");
  return { extractor };
}

function ctx(buf: Buffer, ext = ".html"): {
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

describe("html extractor", () => {
  it("strips tags and decodes basic entities", async () => {
    const { extractor } = await loadHtmlExtractor();
    const html =
      "<html><body><h1>Title</h1><p>Hello &amp; goodbye, 5 &lt; 10 &gt; 3, &quot;quoted&quot;.</p></body></html>";
    const out = await extractor(ctx(Buffer.from(html, "utf-8")));
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
    const { extractor } = await loadHtmlExtractor();
    const html = [
      "<html><head>",
      "<style>.hidden-css-token{color:#ff00aa;font-family:Inter}</style>",
      "</head><body>",
      "<h1>Visible Heading</h1>",
      "<script>var SECRET_SCRIPT_TOKEN = 'do-not-index';</script>",
      "<p>Visible body paragraph.</p>",
      "</body></html>",
    ].join("\n");
    const out = await extractor(ctx(Buffer.from(html, "utf-8")));
    expect(out.content).toContain("Visible Heading");
    expect(out.content).toContain("Visible body paragraph");
    expect(out.content).not.toMatch(/<script/i);
    expect(out.content).not.toMatch(/<style/i);
    expect(out.content).not.toContain("SECRET_SCRIPT_TOKEN");
    expect(out.content).not.toContain("hidden-css-token");
  });

  it("strips script/style content even when close tags contain whitespace/newlines", async () => {
    const { extractor } = await loadHtmlExtractor();
    const cases: readonly { html: string; leak: string }[] = [
      { html: "<script>alert(1)</script >", leak: "alert(1)" },
      { html: "<script>bad()</script\n>", leak: "bad()" },
      { html: "<SCRIPT>x()</SCRIPT>", leak: "x()" },
      {
        html: '<script type="text/javascript">y()</script  >',
        leak: "y()",
      },
      { html: "<style>.a{color:red}</style >", leak: "color:red" },
      { html: "<style>.b{margin:0}</style\n>", leak: "margin:0" },
    ];
    for (const { html, leak } of cases) {
      const out = await extractor(
        ctx(Buffer.from(`<body>visible ${html} text</body>`, "utf-8")),
      );
      expect(out.content, `leak from: ${html}`).not.toContain(leak);
      expect(out.content).toContain("visible");
      expect(out.content).toContain("text");
    }
  });

  it("strips script/style content when close tags carry trailing attributes/garbage", async () => {
    const { extractor } = await loadHtmlExtractor();
    const cases: readonly { html: string; leak: string }[] = [
      { html: '<script>alert(1)</script foo="bar">', leak: "alert(1)" },
      { html: "<script>alert(1)</script\t\n bar>", leak: "alert(1)" },
      { html: '<style>.a{color:red}</style foo="bar">', leak: "color:red" },
    ];
    for (const { html, leak } of cases) {
      const out = await extractor(
        ctx(Buffer.from(`<body>visible ${html} text</body>`, "utf-8")),
      );
      expect(out.content, `leak from: ${html}`).not.toContain(leak);
      expect(out.content).toContain("visible");
      expect(out.content).toContain("text");
    }
  });

  it("does not catastrophically backtrack on crafted unclosed script tags (ReDoS guard)", async () => {
    const { extractor } = await loadHtmlExtractor();
    const input = "<script>x" + "</script ".repeat(50000);
    const startedAt = Date.now();
    const out = await extractor(ctx(Buffer.from(input, "utf-8")));
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1000);
    expect(out.content).not.toContain("<script");
  });

  it("does not leak script body when close tag contains a quoted '>'", async () => {
    const { extractor } = await loadHtmlExtractor();
    const html =
      '<body><script>evil()</script attr="a>b">more_evil()</script></body>';
    const out = await extractor(ctx(Buffer.from(html, "utf-8")));
    expect(out.content).not.toContain("evil()");
    expect(out.content).not.toContain("more_evil()");
  });

  it("registers itself for both .html and .htm", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/html.js");
    const registry = await import(
      "../../../../../src/core/documents/extractors/registry.js"
    );
    const a = await registry.getExtractor(".html");
    const b = await registry.getExtractor(".htm");
    expect(a).toBe(b);
  });

  it("counts words after stripping markup", async () => {
    const { extractor } = await loadHtmlExtractor();
    const out = await extractor(
      ctx(Buffer.from("<p>one two three</p>", "utf-8")),
    );
    expect(out.wordCount).toBe(3);
  });
});
