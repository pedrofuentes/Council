/**
 * Tests for `council panel delete` (T2) and the related expert-delete
 * cascade warning. Covers:
 *   - panel delete with --yes removes YAML, docs dir, and DB row
 *   - panel delete keeps hidden --force backward compatibility
 *   - panel delete prompts for confirmation by default
 *   - panel delete aborts when confirmation is declined
 *   - panel delete errors on unknown panel name
 *   - expert delete --force --yes warns when a panel is left empty
 */
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Passive fs spy: record every rm/unlink call (delegating to the real impl) so
// the invalid-name test can prove a rejected path-traversal name never reaches
// a destructive filesystem call. #757.
const fsCalls = vi.hoisted(() => ({ rm: [] as unknown[][], unlink: [] as unknown[][] }));

import type FsPromisesModule from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>();
  return {
    ...actual,
    rm: ((...args: unknown[]) => {
      fsCalls.rm.push(args);
      return (actual.rm as (...a: unknown[]) => Promise<void>)(...args);
    }) as typeof actual.rm,
    unlink: ((...args: unknown[]) => {
      fsCalls.unlink.push(args);
      return (actual.unlink as (...a: unknown[]) => Promise<void>)(...args);
    }) as typeof actual.unlink,
  };
});

import * as fs from "node:fs/promises";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { buildExpertCommand } from "../../../../src/cli/commands/expert.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-del-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-del-data-"));
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
  const { createDatabase } = await import("../../../../src/memory/db.js");
  const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

async function createPanel(env: TestEnv, name: string, experts: readonly string[]): Promise<void> {
  const cmd = buildPanelCommand(() => {
    /* noop */
  });
  await cmd.parseAsync([
    "node",
    "council-panel",
    "create",
    name,
    "--experts",
    experts.join(","),
    "--mode",
    "freeform",
  ]);
}

