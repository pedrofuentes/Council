/**
 * Tests for extractDocument — Roadmap 6.1.
 *
 * RED at this commit: src/core/documents/extractor.ts does not exist yet.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { extractDocument } from "../../../../src/core/documents/extractor.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("extractDocument", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-extract-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it(".txt content is returned as-is (trimmed)", async () => {
    const filePath = path.join(dir, "notes.txt");
    const raw = "  hello world\nthis is text  \n";
    await fs.writeFile(filePath, raw);
    const result = await extractDocument(filePath);
    expect(result.content).toBe("hello world\nthis is text");
    expect(result.filename).toBe("notes.txt");
    expect(result.path).toBe(filePath);
    expect(result.checksum).toBe(sha256(raw));
    expect(result.sizeBytes).toBe(Buffer.byteLength(raw, "utf-8"));
  });

  it("counts words by whitespace tokens", async () => {
    const filePath = path.join(dir, "notes.txt");
    await fs.writeFile(filePath, "one two three   four\nfive");
    const result = await extractDocument(filePath);
    expect(result.wordCount).toBe(5);
  });

  it("word count is zero for empty content", async () => {
    const filePath = path.join(dir, "empty.txt");
    await fs.writeFile(filePath, "   \n  ");
    const result = await extractDocument(filePath);
    expect(result.wordCount).toBe(0);
  });

  it(".md strips headers, bold, italic, links, images, and code fences", async () => {
    const filePath = path.join(dir, "doc.md");
    const md = [
      "# Heading One",
      "## Heading Two",
      "",
      "Some **bold** and *italic* text with a [link](https://example.com).",
      "",
      "![alt text](image.png)",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "Inline `code` here.",
    ].join("\n");
    await fs.writeFile(filePath, md);
    const result = await extractDocument(filePath);
    expect(result.content).not.toContain("#");
    expect(result.content).not.toContain("**");
    expect(result.content).not.toContain("```");
    expect(result.content).not.toContain("](");
    expect(result.content).not.toContain("![");
    expect(result.content).toContain("Heading One");
    expect(result.content).toContain("Heading Two");
    expect(result.content).toContain("bold");
    expect(result.content).toContain("italic");
    expect(result.content).toContain("link");
    expect(result.content).not.toContain("https://example.com");
    expect(result.content).not.toContain("image.png");
    expect(result.content).not.toContain("const x = 1;");
  });

  it(".html strips tags and decodes basic entities", async () => {
    const filePath = path.join(dir, "page.html");
    const html =
      "<html><body><h1>Title</h1><p>Hello &amp; goodbye, 5 &lt; 10 &gt; 3, &quot;quoted&quot;.</p></body></html>";
    await fs.writeFile(filePath, html);
    const result = await extractDocument(filePath);
    expect(result.content).not.toContain("<h1>");
    expect(result.content).not.toContain("</h1>");
    expect(result.content).not.toContain("<p>");
    expect(result.content).not.toContain("&amp;");
    expect(result.content).not.toContain("&lt;");
    expect(result.content).toContain("Title");
    expect(result.content).toContain("Hello & goodbye");
    expect(result.content).toContain("5 < 10 > 3");
    expect(result.content).toContain('"quoted"');
  });

  it("checksum matches SHA-256 of raw bytes", async () => {
    const filePath = path.join(dir, "x.md");
    const raw = "# Some heading\n\nbody text";
    await fs.writeFile(filePath, raw);
    const result = await extractDocument(filePath);
    expect(result.checksum).toBe(sha256(raw));
  });

  it("UTF-8 multi-byte characters are read correctly", async () => {
    const filePath = path.join(dir, "u.txt");
    await fs.writeFile(filePath, "café — naïve résumé");
    const result = await extractDocument(filePath);
    expect(result.content).toBe("café — naïve résumé");
    expect(result.wordCount).toBe(4);
  });
});
