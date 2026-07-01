/**
 * `panel create` rollback — `fs.unlink` failure branch coverage (#310).
 *
 * Sentinel SNTNL-R3-PR299 F4: the create rollback collects a non-ENOENT
 * `fs.unlink` failure into an `AggregateError` (so the operator sees both the
 * primary failure and the fact that the orphaned YAML could not be removed),
 * and deliberately IGNORES `ENOENT` (the file was already gone — not an error).
 * Only the `panelRepo.delete` rollback branch was previously exercised; this
 * pins the `fs.unlink` branch on both sides.
 *
 * Strategy: force the create to fail mid-flight (stub `setMembers` to reject,
 * which happens AFTER the YAML is written, so rollback attempts the unlink),
 * then make that rollback `fs.unlink` reject with a chosen errno.
 */
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  trackedYamlPath: null as string | null,
  failUnlinkCode: null as string | null,
  unlinkAttempts: 0,
}));

import type FsPromisesModule from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>();
  return {
    ...actual,
    unlink: ((target: unknown, ...rest: unknown[]) => {
      if (
        typeof target === "string" &&
        mockState.trackedYamlPath !== null &&
        target === mockState.trackedYamlPath &&
        mockState.failUnlinkCode !== null
      ) {
        mockState.unlinkAttempts += 1;
        const err = new Error(
          `simulated ${mockState.failUnlinkCode} unlink`,
        ) as NodeJS.ErrnoException;
        err.code = mockState.failUnlinkCode;
        return Promise.reject(err);
      }
      return (actual.unlink as (t: unknown, ...r: unknown[]) => Promise<void>)(target, ...rest);
    }) as typeof actual.unlink,
  };
});

import * as fs from "node:fs/promises";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelLibraryRepository } from "../../../../src/memory/repositories/panel-library-repo.js";
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

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-rollback-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-rollback-data-"));
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

async function runFailingCreate(): Promise<unknown> {
  const setSpy = vi
    .spyOn(PanelLibraryRepository.prototype, "setMembers")
    .mockRejectedValueOnce(new Error("simulated setMembers failure"));
  try {
    const cmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
    );
    return await cmd
      .parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"])
      .then(
        () => null,
        (e: unknown) => e,
      );
  } finally {
    setSpy.mockRestore();
  }
}

describe("panel create rollback — fs.unlink failure branch (#310)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    mockState.trackedYamlPath = null;
    mockState.failUnlinkCode = null;
    mockState.unlinkAttempts = 0;
    env = await makeEnv();
    mockState.trackedYamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
    await seedExpert(env, expertDef("cto"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await teardown(env);
  });

  it("collects a non-ENOENT unlink failure (EPERM) into the AggregateError", async () => {
    mockState.failUnlinkCode = "EPERM";
    const err = await runFailingCreate();

    expect(mockState.unlinkAttempts).toBe(1);
    expect(err).toBeInstanceOf(AggregateError);
    const messages = (err as AggregateError).errors.map((e) =>
      e instanceof Error ? e.message : String(e),
    );
    // Both the primary failure AND the unlink failure must surface.
    expect(messages.some((m) => m.includes("simulated setMembers failure"))).toBe(true);
    expect(messages.some((m) => m.includes("simulated EPERM unlink"))).toBe(true);
  });

  it("ignores an ENOENT unlink result (already gone) — no AggregateError", async () => {
    mockState.failUnlinkCode = "ENOENT";
    const err = await runFailingCreate();

    expect(mockState.unlinkAttempts).toBe(1);
    // ENOENT means the YAML is already absent — not a rollback failure. The
    // primary error propagates verbatim, NOT wrapped in an AggregateError.
    expect(err).not.toBeInstanceOf(AggregateError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("simulated setMembers failure");
  });
});
