/**
 * Integration test for the real `defaultScanPanel` production glue (#994).
 *
 * Every unit test for `council docs review`/`docs doctor` injects a mocked
 * `scanPanel` dependency, so the real default chain wired inside
 * `defaultScanPanel` is never exercised:
 *
 *   loadConfig → getCouncilDataHome → resolveManagedDocsDir →
 *   ensureDataDirectories → createDatabase(<home>/council.db) →
 *   PanelLibraryRepository.findByName → scanAndIndexPanelDocuments →
 *   db.destroy()
 *
 * These tests build the `docs` command WITHOUT injecting `scanPanel` (so the
 * production `defaultScanPanel` runs) and point `COUNCIL_HOME` /
 * `COUNCIL_DATA_HOME` at a per-test temp directory holding a real SQLite DB
 * (seeded with one panel) and a real on-disk docs corpus. The command output
 * then proves the whole chain executed against real infrastructure — a mocked
 * `scanPanel` or an in-memory DB could not produce it (e.g. the row must
 * survive a second, independent `createDatabase`/`destroy` cycle).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDocsCommand } from "../../src/cli/commands/docs.js";
import { CliUserError } from "../../src/cli/cli-user-error.js";
import { loadConfig } from "../../src/config/index.js";
import { createDatabase } from "../../src/memory/db.js";
import { PanelLibraryRepository } from "../../src/memory/repositories/panel-library-repo.js";
import { mkCanonicalTempDir } from "../helpers/tmp.js";

const PANEL = "arch-review";

interface RunOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly error: unknown;
}

/**
 * Run a `docs` subcommand through the REAL default dependencies (no
 * `scanPanel`/`loadConfigFn` overrides), mirroring how the CLI wires the
 * command in production.
 */
async function runDocs(args: readonly string[]): Promise<RunOutcome> {
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
  let error: unknown = undefined;
  try {
    await cmd.parseAsync(["node", "council-docs", ...args]);
  } catch (err: unknown) {
    error = err;
  }
  return { stdout, stderr, error };
}

describe("docs command → defaultScanPanel production glue (#994)", () => {
  let root: string;
  let prevHome: string | undefined;
  let prevDataHome: string | undefined;

  beforeEach(async () => {
    root = await mkCanonicalTempDir("council-docs-glue-");
    prevHome = process.env["COUNCIL_HOME"];
    prevDataHome = process.env["COUNCIL_DATA_HOME"];
    // Point BOTH the runtime home (council.db lives here) and the data home
    // (panels/<name>/docs live here) at our temp dir so the real chain reads
    // and writes only test-owned paths.
    process.env["COUNCIL_HOME"] = root;
    process.env["COUNCIL_DATA_HOME"] = root;

    // Materialize the default config up front so the command's concurrent
    // loadConfig() calls just read it (no first-run write race in the test).
    await loadConfig();

    // Seed a real panel row into the real on-disk SQLite DB, then close the
    // connection so the command's own createDatabase() opens it independently.
    const db = await createDatabase(path.join(root, "council.db"));
    try {
      await new PanelLibraryRepository(db).create({
        name: PANEL,
        description: null,
        yamlPath: path.join(root, `${PANEL}.yaml`),
        yamlChecksum: "y1",
      });
    } finally {
      await db.destroy();
    }

    // Real docs corpus at the exact managed path the scanner resolves:
    // <dataHome>/panels/<panel>/docs.
    const docsDir = path.join(root, "panels", PANEL, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(
      path.join(docsDir, "spec.md"),
      "# Spec\nhello world from the panel corpus\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = prevHome;
    if (prevDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = prevDataHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("docs doctor runs the real chain and indexes the on-disk corpus", async () => {
    const { stdout, stderr, error } = await runDocs(["doctor", PANEL]);

    expect(error).toBeUndefined();
    expect(stderr).toBe("");
    // Panel resolved via the real findByName (not a mock) and the on-disk
    // spec.md was scanned + indexed by the real scanner.
    expect(stdout).toContain(`Panel "${PANEL}" document health:`);
    expect(stdout).toContain("1 document indexed");
    expect(stdout).toContain("0 files pending review");
    // Config defaults flowed through the real loadConfig.
    expect(stdout).toContain("AI extraction: off");
    expect(stdout).toContain("File size limit: 50 MB");
  });

  it("docs review reports a clean corpus through the real chain", async () => {
    const { stdout, error } = await runDocs(["review", PANEL]);

    expect(error).toBeUndefined();
    expect(stdout).toContain(
      `Panel "${PANEL}": no files need review — all files are indexed.`,
    );
  });

  it("docs doctor surfaces a real findByName miss as a not-found error", async () => {
    const { stderr, error } = await runDocs(["doctor", "ghost-panel"]);

    expect(stderr).toContain('Panel "ghost-panel" not found.');
    expect(error).toBeInstanceOf(CliUserError);
    expect((error as CliUserError).exitCode).toBe(1);
  });

  it("persists indexed state across independent createDatabase cycles", async () => {
    // First invocation indexes the file. A second invocation opens a brand-new
    // connection to the SAME on-disk DB; the file is unchanged, so it is
    // counted from the persisted panel_documents row. `indexedCount` sums
    // indexed + unchanged, so it stays 1 — proving the row survived across two
    // separate createDatabase()/destroy() cycles (impossible with a mock or an
    // in-memory DB).
    const first = await runDocs(["doctor", PANEL]);
    expect(first.error).toBeUndefined();
    expect(first.stdout).toContain("1 document indexed");

    const second = await runDocs(["doctor", PANEL]);
    expect(second.error).toBeUndefined();
    expect(second.stdout).toContain("1 document indexed");
  });
});
