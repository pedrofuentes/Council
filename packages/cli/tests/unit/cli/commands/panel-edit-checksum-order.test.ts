/**
 * `panel edit` checksum/membership consistency (#308).
 *
 * Sentinel SNTNL-R3-PR299 F2: `panelRepo.update` (which writes the new
 * `yaml_checksum`) was committed BEFORE `panelRepo.setMembers`. If
 * `setMembers` throws after `update` succeeds, `panel_library.yaml_checksum`
 * reflects the new YAML while `panel_members` still holds the old membership —
 * a silent inconsistency where the checksum falsely claims "in sync".
 *
 * Fix: persist members first, then the row/checksum. Then a `setMembers`
 * failure leaves the OLD checksum in place (so a later op detects the drift
 * and re-syncs) instead of a checksum that lies about the stored membership.
 *
 * This test drives `panel edit` with a no-op editor over a YAML whose bytes
 * differ from the stored checksum, forces `setMembers` to reject, and asserts
 * the stored checksum is UNCHANGED — which only holds if `update` runs after
 * `setMembers`.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("panel edit — checksum/membership write order (#308)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await teardown(env);
  });

  it("leaves the stored checksum unchanged when setMembers fails during edit", async () => {
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

    // Capture the checksum persisted at create time.
    let originalChecksum: string | undefined;
    {
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new PanelLibraryRepository(db);
        originalChecksum = (await repo.findByName("arch-review"))?.yamlChecksum;
      } finally {
        await db.destroy();
      }
    }
    expect(originalChecksum).toBeTruthy();

    // Mutate the on-disk YAML so its bytes (and therefore its checksum) differ
    // from the stored checksum — but keep it valid with the SAME name/experts.
    const parsed = yaml.parse(await fs.readFile(yamlPath, "utf-8")) as Record<string, unknown>;
    parsed["description"] = "edited by test — changes the file bytes";
    await fs.writeFile(yamlPath, yaml.stringify(parsed), "utf-8");

    // Force the membership write to fail. With the buggy order (update first)
    // the new checksum is already committed by the time this rejects.
    const setSpy = vi
      .spyOn(PanelLibraryRepository.prototype, "setMembers")
      .mockRejectedValueOnce(new Error("simulated setMembers failure"));

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
    expect(setSpy).toHaveBeenCalledTimes(1);

    // The persisted checksum must still be the pre-edit value: `update` must
    // not have run before the failing `setMembers`.
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelLibraryRepository(db);
      const row = await repo.findByName("arch-review");
      expect(row?.yamlChecksum).toBe(originalChecksum);
    } finally {
      await db.destroy();
    }
  });
});
