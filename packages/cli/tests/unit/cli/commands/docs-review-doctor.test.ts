/**
 * Tests for `council docs review` and `council docs doctor` (T14).
 *
 * Both subcommands use the existing `PanelDocumentScanner` to discover
 * problem files in a panel's docs corpus. `review` lists files that
 * couldn't be auto-processed (failed extraction or unsupported format)
 * and flags AI-extraction-eligible ones; `doctor` prints a diagnostic
 * health summary (indexed count, words, pending, corrupt, AI mode, file
 * size limit).
 *
 * Tests inject a `scanPanel` and `loadConfigFn` dependency to avoid
 * touching the real filesystem / database — the action handlers only
 * format the data they receive.
 */
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertManagedDocsDirContained,
  buildDocsCommand,
  resolveManagedDocsDir,
  type DocsCommandDeps,
  type PanelScanLookupResult,
} from "../../../../src/cli/commands/docs.js";
import type { CouncilConfig } from "../../../../src/config/index.js";
import type { PanelScanResult } from "../../../../src/core/documents/panel-document-scanner.js";
import type { ScanFileDetail } from "../../../../src/core/documents/scan-types.js";

interface RunOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly error: unknown;
}

async function runDocs(
  args: readonly string[],
  deps: DocsCommandDeps = {},
): Promise<RunOutcome> {
  let stdout = "";
  let stderr = "";
  const cmd = buildDocsCommand(
    (s: string) => {
      stdout += s;
    },
    (s: string) => {
      stderr += s;
    },
    deps,
  );
  cmd.exitOverride();
  let error: unknown = undefined;
  try {
    await cmd.parseAsync(["node", "council-docs", ...args]);
  } catch (err: unknown) {
    error = err;
  }
  return { stdout, stderr, error };
}

function makeConfig(overrides: {
  readonly aiExtraction?: "off" | "ask" | "auto";
  readonly aiExtractionAllowedExtensions?: readonly string[];
  readonly maxFileSizeMB?: number;
} = {}): CouncilConfig {
  return {
    defaults: {
      model: "claude-sonnet-4.5",
      engine: "copilot",
      maxRounds: 4,
      maxExperts: 3,
      maxWordsPerResponse: 250,
    },
    telemetry: { enabled: false },
    expert: {
      recencyHalfLifeDays: 90,
      supportedFormats: [".md", ".txt", ".pdf"],
    },
    documents: {
      aiExtraction: overrides.aiExtraction ?? "off",
      aiExtractionAllowedExtensions: [
        ...(overrides.aiExtractionAllowedExtensions ?? []),
      ],
      maxFileSizeMB: overrides.maxFileSizeMB ?? 50,
    },
    chat: {
      recentTurnCount: 10,
      summaryMaxWords: 500,
      longConversationWarning: 500,
    },
    paths: { dataHome: "~/Council" },
  } as CouncilConfig;
}

function fileDetail(overrides: Partial<ScanFileDetail> & { filename: string }): ScanFileDetail {
  const inferredExt = (() => {
    const dot = overrides.filename.lastIndexOf(".");
    return dot >= 0 ? overrides.filename.slice(dot).toLowerCase() : "";
  })();
  return {
    path: `/tmp/panel/${overrides.filename}`,
    extension: overrides.extension ?? inferredExt,
    status: "indexed",
    ...overrides,
  };
}

function scanResult(overrides: Partial<PanelScanResult> = {}): PanelScanResult {
  return {
    indexed: overrides.indexed ?? 0,
    unchanged: overrides.unchanged ?? 0,
    failed: overrides.failed ?? 0,
    needsReview: overrides.needsReview ?? 0,
    unsupported: overrides.unsupported ?? 0,
    pruned: overrides.pruned ?? 0,
    foldersFailed: overrides.foldersFailed ?? 0,
    managedFolderFailed: overrides.managedFolderFailed ?? false,
    files: overrides.files ?? [],
  };
}

function depsFor(
  scan: PanelScanLookupResult,
  config: CouncilConfig = makeConfig(),
): DocsCommandDeps {
  return {
    scanPanel: async () => scan,
    loadConfigFn: async () => config,
  };
}

