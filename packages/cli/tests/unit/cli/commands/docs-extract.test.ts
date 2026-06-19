/**
 * Tests for `council docs extract <panel>` (T13, F07).
 *
 * Makes `documents.aiExtraction = ask` actionable: when a panel has
 * files awaiting AI-extraction review, this subcommand prompts the user
 * for confirmation and, on yes, runs the EXISTING extraction path (the
 * same `auto`-mode scan-and-index) so the held files get indexed. On no,
 * nothing is extracted — removing the previous dead-end.
 *
 * Tests inject `scanPanel`, `loadConfigFn`, `confirmProvider`, and
 * `extractPanel` so the action handler can be exercised without a real
 * filesystem, database, prompt, or extraction run.
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildDocsCommand,
  type DocsCommandDeps,
  type PanelScanLookupResult,
} from "../../../../src/cli/commands/docs.js";
import type { ConfirmProvider } from "../../../../src/cli/commands/confirm.js";
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
      backgroundProcessing: false,
      recencyHalfLifeDays: 90,
      supportedFormats: [".md", ".txt", ".pdf"],
    },
    documents: {
      aiExtraction: overrides.aiExtraction ?? "ask",
      aiExtractionAllowedExtensions: [
        ...(overrides.aiExtractionAllowedExtensions ?? []),
      ],
      maxFileSizeMB: 50,
    },
    chat: {
      recentTurnCount: 10,
      summaryMaxWords: 500,
      longConversationWarning: 500,
    },
    paths: { dataHome: "~/Council" },
  } as CouncilConfig;
}

function fileDetail(
  overrides: Partial<ScanFileDetail> & { filename: string },
): ScanFileDetail {
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

function confirmProviderReturning(value: boolean): {
  readonly factory: () => ConfirmProvider;
  readonly confirm: ReturnType<typeof vi.fn>;
} {
  const confirm = vi.fn(async () => value);
  return {
    factory: () => ({ confirm }),
    confirm,
  };
}

describe("council docs extract", () => {
  it("prompts and invokes the extraction path when the user confirms", async () => {
    const review = scanResult({
      needsReview: 1,
      files: [
        fileDetail({
          filename: "deck.key",
          status: "needs-review",
          detectedFormat: "unknown (extension .key)",
        }),
      ],
    });
    const { factory, confirm } = confirmProviderReturning(true);
    const extractPanel = vi.fn(
      async (): Promise<PanelScanLookupResult> => ({
        kind: "scanned",
        result: scanResult({ indexed: 1 }),
      }),
    );

    const { stdout, error } = await runDocs(["extract", "finance"], {
      scanPanel: async () => ({ kind: "scanned", result: review }),
      loadConfigFn: async () => makeConfig({ aiExtraction: "ask" }),
      confirmProvider: factory,
      extractPanel,
    });

    expect(error).toBeUndefined();
    expect(confirm).toHaveBeenCalledOnce();
    expect(extractPanel).toHaveBeenCalledOnce();
    expect(extractPanel).toHaveBeenCalledWith("finance");
    expect(stdout).toContain("deck.key");
    expect(stdout).toMatch(/1 file.*indexed/i);
  });

  it("does NOT invoke the extraction path when the user declines", async () => {
    const review = scanResult({
      needsReview: 1,
      files: [fileDetail({ filename: "deck.key", status: "needs-review" })],
    });
    const { factory, confirm } = confirmProviderReturning(false);
    const extractPanel = vi.fn(
      async (): Promise<PanelScanLookupResult> => ({
        kind: "scanned",
        result: scanResult({ indexed: 1 }),
      }),
    );

    const { stdout, error } = await runDocs(["extract", "finance"], {
      scanPanel: async () => ({ kind: "scanned", result: review }),
      loadConfigFn: async () => makeConfig({ aiExtraction: "ask" }),
      confirmProvider: factory,
      extractPanel,
    });

    expect(error).toBeUndefined();
    expect(confirm).toHaveBeenCalledOnce();
    expect(extractPanel).not.toHaveBeenCalled();
    expect(stdout).toMatch(/abort/i);
  });

  it("reports nothing to do and never prompts when no files await review", async () => {
    const { factory, confirm } = confirmProviderReturning(true);
    const extractPanel = vi.fn(
      async (): Promise<PanelScanLookupResult> => ({
        kind: "scanned",
        result: scanResult({ indexed: 1 }),
      }),
    );

    const { stdout, error } = await runDocs(["extract", "finance"], {
      scanPanel: async () => ({
        kind: "scanned",
        result: scanResult({
          indexed: 2,
          files: [
            fileDetail({ filename: "a.md", status: "indexed" }),
            fileDetail({ filename: "b.txt", status: "indexed" }),
          ],
        }),
      }),
      loadConfigFn: async () => makeConfig({ aiExtraction: "ask" }),
      confirmProvider: factory,
      extractPanel,
    });

    expect(error).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(extractPanel).not.toHaveBeenCalled();
    expect(stdout).toMatch(/no files awaiting/i);
  });

  it("guides the user to enable AI extraction when mode is off", async () => {
    const { factory, confirm } = confirmProviderReturning(true);
    const extractPanel = vi.fn(
      async (): Promise<PanelScanLookupResult> => ({
        kind: "scanned",
        result: scanResult({ indexed: 1 }),
      }),
    );

    const { stdout, error } = await runDocs(["extract", "finance"], {
      scanPanel: async () => ({
        kind: "scanned",
        result: scanResult({
          needsReview: 1,
          files: [
            fileDetail({ filename: "deck.key", status: "needs-review" }),
          ],
        }),
      }),
      loadConfigFn: async () => makeConfig({ aiExtraction: "off" }),
      confirmProvider: factory,
      extractPanel,
    });

    expect(error).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(extractPanel).not.toHaveBeenCalled();
    expect(stdout).toMatch(/config set documents\.aiExtraction/i);
  });

  it("errors when the panel is not found", async () => {
    const { factory } = confirmProviderReturning(true);

    const { stderr, error } = await runDocs(["extract", "ghost"], {
      scanPanel: async () => ({ kind: "not-found" }),
      loadConfigFn: async () => makeConfig({ aiExtraction: "ask" }),
      confirmProvider: factory,
      extractPanel: vi.fn(),
    });

    expect(stderr).toMatch(/not found/i);
    expect(error).toBeDefined();
    expect((error as { exitCode?: number }).exitCode).toBe(1);
  });
});
