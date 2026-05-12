/**
 * TOCTOU regression for `council panel edit`.
 *
 * The bug Sentinel flagged: `panel edit` originally read the YAML once for
 * schema validation, then read it AGAIN to compute the persisted sha256
 * checksum. Between the two awaited reads, the file could change (another
 * process, another tab) so the checksum no longer described the bytes that
 * were actually validated.
 *
 * The fix is to read the file once and reuse the buffer. This test proves
 * that property by mocking `node:fs/promises` to:
 *   1. Count reads of the panel YAML during `panel edit`.
 *   2. Return DIFFERENT bytes on any read after the first.
 *
 * A buggy double-read impl persists a checksum of the mutated bytes — the
 * assertions below fail. The fixed single-read impl persists a checksum
 * of the validated bytes — they pass.
 */
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  yamlReadCount: 0,
  trackedYamlPath: null as string | null,
  originalBytes: null as string | null,
  mutatedBytes: "name: arch-review\nexperts:\n  - cto\n# mutated by test spy\n",
}));

import type FsPromisesModule from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>();
  return {
    ...actual,
    readFile: ((file: unknown, opts: unknown) => {
      if (
        typeof file === "string" &&
        mockState.trackedYamlPath !== null &&
        file === mockState.trackedYamlPath
      ) {
        mockState.yamlReadCount += 1;
        if (mockState.yamlReadCount > 1) {
          return Promise.resolve(mockState.mutatedBytes);
        }
        if (mockState.originalBytes !== null) {
          return Promise.resolve(mockState.originalBytes);
        }
      }
      return (actual.readFile as (f: unknown, o: unknown) => Promise<unknown>)(file, opts);
    }) as typeof actual.readFile,
  };
});

import * as fs from "node:fs/promises";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelLibraryRepository } from "../../../../src/memory/repositories/panel-library-repo.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
  readonly originalEditor: string | undefined;
}

function expertDef(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `Expert ${slug}`,
    role: `${slug} role`,
    expertise: {
      weightedEvidence: ["evidence"],
      referenceCases: [],
      notExpertIn: [],
    },
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

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-toctou-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-toctou-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  const originalEditor = process.env["EDITOR"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  process.env["EDITOR"] = `node -e ""`;
  return { home, dataHome, originalHome, originalDataHome, originalEditor };
}

async function teardown(env: TestEnv): Promise<void> {
  if (env.originalHome === undefined) delete process.env["COUNCIL_HOME"];
  else process.env["COUNCIL_HOME"] = env.originalHome;
  if (env.originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
  else process.env["COUNCIL_DATA_HOME"] = env.originalDataHome;
  if (env.originalEditor === undefined) delete process.env["EDITOR"];
  else process.env["EDITOR"] = env.originalEditor;
  for (const dir of [env.home, env.dataHome]) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
}

describe("panel edit — TOCTOU regression", () => {
  let env: TestEnv;
  beforeEach(async () => {
    mockState.yamlReadCount = 0;
    mockState.trackedYamlPath = null;
    mockState.originalBytes = null;
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("reads the panel YAML exactly once and persists a checksum of those bytes", async () => {
    await seedExpert(env, expertDef("cto"));
    const createCmd = buildPanelCommand(() => {
      /* noop */
    });
    await createCmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "arch-review",
      "--experts",
      "cto",
    ]);

    const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
    mockState.originalBytes = await fs.readFile(yamlPath, "utf-8");
    mockState.trackedYamlPath = yamlPath;
    mockState.yamlReadCount = 0;

    const cmd = buildPanelCommand(() => {
      /* noop */
    });
    await cmd.parseAsync(["node", "council-panel", "edit", "arch-review"]);

    // Hard property #1: the panel YAML is read exactly once during edit.
    expect(mockState.yamlReadCount).toBe(1);

    // Hard property #2: the persisted checksum reflects the validated
    // (first-read) bytes — NOT the mutated bytes a second read would have
    // returned.
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(mockState.originalBytes).digest("hex");
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelLibraryRepository(db);
      const row = await repo.findByName("arch-review");
      expect(row?.yamlChecksum).toBe(expected);
    } finally {
      await db.destroy();
    }
  });
});