describe("council docs review", () => {
  it("reports a clean panel when no files need review", async () => {
    const { stdout, error } = await runDocs(
      ["review", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          indexed: 3,
          files: [
            fileDetail({ filename: "a.md", status: "indexed", wordCount: 100 }),
            fileDetail({ filename: "b.txt", status: "indexed", wordCount: 200 }),
            fileDetail({ filename: "c.pdf", status: "indexed", wordCount: 50 }),
          ],
        }),
      }),
    );

    expect(error).toBeUndefined();
    expect(stdout).toMatch(/no files need review/i);
  });

  it("lists failed files with a human-readable error reason", async () => {
    const { stdout, error } = await runDocs(
      ["review", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          failed: 2,
          files: [
            fileDetail({
              filename: "report.pdf",
              status: "failed",
              errorKind: "encrypted-document",
              errorMessage: "encrypted",
            }),
            fileDetail({
              filename: "data.xlsx",
              status: "failed",
              errorKind: "corrupt-document",
              errorMessage: "bad zip",
            }),
          ],
        }),
      }),
    );

    expect(stdout).toContain("report.pdf");
    expect(stdout).toMatch(/password-protected/i);
    expect(stdout).toContain("data.xlsx");
    expect(stdout).toMatch(/corrupted/i);
    expect(error).toBeDefined();
    expect((error as { exitCode?: number }).exitCode).toBe(1);
  });

  it("suggests `council docs formats` for unsupported files", async () => {
    const { stdout } = await runDocs(
      ["review", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          failed: 1,
          files: [
            fileDetail({
              filename: "archive.rar",
              status: "failed",
              errorKind: "unsupported-format",
              errorMessage: "no extractor",
            }),
          ],
        }),
      }),
    );

    expect(stdout).toContain("archive.rar");
    expect(stdout).toMatch(/unsupported|not supported/i);
    expect(stdout).toContain("council docs formats");
  });

  it("names the extension in the reason for an unsupported file (T2)", async () => {
    const { stdout } = await runDocs(
      ["review", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          failed: 1,
          unsupported: 1,
          files: [
            fileDetail({
              filename: "screenshot.png",
              status: "failed",
              errorKind: "unsupported-format",
              errorMessage: "Unsupported format (.png)",
            }),
          ],
        }),
      }),
    );

    expect(stdout).toContain("screenshot.png");
    expect(stdout).toContain("Unsupported format (.png)");
  });

  it("flags AI-extraction-eligible files when aiExtraction is enabled", async () => {
    const { stdout } = await runDocs(
      ["review", "finance"],
      depsFor(
        {
          kind: "scanned",
          result: scanResult({
            failed: 2,
            files: [
              fileDetail({
                filename: "notes.epub",
                status: "failed",
                errorKind: "unsupported-format",
                errorMessage: "no extractor",
              }),
              fileDetail({
                filename: "archive.rar",
                status: "failed",
                errorKind: "unsupported-format",
                errorMessage: "no extractor",
              }),
            ],
          }),
        },
        makeConfig({
          aiExtraction: "ask",
          aiExtractionAllowedExtensions: [".epub"],
        }),
      ),
    );

    expect(stdout).toContain("notes.epub");
    expect(stdout).toMatch(/AI extraction available/i);
    expect(stdout).toContain("archive.rar");
  });

  it("does not flag AI-eligibility when aiExtraction is off", async () => {
    const { stdout } = await runDocs(
      ["review", "finance"],
      depsFor(
        {
          kind: "scanned",
          result: scanResult({
            failed: 1,
            files: [
              fileDetail({
                filename: "notes.epub",
                status: "failed",
                errorKind: "unsupported-format",
                errorMessage: "no extractor",
              }),
            ],
          }),
        },
        makeConfig({
          aiExtraction: "off",
          aiExtractionAllowedExtensions: [".epub"],
        }),
      ),
    );

    expect(stdout).not.toMatch(/AI extraction available/i);
  });

  it("does not flag a blocklisted extension as AI-extraction-eligible (blocklist wins over allowlist)", async () => {
    const { stdout } = await runDocs(
      ["review", "finance"],
      depsFor(
        {
          kind: "scanned",
          result: scanResult({
            failed: 1,
            files: [
              fileDetail({
                filename: "archive.zip",
                status: "failed",
                errorKind: "unsupported-format",
                errorMessage: "Unsupported format (.zip)",
              }),
            ],
          }),
        },
        makeConfig({
          aiExtraction: "ask",
          aiExtractionAllowedExtensions: [".zip"],
        }),
      ),
    );

    expect(stdout).toContain("archive.zip");
    // `.zip` is blocklisted by the AI fallback, so it can never actually
    // be AI-extracted — even when the user explicitly allowlists it. The
    // "AI extraction available" label must not appear, otherwise
    // `docs extract` is a dead-end for this file.
    expect(stdout).not.toMatch(/AI extraction available/i);
  });

  it("emits an error and non-zero exit when the panel does not exist", async () => {
    const { stderr, error } = await runDocs(
      ["review", "ghost"],
      depsFor({ kind: "not-found" }),
    );

    expect(stderr).toMatch(/panel.*ghost.*not found/i);
    expect(error).toBeDefined();
    expect((error as { exitCode?: number }).exitCode).toBe(1);
  });

  it("requires a panel name argument", async () => {
    const { error } = await runDocs(["review"]);
    expect(error).toBeDefined();
  });

  it("lists needs-review (ask-mode) files and exits non-zero (T-AIPIPE)", async () => {
    const { stdout, error } = await runDocs(
      ["review", "finance"],
      depsFor(
        {
          kind: "scanned",
          result: scanResult({
            indexed: 1,
            needsReview: 1,
            files: [
              fileDetail({ filename: "ok.md", status: "indexed", wordCount: 10 }),
              fileDetail({
                filename: "manual.xyz",
                status: "needs-review",
                detectedFormat: "unknown (extension .xyz)",
              }),
            ],
          }),
        },
        makeConfig({ aiExtraction: "ask" }),
      ),
    );

    expect(stdout).toContain("manual.xyz");
    expect(stdout).toMatch(/needs? review|awaiting/i);
    expect(error).toBeDefined();
    expect((error as { exitCode?: number }).exitCode).toBe(1);
  });

  it("clarifies that ask mode means review, not auto-extraction, when needs-review files exist (T4)", async () => {
    const { stdout } = await runDocs(
      ["review", "finance"],
      depsFor(
        {
          kind: "scanned",
          result: scanResult({
            needsReview: 1,
            files: [
              fileDetail({
                filename: "deck.key",
                status: "needs-review",
              }),
            ],
          }),
        },
        makeConfig({ aiExtraction: "ask" }),
      ),
    );

    // The message must make clear nothing was auto-extracted / indexed —
    // `ask` flags files for review rather than silently extracting them.
    expect(stdout).toMatch(/not (be )?auto-?extracted|review/i);
    expect(stdout).toMatch(/auto-?extract|indexed/i);
  });

  it("does not report a clean panel when only needs-review files exist (T-AIPIPE)", async () => {
    const { stdout } = await runDocs(
      ["review", "finance"],
      depsFor(
        {
          kind: "scanned",
          result: scanResult({
            needsReview: 1,
            files: [
              fileDetail({
                filename: "manual.xyz",
                status: "needs-review",
                detectedFormat: "unknown (extension .xyz)",
              }),
            ],
          }),
        },
        makeConfig({ aiExtraction: "ask" }),
      ),
    );

    expect(stdout).not.toMatch(/no files need review/i);
    expect(stdout).toContain("manual.xyz");
  });

  it("sanitizes needs-review detectedFormat before printing (T-AIPIPE)", async () => {
    const { stdout } = await runDocs(
      ["review", "finance"],
      depsFor(
        {
          kind: "scanned",
          result: scanResult({
            needsReview: 1,
            files: [
              fileDetail({
                filename: "evil.xyz",
                status: "needs-review",
                detectedFormat: "unknown\u001b[31m (extension .xyz)",
              }),
            ],
          }),
        },
        makeConfig({ aiExtraction: "ask" }),
      ),
    );

    expect(stdout).not.toContain("\u001b");
  });
});

