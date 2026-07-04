/**
 * `panel edit` membership/checksum write is ATOMIC (#1931, subsumes #308).
 *
 * The edit path persists the new membership (`panel_members`) and the new
 * `panel_library` row/checksum. Historically these were TWO independent DB
 * writes (`setMembers` then `update`): a crash — or any failure — between them
 * left the panel half-updated (new membership committed, stale checksum, or
 * vice-versa). #308 mitigated one ordering of that split; #1931 removes the
 * split entirely by wrapping BOTH writes in a single transaction so they are
 * applied together or not at all.
 *
 * This test drives `panel edit` with a no-op editor over a YAML whose bytes
 * (and membership) differ from the stored row, then forces the SECOND write —
 * the `panel_library` UPDATE — to fail. With the two writes wrapped in one
 * transaction, the membership change must ROLL BACK (both-or-neither) and the
 * stored checksum must stay at its pre-edit value. Without atomicity the
 * membership write would already be committed by the time the UPDATE fails.
 *
 * The failure is injected at `Kysely.prototype.updateTable`: in the edit flow
 * (createDatabase runs no UPDATEs on an already-migrated DB; findByName +
 * assertExpertsExist are SELECTs; membership is DELETE+INSERT) the FIRST
 * `updateTable` call is the `panel_library` UPDATE, so `mockImplementationOnce`
 * targets exactly the second write.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import * as yaml from "yaml";

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
  readonly originalEditor: string | undefined;
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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-edit-order-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-edit-order-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  const originalEditor = process.env["EDITOR"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  process.env["EDITOR"] = `node -e ""`;
  await copyTemplateDb(path.join(home, "council.db"));
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

describe("panel edit — atomic membership+checksum write (#1931, #308)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await teardown(env);
  });

  it("rolls back the membership change when the panel_library update fails", async () => {
    await seedExpert(env, expertDef("cto"));
    await seedExpert(env, expertDef("security"));
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

    // Capture the pre-edit checksum and membership.
    let originalChecksum: string | undefined;
    {
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new PanelLibraryRepository(db);
        originalChecksum = (await repo.findByName("arch-review"))?.yamlChecksum;
        expect(await repo.getMembers("arch-review")).toEqual(["cto"]);
      } finally {
        await db.destroy();
      }
    }
    expect(originalChecksum).toBeTruthy();

    // Mutate the on-disk YAML so BOTH its bytes (checksum) and its membership
    // change: add "security". A valid edit that alters the panel membership.
    const parsed = yaml.parse(await fs.readFile(yamlPath, "utf-8")) as Record<string, unknown>;
    parsed["description"] = "edited by test — changes the file bytes";
    parsed["experts"] = ["cto", "security"];
    await fs.writeFile(yamlPath, yaml.stringify(parsed), "utf-8");

    // Force the SECOND write (the panel_library UPDATE) to fail. This is the
    // first `updateTable` call in the edit flow, so `mockImplementationOnce`
    // targets exactly the row/checksum write — after the membership write.
    const updateSpy = vi.spyOn(Kysely.prototype, "updateTable").mockImplementationOnce(() => {
      throw new Error("simulated panel_library update failure");
    });

    const editCmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
    );
    const err = await editCmd.parseAsync(["node", "council-panel", "edit", "arch-review"]).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // Atomicity: because the two writes share one transaction, the failing
    // UPDATE must roll the membership write back too. Membership stays ["cto"]
    // (NOT ["cto", "security"]) and the checksum stays at its pre-edit value.
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelLibraryRepository(db);
      expect(await repo.getMembers("arch-review")).toEqual(["cto"]);
      const row = await repo.findByName("arch-review");
      expect(row?.yamlChecksum).toBe(originalChecksum);
    } finally {
      await db.destroy();
    }
  });
});
