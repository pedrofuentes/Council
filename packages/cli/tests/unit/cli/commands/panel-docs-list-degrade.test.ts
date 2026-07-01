/**
 * `panel docs list` — resilient to scan failures (#1055, finding #2).
 *
 * Sentinel SNTL-1043 🟡#2: `docs list` triggers a full scan before reading the
 * DB, but discarded the scan result and let scan errors propagate uncaught. A
 * folder/AI-extraction failure could make a formerly read-only `list` throw,
 * or silently present stale results as authoritative.
 *
 * `list` must degrade gracefully: capture the scan outcome, warn when files or
 * folders failed, and — if the scan itself throws — still render the last
 * known DB state with a warning instead of crashing.
 *
 * The scanner is mocked so we can force both failure shapes deterministically.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scanMock = vi.hoisted(() => ({
  mode: "ok" as "ok" | "throw" | "failed",
  calls: 0,
}));

import type * as ScannerModule from "../../../../src/core/documents/panel-document-scanner.js";

vi.mock("../../../../src/core/documents/panel-document-scanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ScannerModule>();
  return {
    ...actual,
    scanAndIndexPanelDocuments: async (): Promise<ScannerModule.PanelScanResult> => {
      scanMock.calls += 1;
      if (scanMock.mode === "throw") {
        throw new Error("simulated scan explosion");
      }
      return {
        indexed: 0,
        unchanged: 0,
        failed: scanMock.mode === "failed" ? 2 : 0,
        needsReview: 0,
        unsupported: 0,
        pruned: 0,
        foldersFailed: scanMock.mode === "failed" ? 1 : 0,
        managedFolderFailed: false,
        files: [],
      };
    },
  };
});

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { createDatabase } from "../../../../src/memory/db.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

function expertDef(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `Expert ${slug}`,
    role: `${slug} role`,
    expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
    epistemicStance: "Empirical",
    kind: "generic",
  };
}

async function seedExpert(env: TestEnv, def: ExpertDefinition): Promise<void> {
  const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

async function createPanel(): Promise<void> {
  const cmd = buildPanelCommand(() => {
    /* noop */
  });
  await cmd.parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"]);
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-list-degrade-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-list-degrade-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  await copyTemplateDb(path.join(home, "council.db"));
  return { home, dataHome, originalHome, originalDataHome };
}

async function teardown(env: TestEnv): Promise<void> {
  if (env.originalHome === undefined) delete process.env["COUNCIL_HOME"];
  else process.env["COUNCIL_HOME"] = env.originalHome;
  if (env.originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
  else process.env["COUNCIL_DATA_HOME"] = env.originalDataHome;
  for (const dir of [env.home, env.dataHome]) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
}

async function runList(): Promise<{ out: string; err: string; error: unknown }> {
  let out = "";
  let err = "";
  const cmd = buildPanelCommand(
    (s) => {
      out += s;
    },
    (s) => {
      err += s;
    },
  );
  const error = await cmd.parseAsync(["node", "council-panel", "docs", "list", "arch-review"]).then(
    () => null,
    (e: unknown) => e,
  );
  return { out, err, error };
}

describe("panel docs list — degrades on scan failure (#1055)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    scanMock.mode = "ok";
    scanMock.calls = 0;
    env = await makeEnv();
    await seedExpert(env, expertDef("cto"));
    await createPanel();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("does not throw when the scan itself throws — renders DB state with a warning", async () => {
    scanMock.mode = "throw";
    const { out, err, error } = await runList();

    expect(scanMock.calls).toBeGreaterThanOrEqual(1);
    // Formerly this threw; now it must complete.
    expect(error).toBeNull();
    // Last known DB state is still rendered ...
    expect(out).toMatch(/no documents found/i);
    // ... alongside a warning that indexing did not complete.
    expect(err).toMatch(/warn|could not|failed|incomplete|stale/i);
  });

  it("warns when the scan reports failed files/folders but still lists", async () => {
    scanMock.mode = "failed";
    const { out, err, error } = await runList();

    expect(error).toBeNull();
    expect(out).toMatch(/no documents found/i);
    expect(err).toMatch(/warn|failed|incomplete/i);
  });
});
