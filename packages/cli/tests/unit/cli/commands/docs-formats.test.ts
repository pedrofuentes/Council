/**
 * Tests for `council docs formats` (T13).
 *
 * The command lists all supported document formats organized into
 * buckets (Native / Rich Documents / AI Extraction) and reports the
 * configured AI-extraction mode plus the document-extractor file size
 * limit so users can discover what file types they may attach to
 * panels and experts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDocsCommand } from "../../../../src/cli/commands/docs.js";
import { getSupportedExtensions } from "../../../../src/core/documents/extractors/index.js";

async function runDocs(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const cmd = buildDocsCommand(
    (s: string) => {
      stdout += s;
    },
    (s: string) => {
      stderr += s;
    },
  );
  cmd.exitOverride();
  await cmd.parseAsync(["node", "council-docs", ...args]).catch(() => undefined);
  return { stdout, stderr };
}

describe("buildDocsCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-docs-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  describe("docs formats", () => {
    it("prints the top-level header", async () => {
      const { stdout } = await runDocs(["formats"]);
      expect(stdout).toMatch(/Supported Document Formats/i);
    });

    it("includes a Native (text-based) section listing built-in text formats", async () => {
      const { stdout } = await runDocs(["formats"]);
      expect(stdout).toMatch(/Native/i);
      expect(stdout).toContain(".md");
      expect(stdout).toContain(".txt");
      expect(stdout).toContain(".html");
    });

    it("includes a Rich Documents section listing rich formats", async () => {
      const { stdout } = await runDocs(["formats"]);
      expect(stdout).toMatch(/Rich Documents/i);
      expect(stdout).toContain(".pdf");
      expect(stdout).toContain(".docx");
      expect(stdout).toContain(".pptx");
      expect(stdout).toContain(".xlsx");
      expect(stdout).toContain(".csv");
      expect(stdout).toContain(".tsv");
      expect(stdout).toContain(".rtf");
      expect(stdout).toContain(".odt");
      expect(stdout).toContain(".ods");
      expect(stdout).toContain(".odp");
    });

    it("renders every extension reported by the extractor registry", async () => {
      const { stdout } = await runDocs(["formats"]);
      const registered = getSupportedExtensions();
      expect(registered.length).toBeGreaterThan(0);
      for (const ext of registered) {
        expect(stdout).toContain(ext);
      }
    });

    it("shows the AI extraction status as 'off' for the default config", async () => {
      const { stdout } = await runDocs(["formats"]);
      expect(stdout).toMatch(/AI Extraction/i);
      expect(stdout).toMatch(/Status:\s*off/i);
    });

    it("shows the AI extraction status as 'ask' when configured", async () => {
      await fs.writeFile(
        path.join(testHome, "config.yaml"),
        "documents:\n  aiExtraction: ask\n",
        "utf8",
      );
      const { stdout } = await runDocs(["formats"]);
      expect(stdout).toMatch(/Status:\s*ask/i);
    });

    it("shows the AI extraction status as 'auto' when configured", async () => {
      await fs.writeFile(
        path.join(testHome, "config.yaml"),
        "documents:\n  aiExtraction: auto\n",
        "utf8",
      );
      const { stdout } = await runDocs(["formats"]);
      expect(stdout).toMatch(/Status:\s*auto/i);
    });

    it("displays the configure hint for AI extraction", async () => {
      const { stdout } = await runDocs(["formats"]);
      expect(stdout).toContain("documents.aiExtraction");
    });

    it("explains what AI extraction is and when to enable it", async () => {
      const { stdout } = await runDocs(["formats"]);
      // PM-01: the block must explain WHAT AI extraction does, not just
      // expose its on/off status — it builds a structured text
      // description of files no native extractor can read, so experts can
      // still reference them...
      expect(stdout).toMatch(/structured text description/i);
      expect(stdout).toMatch(/experts/i);
      // ...and WHEN/WHY to turn it on.
      expect(stdout).toMatch(/when to enable/i);
    });

    it("documents the allowed-extensions configure hint", async () => {
      const { stdout } = await runDocs(["formats"]);
      // PM-09 made `aiExtractionAllowedExtensions` settable; `formats`
      // should point users at it so the allow-list is discoverable.
      expect(stdout).toContain("documents.aiExtractionAllowedExtensions");
    });

    it("displays the file size limit from the default config", async () => {
      const { stdout } = await runDocs(["formats"]);
      expect(stdout).toMatch(/File size limit:\s*50\s*MB/i);
      expect(stdout).toContain("documents.maxFileSizeMB");
    });

    it("reflects a custom file size limit from config", async () => {
      await fs.writeFile(
        path.join(testHome, "config.yaml"),
        "documents:\n  maxFileSizeMB: 125\n",
        "utf8",
      );
      const { stdout } = await runDocs(["formats"]);
      expect(stdout).toMatch(/File size limit:\s*125\s*MB/i);
    });

    it("lists configured AI-extraction whitelisted extensions when present", async () => {
      await fs.writeFile(
        path.join(testHome, "config.yaml"),
        'documents:\n  aiExtraction: ask\n  aiExtractionAllowedExtensions: [".epub", ".mobi"]\n',
        "utf8",
      );
      const { stdout } = await runDocs(["formats"]);
      expect(stdout).toContain(".epub");
      expect(stdout).toContain(".mobi");
    });

    it("strips control characters from config-sourced values in output", async () => {
      // A malicious config could embed ANSI escapes or control chars
      // in aiExtractionAllowedExtensions. The output must sanitize them.
      await fs.writeFile(
        path.join(testHome, "config.yaml"),
        'documents:\n  aiExtraction: ask\n  aiExtractionAllowedExtensions: [".ok", "\\x1b[31mhacked\\x1b[0m"]\n',
        "utf8",
      );
      const { stdout } = await runDocs(["formats"]);
      // The raw ANSI escape sequence must not appear in output
      expect(stdout).not.toContain("\x1b[31m");
      expect(stdout).not.toContain("\x1b[0m");
    });

    it("falls back to the uppercased extension when no explicit label is registered (#981)", async () => {
      // describeExtension() (docs.ts) is `EXTENSION_LABELS[ext] ?? ext.toUpperCase()`
      // and is not exported, so the fallback arm is driven through the public
      // `docs formats` command instead. The extractor registry is process-wide
      // module state (see tests/unit/core/documents/extractors/registry.test.ts),
      // so reset the module graph and dynamically re-import both the registry
      // and docs.js to register a throwaway, deliberately unlabeled extension
      // without leaking it into the registry shared by the other tests in this
      // file (which keep using the statically-imported originals).
      vi.resetModules();
      const registry = await import(
        "../../../../src/core/documents/extractors/registry.js"
      );
      const fakeExtractor = async () => ({ content: "", wordCount: 0 });
      // ".xyz" has no entry in docs.ts's EXTENSION_LABELS map.
      registry.registerExtractor([".xyz"], async () => fakeExtractor);

      const { buildDocsCommand: freshBuildDocsCommand } = await import(
        "../../../../src/cli/commands/docs.js"
      );
      let stdout = "";
      const cmd = freshBuildDocsCommand(
        (s: string) => {
          stdout += s;
        },
        () => undefined,
      );
      cmd.exitOverride();
      await cmd
        .parseAsync(["node", "council-docs", "formats"])
        .catch(() => undefined);

      // Fallback branch: unlabeled extension -> exactly its uppercased form.
      const xyzLine = /^ {2}\.xyz\s+(.+)$/m.exec(stdout);
      expect(xyzLine?.[1]).toBe("XYZ");

      // Labeled branch stays distinct from its uppercased form, proving this
      // exercises the fallback arm specifically and not just any extension.
      const mdLine = /^ {2}\.md\s+(.+)$/m.exec(stdout);
      expect(mdLine?.[1]).toBe("Markdown");
    });
  });
});
