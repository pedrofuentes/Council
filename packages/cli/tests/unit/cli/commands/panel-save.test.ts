/**
 * T9 — `council panel save <session> [name]` promotes a convened session
 * into a reusable LIBRARY panel + its experts, read from the
 * `ResolvedPanelDefinition` that convene stored in the session's
 * `config_json`. Afterwards `council panels` lists it and `council chat
 * <name>` resolves it (proxied here by `loadPanel`, which is exactly what
 * chat uses to resolve a library panel).
 *
 * Collision policy (documented in DECISIONS.md ADR + command output):
 * suffix `-2`, `-3`, … when a promoted panel name or expert slug already
 * exists in the library — promotion never clobbers or silently reuses
 * existing artifacts.
 *
 * RED at this commit: `panel save` does not exist yet.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import type { ResolvedPanelDefinition } from "../../../../src/core/template-loader.js";
import { loadPanel } from "../../../../src/core/template-loader.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { FileExpertLibrary } from "../../../../src/core/expert-library.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { PanelLibraryRepository } from "../../../../src/memory/repositories/panel-library-repo.js";
import { ExpertLibraryRepository } from "../../../../src/memory/repositories/expert-library-repo.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-panelsave-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panelsave-data-"));
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

function expertDef(slug: string, overrides: Partial<ExpertDefinition> = {}): ExpertDefinition {
  return {
    slug,
    displayName: `${slug} (Role)`,
    role: `${slug} role`,
    model: "test-model",
    expertise: {
      weightedEvidence: [`${slug}-evidence`],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: `${slug} forms beliefs empirically.`,
    kind: "generic",
    ...overrides,
  };
}

function autoDefinition(slugs: readonly string[]): ResolvedPanelDefinition {
  return {
    name: "auto-panel",
    description: "Auto-composed panel for the topic",
    experts: slugs.map((s) => expertDef(s)),
  };
}

/** Seed a convened SESSION row carrying a stored ResolvedPanelDefinition. */
async function seedSession(
  env: TestEnv,
  opts: {
    readonly name: string;
    readonly definition?: ResolvedPanelDefinition;
    readonly mode?: string;
    readonly omitDefinition?: boolean;
  },
): Promise<string> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const repo = new PanelRepository(db);
    const config: Record<string, unknown> = {
      template: opts.definition?.name ?? "legacy",
      mode: opts.mode ?? "freeform",
      engine: "mock",
    };
    if (opts.omitDefinition !== true) {
      config["definition"] = opts.definition ?? autoDefinition(["alpha", "beta", "gamma"]);
    }
    const panel = await repo.create({
      name: opts.name,
      topic: "Should we adopt event sourcing?",
      copilotHome: path.join(env.home, "copilot"),
      configJson: JSON.stringify(config),
    });
    return panel.name;
  } finally {
    await db.destroy();
  }
}