describe("council docs doctor", () => {
  it("prints a healthy summary when all files are indexed", async () => {
    const { stdout, error } = await runDocs(
      ["doctor", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          indexed: 12,
          files: [
            fileDetail({ filename: "a.md", status: "indexed", wordCount: 10000 }),
            fileDetail({ filename: "b.pdf", status: "indexed", wordCount: 24521 }),
          ],
        }),
      }),
    );

    expect(error).toBeUndefined();
    expect(stdout).toMatch(/finance.*document health/i);
    expect(stdout).toMatch(/12 documents indexed/i);
    expect(stdout).toContain("34,521");
    expect(stdout).toMatch(/0 files pending review/i);
    expect(stdout).toMatch(/AI extraction:\s*off/i);
    expect(stdout).toMatch(/File size limit:\s*50\s*MB/i);
  });

  it("reports counts and suggestions when there are issues", async () => {
    const { stdout } = await runDocs(
      ["doctor", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          indexed: 5,
          failed: 3,
          files: [
            fileDetail({ filename: "a.md", status: "indexed", wordCount: 100 }),
            fileDetail({
              filename: "broken.xlsx",
              status: "failed",
              errorKind: "corrupt-document",
              errorMessage: "bad zip",
            }),
            fileDetail({
              filename: "secret.pdf",
              status: "failed",
              errorKind: "encrypted-document",
              errorMessage: "encrypted",
            }),
            fileDetail({
              filename: "archive.rar",
              status: "failed",
              errorKind: "unsupported-format",
              errorMessage: "no extractor",
            }),
          ],
        }),
      }),
    );

    expect(stdout).toMatch(/3 files pending review/i);
    expect(stdout).toContain("council docs review");
    expect(stdout).toMatch(/1 file corrupt/i);
    expect(stdout).toContain("broken.xlsx");
  });

  it("reports the count and names of unsupported files (T2)", async () => {
    const { stdout } = await runDocs(
      ["doctor", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          indexed: 1,
          failed: 2,
          unsupported: 2,
          files: [
            fileDetail({ filename: "a.md", status: "indexed", wordCount: 100 }),
            fileDetail({
              filename: "screenshot.png",
              status: "failed",
              errorKind: "unsupported-format",
              errorMessage: "Unsupported format (.png)",
            }),
            fileDetail({
              filename: "archive.zip",
              status: "failed",
              errorKind: "unsupported-format",
              errorMessage: "Unsupported format (.zip)",
            }),
          ],
        }),
      }),
    );

    expect(stdout).toMatch(/2 files unsupported/i);
    expect(stdout).toContain("screenshot.png");
    expect(stdout).toContain("archive.zip");
  });

  it("reflects the configured AI extraction mode", async () => {
    const { stdout } = await runDocs(
      ["doctor", "finance"],
      depsFor(
        { kind: "scanned", result: scanResult({ indexed: 1 }) },
        makeConfig({ aiExtraction: "ask" }),
      ),
    );

    expect(stdout).toMatch(/AI extraction:\s*ask/i);
  });

  it("reflects a custom file size limit", async () => {
    const { stdout } = await runDocs(
      ["doctor", "finance"],
      depsFor(
        { kind: "scanned", result: scanResult({ indexed: 1 }) },
        makeConfig({ maxFileSizeMB: 125 }),
      ),
    );

    expect(stdout).toMatch(/File size limit:\s*125\s*MB/i);
  });

  it("emits an error and non-zero exit when the panel does not exist", async () => {
    const { stderr, error } = await runDocs(
      ["doctor", "ghost"],
      depsFor({ kind: "not-found" }),
    );

    expect(stderr).toMatch(/panel.*ghost.*not found/i);
    expect(error).toBeDefined();
    expect((error as { exitCode?: number }).exitCode).toBe(1);
  });

  it("warns when the managed docs folder failed to scan", async () => {
    const { stdout } = await runDocs(
      ["doctor", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          managedFolderFailed: true,
          foldersFailed: 1,
        }),
      }),
    );

    expect(stdout).toMatch(/managed docs folder.*could not be scanned|failed to scan/i);
  });

  it("counts needs-review files in the pending total and breaks them out (T-AIPIPE)", async () => {
    const { stdout } = await runDocs(
      ["doctor", "finance"],
      depsFor(
        {
          kind: "scanned",
          result: scanResult({
            indexed: 2,
            failed: 1,
            needsReview: 2,
            files: [
              fileDetail({ filename: "a.md", status: "indexed", wordCount: 100 }),
              fileDetail({
                filename: "broken.xlsx",
                status: "failed",
                errorKind: "corrupt-document",
                errorMessage: "bad zip",
              }),
              fileDetail({
                filename: "one.xyz",
                status: "needs-review",
                detectedFormat: "unknown (extension .xyz)",
              }),
              fileDetail({
                filename: "two.xyz",
                status: "needs-review",
                detectedFormat: "unknown (extension .xyz)",
              }),
            ],
          }),
        },
        makeConfig({ aiExtraction: "ask" }),
      ),
    );

    // pending = failed (1) + needsReview (2) = 3
    expect(stdout).toMatch(/3 files pending review/i);
    // A distinct AI-review breakdown line — count must be anchored next to "awaiting".
    expect(stdout).toMatch(/2 files? .*awaiting/i);
  });

  it("shows a distinct encrypted/password-protected category when one encrypted file exists (F26)", async () => {
    const { stdout } = await runDocs(
      ["doctor", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          indexed: 1,
          failed: 1,
          files: [
            fileDetail({ filename: "ok.md", status: "indexed", wordCount: 100 }),
            fileDetail({
              filename: "secret.pdf",
              status: "failed",
              errorKind: "encrypted-document",
              errorMessage: "encrypted",
            }),
          ],
        }),
      }),
    );

    // Must show a distinct encrypted/password-protected line, not just "pending review"
    expect(stdout).toMatch(/encrypted|password-protected/i);
    expect(stdout).toContain("secret.pdf");
  });

  it("counts multiple encrypted files and lists all their names (F26)", async () => {
    const { stdout } = await runDocs(
      ["doctor", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          indexed: 1,
          failed: 2,
          files: [
            fileDetail({ filename: "ok.md", status: "indexed", wordCount: 100 }),
            fileDetail({
              filename: "locked1.pdf",
              status: "failed",
              errorKind: "encrypted-document",
              errorMessage: "encrypted",
            }),
            fileDetail({
              filename: "locked2.pdf",
              status: "failed",
              errorKind: "encrypted-document",
              errorMessage: "encrypted",
            }),
          ],
        }),
      }),
    );

    // Should show "2 files" with encrypted/password-protected label
    expect(stdout).toMatch(/\b2\b.*(?:encrypted|password-protected)/i);
    expect(stdout).toContain("locked1.pdf");
    expect(stdout).toContain("locked2.pdf");
  });

  it("does not conflate encrypted files with corrupt files (F26)", async () => {
    const { stdout } = await runDocs(
      ["doctor", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          indexed: 1,
          failed: 2,
          files: [
            fileDetail({ filename: "ok.md", status: "indexed", wordCount: 100 }),
            fileDetail({
              filename: "broken.xlsx",
              status: "failed",
              errorKind: "corrupt-document",
              errorMessage: "bad zip",
            }),
            fileDetail({
              filename: "secret.pdf",
              status: "failed",
              errorKind: "encrypted-document",
              errorMessage: "encrypted",
            }),
          ],
        }),
      }),
    );

    // Corrupt category should only list the corrupt file
    expect(stdout).toMatch(/1 file corrupt/i);
    expect(stdout).toContain("broken.xlsx");
    // Encrypted category should list the encrypted file distinctly
    expect(stdout).toMatch(/encrypted|password-protected/i);
    expect(stdout).toContain("secret.pdf");
  });

  it("omits the encrypted category line when no encrypted files exist (F26)", async () => {
    const { stdout, error } = await runDocs(
      ["doctor", "finance"],
      depsFor({
        kind: "scanned",
        result: scanResult({
          indexed: 2,
          files: [
            fileDetail({ filename: "a.md", status: "indexed", wordCount: 100 }),
            fileDetail({ filename: "b.pdf", status: "indexed", wordCount: 200 }),
          ],
        }),
      }),
    );

    expect(error).toBeUndefined();
    expect(stdout).not.toMatch(/encrypted|password-protected/i);
  });
});