describe("buildPanelCommand: delete subcommand (T2)", () => {
  it("registers a `delete` subcommand", () => {
    const cmd = buildPanelCommand();
    const subs = cmd.commands.map((c) => c.name()).sort();
    expect(subs).toContain("delete");
  });

  it("documents --yes and hides the legacy --force alias in help", () => {
    const del = buildPanelCommand().commands.find((command) => command.name() === "delete");
    const help = del?.helpInformation() ?? "";

    expect(help).toMatch(/--yes/);
    expect(help).not.toMatch(/--force/);
  });

  it("help text clarifies that debate sessions are preserved, not removed (F08)", () => {
    const del = buildPanelCommand().commands.find((command) => command.name() === "delete");
    const help = del?.helpInformation() ?? "";

    // Must mention sessions being kept — not just "DB rows" (which implies all data gone).
    expect(help).toMatch(/session/i);
    expect(help).toMatch(/preserved|kept|remain/i);
  });

  describe("panel delete behavior", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("with --yes removes the YAML, docs directory, and DB rows", async () => {
      await seedExpert(env, expertDef("cto"));
      await createPanel(env, "arch-review", ["cto"]);
      const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
      const docsDir = path.join(env.dataHome, "panels", "arch-review", "docs");
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(path.join(docsDir, "note.md"), "# note", "utf-8");
      await expect(fs.access(yamlPath)).resolves.toBeUndefined();

      let captured = "";
      const cmd = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panel", "delete", "arch-review", "--yes"]);

      expect(captured).toMatch(/deleted/i);
      await expect(fs.access(yamlPath)).rejects.toThrow();
      await expect(fs.access(docsDir)).rejects.toThrow();

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelLibraryRepository } =
        await import("../../../../src/memory/repositories/panel-library-repo.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new PanelLibraryRepository(db);
        expect(await repo.findByName("arch-review")).toBeUndefined();
        expect(await repo.getMembers("arch-review")).toEqual([]);
      } finally {
        await db.destroy();
      }
    });

    it("errors when the panel does not exist", async () => {
      let errored = "";
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        (s) => {
          errored += s;
        },
      );
      await expect(
        cmd.parseAsync(["node", "council-panel", "delete", "missing-panel", "--yes"]),
      ).rejects.toThrow(/not found/i);
      expect(errored).toMatch(/not found/i);
    });

    it("aborts when the confirmation prompt is declined", async () => {
      await seedExpert(env, expertDef("cto"));
      await createPanel(env, "keep-me", ["cto"]);

      let errored = "";
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        (s) => {
          errored += s;
        },
        { confirm: async () => false },
      );
      await expect(cmd.parseAsync(["node", "council-panel", "delete", "keep-me"])).rejects.toThrow(
        /abort|not deleted|cancel/i,
      );
      expect(errored).toMatch(/abort|not deleted|cancel/i);

      const yamlPath = path.join(env.dataHome, "panels", "keep-me.yaml");
      await expect(fs.access(yamlPath)).resolves.toBeUndefined();

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelLibraryRepository } =
        await import("../../../../src/memory/repositories/panel-library-repo.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new PanelLibraryRepository(db);
        expect(await repo.findByName("keep-me")).toBeDefined();
      } finally {
        await db.destroy();
      }
    });

    it("proceeds when the confirmation prompt is accepted", async () => {
      await seedExpert(env, expertDef("cto"));
      await createPanel(env, "say-yes", ["cto"]);

      let captured = "";
      let confirmMessage = "";
      const cmd = buildPanelCommand(
        (s) => {
          captured += s;
        },
        () => {
          /* noop */
        },
        {
          confirm: async (msg) => {
            confirmMessage = msg;
            return true;
          },
        },
      );
      await cmd.parseAsync(["node", "council-panel", "delete", "say-yes"]);

      expect(confirmMessage).toMatch(/say-yes/);
      expect(confirmMessage).toMatch(/cannot be undone/i);
      expect(captured).toMatch(/deleted/i);
      const yamlPath = path.join(env.dataHome, "panels", "say-yes.yaml");
      await expect(fs.access(yamlPath)).rejects.toThrow();
    });

    it("--yes skips the confirmation prompt entirely", async () => {
      await seedExpert(env, expertDef("cto"));
      await createPanel(env, "no-prompt", ["cto"]);

      let confirmCalled = false;
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        () => {
          /* noop */
        },
        {
          confirm: async () => {
            confirmCalled = true;
            return false;
          },
        },
      );
      await cmd.parseAsync(["node", "council-panel", "delete", "no-prompt", "--yes"]);
      expect(confirmCalled).toBe(false);
      const yamlPath = path.join(env.dataHome, "panels", "no-prompt.yaml");
      await expect(fs.access(yamlPath)).rejects.toThrow();
    });

    it("keeps --force as a hidden alias for skipping confirmation", async () => {
      await seedExpert(env, expertDef("cto"));
      await createPanel(env, "legacy-force", ["cto"]);

      let confirmCalled = false;
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        () => {
          /* noop */
        },
        {
          confirm: async () => {
            confirmCalled = true;
            return false;
          },
        },
      );
      await cmd.parseAsync(["node", "council-panel", "delete", "legacy-force", "--force"]);
      expect(confirmCalled).toBe(false);
      const yamlPath = path.join(env.dataHome, "panels", "legacy-force.yaml");
      await expect(fs.access(yamlPath)).rejects.toThrow();
    });

    it("rejects panel names that fail kebab-case validation (defense in depth)", async () => {
      let errored = "";
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        (s) => {
          errored += s;
        },
      );
      // `..` would be catastrophic if it reached fs.rm; validatePanelName
      // must catch it before any DB or FS work.
      await expect(
        cmd.parseAsync(["node", "council-panel", "delete", "../etc", "--yes"]),
      ).rejects.toThrow(/kebab|invalid/i);
      // Bonus: name with a path separator must also be rejected.
      await expect(
        cmd.parseAsync(["node", "council-panel", "delete", "foo/bar", "--yes"]),
      ).rejects.toThrow(/kebab|invalid/i);
      // The errors do NOT need to come from writeError — Commander may
      // surface them directly — but they MUST never trigger a delete.
      void errored;
    });

    it("touches no DB row, on-disk YAML, or out-of-tree path when the name fails validation (#757)", async () => {
      // Threat model: a `panel_library` row whose name bypassed PANEL_NAME_RE
      // (via a migration/import/direct DB edit) must never let `panel delete`
      // drive a path-traversal name into fs.rm/fs.unlink. Seed such a row plus
      // a sentinel YAML at the location the traversal name resolves to OUTSIDE
      // panels/ — panelYamlPath(dataHome, "../etc") => <dataHome>/etc.yaml.
      const badName = "../etc";
      const now = new Date().toISOString();
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelLibraryRepository } = await import(
        "../../../../src/memory/repositories/panel-library-repo.js"
      );
      {
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          await db
            .insertInto("panel_library")
            .values({
              name: badName,
              description: null,
              yaml_path: `${badName}.yaml`,
              yaml_checksum: "x",
              created_at: now,
              updated_at: now,
            })
            .execute();
        } finally {
          await db.destroy();
        }
      }
      const escapeYaml = path.join(env.dataHome, "etc.yaml");
      await fs.writeFile(escapeYaml, "sentinel — must survive", "utf-8");

      fsCalls.rm.length = 0;
      fsCalls.unlink.length = 0;

      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        () => {
          /* noop */
        },
      );
      await expect(
        cmd.parseAsync(["node", "council-panel", "delete", badName, "--yes"]),
      ).rejects.toThrow(/kebab|invalid/i);

      // (c) No destructive filesystem call ran for the rejected name — assert
      //     BEFORE any further DB/FS work in this test can add records.
      expect(fsCalls.rm).toEqual([]);
      expect(fsCalls.unlink).toEqual([]);

      // (a) The seeded row is still present — the delete never reached the DB.
      {
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new PanelLibraryRepository(db);
          await expect(repo.findByName(badName)).resolves.toMatchObject({ name: badName });
        } finally {
          await db.destroy();
        }
      }
      // (b) The out-of-tree YAML the traversal name would resolve to is untouched.
      await expect(fs.access(escapeYaml)).resolves.toBeUndefined();
    });

    it("tolerates a missing YAML on disk and still removes the DB row", async () => {
      await seedExpert(env, expertDef("cto"));
      await createPanel(env, "half-cleaned", ["cto"]);
      const yamlPath = path.join(env.dataHome, "panels", "half-cleaned.yaml");
      await fs.unlink(yamlPath); // simulate prior partial cleanup

      let captured = "";
      const cmd = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panel", "delete", "half-cleaned", "--yes"]);
      expect(captured).toMatch(/deleted/i);

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelLibraryRepository } =
        await import("../../../../src/memory/repositories/panel-library-repo.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new PanelLibraryRepository(db);
        expect(await repo.findByName("half-cleaned")).toBeUndefined();
      } finally {
        await db.destroy();
      }
    });

    it("surfaces a non-ENOENT unlink failure and preserves the DB row for retry", async () => {
      await seedExpert(env, expertDef("cto"));
      await createPanel(env, "busy-yaml", ["cto"]);

      // Replace the YAML file with a directory of the same name. Both
      // POSIX (EISDIR) and Windows (EPERM) will reject fs.unlink on a
      // directory — a portable non-ENOENT failure that exercises the
      // error branch without ESM-incompatible vi.spyOn on node:fs.
      const yamlPath = path.join(env.dataHome, "panels", "busy-yaml.yaml");
      await fs.unlink(yamlPath);
      await fs.mkdir(yamlPath);

      let errored = "";
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        (s) => {
          errored += s;
        },
      );
      await expect(
        cmd.parseAsync(["node", "council-panel", "delete", "busy-yaml", "--yes"]),
      ).rejects.toThrow(/EISDIR|EPERM|illegal|directory|permitted/i);
      expect(errored).toMatch(/busy-yaml\.yaml/);
      expect(errored).toMatch(/DB rows preserved/i);

      // DB row must still be present so the user can retry after
      // clearing the obstructing directory.
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelLibraryRepository } =
        await import("../../../../src/memory/repositories/panel-library-repo.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new PanelLibraryRepository(db);
        expect(await repo.findByName("busy-yaml")).toBeDefined();
      } finally {
        await db.destroy();
      }

      // Cleanup the obstructing directory before teardown.
      await fs.rm(yamlPath, { recursive: true, force: true });
    });

    it("surfaces a non-ENOENT fs.rm failure on the docs dir and preserves the DB row for retry (#758)", async () => {
      // POSIX-only: make the panel directory un-removable by removing its
      // write bit so `fs.rm(panelDir, {recursive, force})` cannot unlink the
      // `docs` child (EACCES). `force:true` tolerates ENOENT but NOT EACCES,
      // so this exercises the distinct fs.rm catch branch (different message,
      // different partial-cleanup state) without ESM-blocked vi.spyOn on
      // node:fs. Windows chmod semantics differ and root bypasses perms.
      if (process.platform === "win32" || process.getuid?.() === 0) return;

      await seedExpert(env, expertDef("cto"));
      await createPanel(env, "locked-docs", ["cto"]);

      const panelDir = path.join(env.dataHome, "panels", "locked-docs");
      // A child must exist so removing the dir requires unlinking it.
      await fs.mkdir(path.join(panelDir, "docs"), { recursive: true });
      await fs.writeFile(path.join(panelDir, "docs", "keep.md"), "x", "utf-8");
      await fs.chmod(panelDir, 0o500);

      let errored = "";
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        (s) => {
          errored += s;
        },
      );
      try {
        // The YAML (a sibling of panelDir) unlinks fine; only the docs-dir
        // removal fails, so the fs.rm branch — not the unlink branch — runs.
        await expect(
          cmd.parseAsync(["node", "council-panel", "delete", "locked-docs", "--yes"]),
        ).rejects.toThrow(/EACCES|EPERM|permission/i);
        // Distinct fs.rm branch: "failed to clean up" (not "Failed to delete
        // YAML"), and the DB row is preserved with retry guidance.
        expect(errored).toMatch(/failed to clean up/i);
        expect(errored).toMatch(/locked-docs/);
        expect(errored).toMatch(/DB rows preserved/i);
        // The YAML unlink already succeeded before the fs.rm failure.
        await expect(
          fs.access(path.join(env.dataHome, "panels", "locked-docs.yaml")),
        ).rejects.toThrow();

        // DB row must still be present so the operator can retry after fixing.
        const { createDatabase } = await import("../../../../src/memory/db.js");
        const { PanelLibraryRepository } =
          await import("../../../../src/memory/repositories/panel-library-repo.js");
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new PanelLibraryRepository(db);
          expect(await repo.findByName("locked-docs")).toBeDefined();
        } finally {
          await db.destroy();
        }
      } finally {
        // Restore perms so teardown can clean up.
        await fs.chmod(panelDir, 0o700);
      }
    });

    it("preserves the CliUserError exit code when db cleanup (destroy) also fails (#1825)", async () => {
      // When the command callback throws a CliUserError (exit 1) AND db.destroy
      // also fails, the failures must NOT collapse into a bare AggregateError
      // that handleCliError maps to EXIT_INTERNAL_ERROR (4). The primary user
      // error's exit code must survive while both errors remain reachable.
      const { vi } = await import("vitest");
      const { Kysely } = await import("kysely");
      const { CliUserError } = await import("../../../../src/cli/cli-user-error.js");
      const { handleCliError } = await import("../../../../src/cli/handle-cli-error.js");

      const destroySpy = vi
        .spyOn(Kysely.prototype, "destroy")
        .mockImplementationOnce(() => Promise.reject(new Error("simulated destroy failure")));

      let errored = "";
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        (s) => {
          errored += s;
        },
      );
      try {
        // "ghost" does not exist → the callback throws a CliUserError; the
        // withPanelContext cleanup then hits the mocked destroy failure.
        const err = await cmd
          .parseAsync(["node", "council-panel", "delete", "ghost", "--yes"])
          .then(
            () => null,
            (e: unknown) => e,
          );
        // The user-facing "not found" diagnostic was still surfaced.
        expect(errored).toMatch(/not found/i);
        // Primary error type/exit code preserved (not masked by cleanup).
        expect(err).toBeInstanceOf(CliUserError);
        expect(handleCliError(err, () => undefined)).toBe(1);
        // Both failures remain reachable via the cause chain.
        const cause = (err as CliUserError).cause;
        expect(cause).toBeInstanceOf(AggregateError);
        const messages = (cause as AggregateError).errors.map((e) =>
          e instanceof Error ? e.message : String(e),
        );
        expect(messages.some((m) => m.includes("simulated destroy failure"))).toBe(true);
        expect(messages.some((m) => /not found/i.test(m))).toBe(true);
      } finally {
        destroySpy.mockRestore();
      }
    });

    it("warns (does not silently swallow) when counting past debate sessions fails (#1825)", async () => {
      await seedExpert(env, expertDef("cto"));
      await createPanel(env, "count-fails", ["cto"]);

      const { vi } = await import("vitest");
      const { PanelRepository } = await import("../../../../src/memory/repositories/panels.js");
      const spy = vi
        .spyOn(PanelRepository.prototype, "findByNamePrefix")
        .mockImplementationOnce(() =>
          Promise.reject(new Error("simulated debate-count read failure")),
        );

      let errored = "";
      // Decline the prompt so the delete aborts AFTER the (failing) count read.
      const declineProvider = { confirm: (): Promise<boolean> => Promise.resolve(false) };
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        (s) => {
          errored += s;
        },
        declineProvider,
      );
      try {
        // No --yes: the interactive path runs the debate-count read (fails).
        await expect(
          cmd.parseAsync(["node", "council-panel", "delete", "count-fails"]),
        ).rejects.toThrow();
        // #1825: the transient/non-transient read failure is surfaced, not
        // silently swallowed to a bare debateCount = 0.
        expect(errored).toMatch(/could not count past debate sessions/i);
        expect(errored).toMatch(/simulated debate-count read failure/);
        // The delete still degrades gracefully (prompt shown, then declined).
        expect(errored).toMatch(/Aborted: panel "count-fails" not deleted/);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("expert delete cascade warning (T2)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("warns when --force leaves a panel with zero members", async () => {
    await seedExpert(env, expertDef("only-member"));
    await createPanel(env, "solo-panel", ["only-member"]);

    let captured = "";
    const cmd = buildExpertCommand((s) => {
      captured += s;
    });
    await cmd.parseAsync(["node", "council-expert", "delete", "only-member", "--force", "--yes"]);

    // Lock the full contract: panel name + "0 members" + "may not
    // function" + remediation hint with the exact panel name.
    expect(captured).toMatch(/solo-panel/);
    expect(captured).toMatch(/0 members/);
    expect(captured).toMatch(/may not function/i);
    expect(captured).toMatch(/council panel delete solo-panel/);
  });

  it("does not warn when removing one of several members", async () => {
    await seedExpert(env, expertDef("alpha"));
    await seedExpert(env, expertDef("beta"));
    await createPanel(env, "duo-panel", ["alpha", "beta"]);

    let captured = "";
    const cmd = buildExpertCommand((s) => {
      captured += s;
    });
    await cmd.parseAsync(["node", "council-expert", "delete", "alpha", "--force", "--yes"]);

    expect(captured).not.toMatch(/0 members/);
    expect(captured).not.toMatch(/may not function/i);
    expect(captured).not.toMatch(/council panel delete/);
  });
});