async function seedLibraryExpert(env: TestEnv, def: ExpertDefinition): Promise<void> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("panel save (T9)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await teardown(env);
  });

  it("registers a `save` subcommand on the panel command", () => {
    const cmd = buildPanelCommand();
    const subs = cmd.commands.map((c) => c.name());
    expect(subs).toContain("save");
  });

  it("promotes a session into a library panel + experts that chat/list can resolve", async () => {
    const sessionName = await seedSession(env, {
      name: "auto-panel-2026-06-15T12:00:00",
      definition: autoDefinition(["alpha", "beta", "gamma"]),
    });

    let stdout = "";
    const cmd = buildPanelCommand(
      (s) => {
        stdout += s;
      },
      () => undefined,
    );
    await cmd.parseAsync(["node", "council-panel", "save", sessionName, "mypanel"]);

    // panel_library row exists.
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const panelRepo = new PanelLibraryRepository(db);
      const saved = await panelRepo.findByName("mypanel");
      expect(saved).toBeDefined();

      // panel_members carries the ordered expert slugs.
      const members = await panelRepo.getMembers("mypanel");
      expect([...members]).toEqual(["alpha", "beta", "gamma"]);

      // expert_library rows exist for each promoted expert.
      const expertRepo = new ExpertLibraryRepository(db);
      for (const slug of ["alpha", "beta", "gamma"]) {
        expect(await expertRepo.findBySlug(slug)).toBeDefined();
      }
    } finally {
      await db.destroy();
    }

    // YAML artifact written under <dataHome>/panels/.
    expect(await fileExists(path.join(env.dataHome, "panels", "mypanel.yaml"))).toBe(true);

    // chat resolves a library panel via loadPanel — assert it loads.
    const loaded = await loadPanel("mypanel", env.dataHome);
    expect(loaded.name).toBe("mypanel");

    // `council panels` (list) shows it.
    let listOut = "";
    const listCmd = buildPanelCommand((s) => {
      listOut += s;
    });
    await listCmd.parseAsync(["node", "council-panel", "list"]);
    expect(listOut).toContain("mypanel");

    // Success output confirms the save + how to chat with it.
    expect(stdout).toContain("mypanel");
    expect(stdout).toMatch(/council chat mypanel/);
  });

  it("defaults the panel name to the composed definition name when omitted", async () => {
    const sessionName = await seedSession(env, {
      name: "auto-panel-2026-06-15T12:30:00",
      definition: autoDefinition(["alpha", "beta"]),
    });
    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await cmd.parseAsync(["node", "council-panel", "save", sessionName]);

    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const saved = await new PanelLibraryRepository(db).findByName("auto-panel");
      expect(saved).toBeDefined();
    } finally {
      await db.destroy();
    }
  });

  it("suffixes panel name and expert slugs on collision (non-destructive)", async () => {
    // Pre-existing library expert + panel that will collide.
    await seedLibraryExpert(env, expertDef("alpha", { displayName: "Existing Alpha" }));
    const createCmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await createCmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "mypanel",
      "--experts",
      "alpha",
    ]);

    const sessionName = await seedSession(env, {
      name: "auto-panel-2026-06-15T13:00:00",
      definition: autoDefinition(["alpha", "gamma"]),
    });

    let stdout = "";
    const cmd = buildPanelCommand(
      (s) => {
        stdout += s;
      },
      () => undefined,
    );
    await cmd.parseAsync(["node", "council-panel", "save", sessionName, "mypanel"]);

    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const panelRepo = new PanelLibraryRepository(db);
      // Original panel untouched; promoted panel suffixed.
      expect(await panelRepo.findByName("mypanel")).toBeDefined();
      expect(await panelRepo.findByName("mypanel-2")).toBeDefined();
      const members = await panelRepo.getMembers("mypanel-2");
      expect([...members]).toEqual(["alpha-2", "gamma"]);

      // Original "mypanel" still has its original single member.
      expect([...(await panelRepo.getMembers("mypanel"))]).toEqual(["alpha"]);

      // Original expert "alpha" is untouched; a suffixed copy was created.
      const expertRepo = new ExpertLibraryRepository(db);
      const original = await expertRepo.findBySlug("alpha");
      expect(original?.displayName).toBe("Existing Alpha");
      expect(await expertRepo.findBySlug("alpha-2")).toBeDefined();
      expect(await expertRepo.findBySlug("gamma")).toBeDefined();
    } finally {
      await db.destroy();
    }

    // The renames are surfaced to the user.
    expect(stdout).toContain("mypanel-2");
    expect(stdout).toContain("alpha-2");
  });

  // F22 — repeated `panel save` of the SAME session must be idempotent with
  // respect to expert clones: an equivalent clone (same base slug + identical
  // defining content) is REUSED rather than re-cloned into a fresh `-2`/`-3`
  // suffix, so the expert library does not accumulate duplicates.
  it("reuses equivalent expert clones on repeated saves (idempotent — no -2 accrual)", async () => {
    const sessionName = await seedSession(env, {
      name: "auto-panel-2026-06-15T17:00:00",
      definition: autoDefinition(["alpha", "beta", "gamma"]),
    });

    const firstSave = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await firstSave.parseAsync(["node", "council-panel", "save", sessionName, "mypanel"]);

    const secondSave = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await secondSave.parseAsync(["node", "council-panel", "save", sessionName, "mypanel"]);

    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const expertRepo = new ExpertLibraryRepository(db);
      // The original clones still exist…
      for (const slug of ["alpha", "beta", "gamma"]) {
        expect(await expertRepo.findBySlug(slug)).toBeDefined();
      }
      // …and the second save did NOT create duplicate `-2` clones.
      expect(await expertRepo.findBySlug("alpha-2")).toBeUndefined();
      expect(await expertRepo.findBySlug("beta-2")).toBeUndefined();
      expect(await expertRepo.findBySlug("gamma-2")).toBeUndefined();

      const panelRepo = new PanelLibraryRepository(db);
      // Both saved panels reference the SAME reused experts.
      expect([...(await panelRepo.getMembers("mypanel"))]).toEqual(["alpha", "beta", "gamma"]);
      expect([...(await panelRepo.getMembers("mypanel-2"))]).toEqual(["alpha", "beta", "gamma"]);
    } finally {
      await db.destroy();
    }
  });

  it("does not reuse a same-slug expert whose defining content differs (creates a distinct clone)", async () => {
    // A pre-existing library expert shares the base slug but has DIFFERENT
    // content, so dedup must NOT collapse it — a suffixed clone is created.
    await seedLibraryExpert(env, expertDef("alpha", { displayName: "Existing Alpha" }));

    const sessionName = await seedSession(env, {
      name: "auto-panel-2026-06-15T17:30:00",
      definition: autoDefinition(["alpha", "beta"]),
    });
    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await cmd.parseAsync(["node", "council-panel", "save", sessionName, "mypanel"]);

    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const expertRepo = new ExpertLibraryRepository(db);
      // The differing original is untouched; a distinct clone was created.
      const original = await expertRepo.findBySlug("alpha");
      expect(original?.displayName).toBe("Existing Alpha");
      expect(await expertRepo.findBySlug("alpha-2")).toBeDefined();
      expect([...(await new PanelLibraryRepository(db).getMembers("mypanel"))]).toEqual([
        "alpha-2",
        "beta",
      ]);
    } finally {
      await db.destroy();
    }
  });

  it("supports --latest to promote the most recent session", async () => {
    await seedSession(env, {
      name: "auto-panel-2026-06-15T14:00:00",
      definition: autoDefinition(["alpha", "beta"]),
    });
    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await cmd.parseAsync(["node", "council-panel", "save", "--latest", "latestpanel"]);

    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      expect(await new PanelLibraryRepository(db).findByName("latestpanel")).toBeDefined();
    } finally {
      await db.destroy();
    }
  });

  it("errors clearly when the session does not exist", async () => {
    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(["node", "council-panel", "save", "no-such-session", "foo"]),
    ).rejects.toBeInstanceOf(CliUserError);
  });

  it("errors clearly when the session predates the enabler (no stored definition)", async () => {
    const sessionName = await seedSession(env, {
      name: "legacy-2026-01-01T00:00:00",
      omitDefinition: true,
    });

    let stderr = "";
    const cmd = buildPanelCommand(
      () => undefined,
      (s) => {
        stderr += s;
      },
    );
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(["node", "council-panel", "save", sessionName, "foo"]),
    ).rejects.toBeInstanceOf(CliUserError);
    expect(stderr).toMatch(/no stored panel definition|does not have a saved panel|predates/i);
  });

  // 🔴 SENT-1062 #1 (Dim A1): the success-line echo of the session name must
  // be passed through stripControlChars, matching the convention already
  // applied to the auto-compose banner. A convened session name embeds the
  // AI-derived panel name, so it is untrusted at the terminal write sink.
  it("strips control chars from echoed session/panel names in save output", async () => {
    const evilName = "evil\u001b[31m\u0007-2026-06-15T16:00:00";
    const sessionName = await seedSession(env, {
      name: evilName,
      definition: autoDefinition(["alpha", "beta"]),
    });

    let stdout = "";
    const cmd = buildPanelCommand(
      (s) => {
        stdout += s;
      },
      () => undefined,
    );
    await cmd.parseAsync(["node", "council-panel", "save", sessionName, "goodpanel"]);

    expect(stdout).toContain("goodpanel");
    // Control sequences from the untrusted session name must be stripped.
    expect(stdout).not.toContain("\u001b[");
    expect(stdout).not.toContain("\u0007");
    // Printable characters are preserved.
    expect(stdout).toContain("evil");
  });

  // 🔴 SENT-1062 #4 (Dim A2/B): when persistence fails AFTER at least one
  // library expert was created, the experts created during THIS operation
  // must be rolled back — otherwise they are orphaned and a retry produces
  // -2/-3 duplicate suffixes.
  it("rolls back experts created in this operation when a later create fails (no orphans)", async () => {
    const sessionName = await seedSession(env, {
      name: "auto-panel-2026-06-15T15:00:00",
      definition: autoDefinition(["alpha", "beta"]),
    });

    // Fail the SECOND library.create so the first expert ("alpha") is left
    // created and the operation aborts mid-way through promotion.
    const realCreate = FileExpertLibrary.prototype.create;
    let createCalls = 0;
    const spy = vi.spyOn(FileExpertLibrary.prototype, "create").mockImplementation(async function (
      this: FileExpertLibrary,
      def: ExpertDefinition,
    ) {
      createCalls += 1;
      if (createCalls >= 2) {
        throw new Error("simulated persistence failure after first expert created");
      }
      await realCreate.call(this, def);
    });

    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    cmd.exitOverride();
    try {
      await expect(
        cmd.parseAsync(["node", "council-panel", "save", sessionName, "mypanel"]),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }

    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const lib = new FileExpertLibrary(env.dataHome, db);
      // The expert created during this failed save must NOT be orphaned.
      expect(await lib.get("alpha")).toBeNull();
      expect(await lib.get("beta")).toBeNull();
      // The panel itself was not persisted.
      expect(await new PanelLibraryRepository(db).findByName("mypanel")).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });

  // #1063 (Dim B): a corrupt (non-JSON / truncated) `config_json` must be
  // surfaced as invalid/corrupt, NOT mislabelled as a legacy session that
  // "predates the feature" (which maps to the `absent` branch).
  it("errors that a corrupt config_json is invalid/corrupt, not 'predates the feature' (#1063)", async () => {
    // Seed a session whose config_json is corrupt (non-JSON), as would happen
    // via truncation or a direct DB edit — bypassing the JSON.stringify path.
    const db = await createDatabase(path.join(env.home, "council.db"));
    let sessionName: string;
    try {
      const repo = new PanelRepository(db);
      const panel = await repo.create({
        name: "corrupt-2026-06-15T18:00:00",
        topic: "Should we adopt event sourcing?",
        copilotHome: path.join(env.home, "copilot"),
        configJson: "{ definition: <truncated",
      });
      sessionName = panel.name;
    } finally {
      await db.destroy();
    }

    let stderr = "";
    const cmd = buildPanelCommand(
      () => undefined,
      (s) => {
        stderr += s;
      },
    );
    cmd.exitOverride();
    const err = await cmd.parseAsync(["node", "council-panel", "save", sessionName, "foo"]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliUserError);
    expect((err as CliUserError).message).toMatch(/invalid stored panel definition/i);
    // Discriminating oracle: corrupt config surfaces an "invalid/corrupt"
    // diagnostic and NOT the misleading legacy "predates/no stored" message.
    expect(stderr).toMatch(/invalid or corrupt/i);
    expect(stderr).not.toMatch(/predates|no stored panel definition/i);
  });

  // #1114: the reuse path where the BASE slug is a DIFFERENT expert but an
  // EQUIVALENT clone exists at a SUFFIX (e.g. reuse `vc-2` while `vc` differs).
  it("reuses an equivalent clone at a non-base suffix (vc-2) when the base slug is a different expert (#1114)", async () => {
    // `vc` is occupied by a DIFFERENT expert; `vc-2` is an equivalent clone of
    // the session's `vc`. Saving must REUSE `vc-2`, not mint a fresh `vc-3`.
    await seedLibraryExpert(env, expertDef("vc", { displayName: "A different VC entirely" }));
    await seedLibraryExpert(env, { ...expertDef("vc"), slug: "vc-2" });

    const sessionName = await seedSession(env, {
      name: "auto-panel-2026-06-15T19:00:00",
      definition: autoDefinition(["vc"]),
    });

    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await cmd.parseAsync(["node", "council-panel", "save", sessionName, "mypanel"]);

    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const expertRepo = new ExpertLibraryRepository(db);
      // No fresh `vc-3` was created — the equivalent `vc-2` was reused.
      expect(await expertRepo.findBySlug("vc-3")).toBeUndefined();
      // The differing base `vc` is untouched.
      expect((await expertRepo.findBySlug("vc"))?.displayName).toBe("A different VC entirely");
      // Expert count is unchanged (still exactly `vc` + `vc-2`).
      expect((await expertRepo.findAll()).length).toBe(2);
      // The saved panel references the reused suffix clone.
      expect([...(await new PanelLibraryRepository(db).getMembers("mypanel"))]).toEqual(["vc-2"]);
    } finally {
      await db.destroy();
    }
  });

  // #1115: the KEY data-integrity invariant — a mid-save failure's rollback
  // deletes ONLY experts CREATED in this operation; a reused / pre-existing
  // expert must NEVER be deleted.
  it("rollback after a later failure deletes only newly-created experts, never a reused one (#1115)", async () => {
    // Pre-seed `alpha` IDENTICAL to the session's alpha so it is REUSED (not
    // created). `beta` is CREATED. A failure AFTER both are processed must
    // roll back only `beta`, leaving the reused `alpha` intact.
    await seedLibraryExpert(env, expertDef("alpha"));

    const sessionName = await seedSession(env, {
      name: "auto-panel-2026-06-15T20:00:00",
      definition: autoDefinition(["alpha", "beta"]),
    });

    // Fail the panel member-write (setMembers) — this runs AFTER both experts
    // are resolved and `beta` has been created, triggering the compensating
    // rollback of experts created in THIS operation.
    const spy = vi
      .spyOn(PanelLibraryRepository.prototype, "setMembers")
      .mockImplementationOnce(() =>
        Promise.reject(new Error("simulated persist failure after reuse+create")),
      );

    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    cmd.exitOverride();
    try {
      await expect(
        cmd.parseAsync(["node", "council-panel", "save", sessionName, "mypanel"]),
      ).rejects.toThrow(/simulated persist failure after reuse\+create/);
    } finally {
      spy.mockRestore();
    }

    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const lib = new FileExpertLibrary(env.dataHome, db);
      // The PRE-EXISTING / reused expert MUST survive the rollback.
      expect(await lib.get("alpha")).not.toBeNull();
      // The expert CREATED in this operation MUST be rolled back.
      expect(await lib.get("beta")).toBeNull();
      // No `alpha-2` duplicate was minted (alpha was reused, not re-cloned).
      expect(await lib.get("alpha-2")).toBeNull();
      // The panel itself was not persisted.
      expect(await new PanelLibraryRepository(db).findByName("mypanel")).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });
});