describe("resolveManagedDocsDir path containment", () => {
  const dataHome = "/home/u/.local/share/council";

  it("builds the docs dir for a valid kebab-case panel name", () => {
    expect(resolveManagedDocsDir(dataHome, "finance")).toBe(
      `${dataHome}/panels/finance/docs`,
    );
  });

  it("rejects a panel name with parent-traversal segments before any scan", () => {
    expect(() => resolveManagedDocsDir(dataHome, "../../etc")).toThrow();
  });

  it("rejects a panel name containing a path separator", () => {
    expect(() => resolveManagedDocsDir(dataHome, "finance/../../etc")).toThrow();
  });

  it("rejects an absolute panel name", () => {
    expect(() => resolveManagedDocsDir(dataHome, "/etc/passwd")).toThrow();
  });

  it("rejects '..' via validatePanelName, not the resolved-path assertion", () => {
    // `..` fails `PANEL_NAME_RE` (no `.` allowed) and is rejected here by
    // `validatePanelName` before the `startsWith` containment assertion is
    // ever reached — see `assertManagedDocsDirContained` below (#1781) for
    // direct coverage of that branch.
    expect(() => resolveManagedDocsDir(dataHome, "..")).toThrow(/invalid panel name|kebab-case/i);
  });
});

describe("assertManagedDocsDirContained — containment startsWith branch (#1781)", () => {
  // `validatePanelName`'s `PANEL_NAME_RE` (`^[a-z][a-z0-9-]*$`) forbids `.`
  // and `/`, so no name that reaches `resolveManagedDocsDir`'s containment
  // check can ever fail it — the throw is unreachable through that public
  // helper (Sentinel SENT-1775-b63cdd0 🟡#2). These tests call the extracted
  // assertion directly with crafted candidate paths to exercise both
  // outcomes of the `startsWith` branch deterministically.
  const dataHome = "/home/u/.local/share/council";
  const panelsRoot = path.resolve(path.join(dataHome, "panels"));

  it("accepts (does not throw for) a candidate path inside the panels root", () => {
    const inside = path.join(dataHome, "panels", "finance", "docs");
    expect(() => assertManagedDocsDirContained(inside, panelsRoot, "finance")).not.toThrow();
  });

  it("rejects (throws) a candidate path that resolves outside the panels root", () => {
    const escaping = path.resolve(dataHome, "..", "etc", "docs");
    expect(() => assertManagedDocsDirContained(escaping, panelsRoot, "evil")).toThrow(
      /escapes panels directory/i,
    );
    expect(() => assertManagedDocsDirContained(escaping, panelsRoot, "evil")).toThrow(
      /name="evil"/,
    );
  });

  it("rejects a sibling directory that only shares the panelsRoot prefix textually", () => {
    // `${panelsRoot}-evil` starts with the same characters as `panelsRoot`
    // but is a sibling directory, not a descendant. A prefix-only check
    // (`startsWith(panelsRoot)` without the trailing separator) would wrongly
    // accept this; the guard must compare against `panelsRoot + path.sep`.
    const siblingEscape = path.join(`${panelsRoot}-evil`, "docs");
    expect(() => assertManagedDocsDirContained(siblingEscape, panelsRoot, "evil")).toThrow(
      /escapes panels directory/i,
    );
  });

  it("rejects the panels root itself (a prefix, not a contained child)", () => {
    expect(() => assertManagedDocsDirContained(panelsRoot, panelsRoot, "root")).toThrow(
      /escapes panels directory/i,
    );
  });
});
