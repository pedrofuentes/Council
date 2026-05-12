/**
 * Tests for `council panel` CLI commands (Roadmap 4.4).
 *
 * Mirrors the expert CLI test pattern: each subcommand is exercised
 * end-to-end through Commander, using an isolated COUNCIL_HOME +
 * COUNCIL_DATA_HOME so the user's real library is untouched. Interactive
 * prompts are bypassed via non-interactive flags.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
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

function makeExpert(slug: string, displayName: string, role: string): ExpertDefinition {
  return {
    slug,
    displayName,
    role,
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

describe("buildPanelCommand", () => {
  it("registers a 'panel' command with subcommands", () => {
    const cmd = buildPanelCommand();
    expect(cmd.name()).toBe("panel");
    const subs = cmd.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(["create", "edit", "inspect", "list"].sort());
  });

  describe("panel list", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("prints empty-state hint when no panels exist", async () => {
      let captured = "";
      const cmd = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panel", "list"]);
      expect(captured.toLowerCase()).toMatch(/no panels/);
      expect(captured.toLowerCase()).toMatch(/council panel create/);
    });

    it("lists created panels in table format", async () => {
      await seedExpert(env, makeExpert("cto", "Dahlia (CTO)", "CTO"));
      await seedExpert(env, makeExpert("staff", "Marcus (Staff)", "Staff Eng"));
      let captured = "";
      const cmd = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "arch-review",
        "--experts",
        "cto,staff",
        "--description",
        "Architecture review",
      ]);
      captured = "";
      await cmd.parseAsync(["node", "council-panel", "list"]);
      expect(captured).toContain("arch-review");
      expect(captured).toContain("cto");
      expect(captured).toContain("staff");
    });

    it("emits JSON when --format json", async () => {
      await seedExpert(env, makeExpert("cto", "Dahlia", "CTO"));
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await cmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "arch-review",
        "--experts",
        "cto",
      ]);
      let captured = "";
      const cmd2 = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd2.parseAsync(["node", "council-panel", "list", "--format", "json"]);
      const parsed = JSON.parse(captured) as readonly { readonly name: string }[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]?.name).toBe("arch-review");
    });
  });

  describe("panel create (non-interactive)", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("creates a panel YAML file from flags and writes DB rows", async () => {
      await seedExpert(env, makeExpert("cto", "Dahlia (CTO)", "CTO"));
      await seedExpert(env, makeExpert("staff", "Marcus", "Staff Eng"));

      let captured = "";
      const cmd = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "arch-review",
        "--experts",
        "cto,staff",
        "--mode",
        "freeform",
        "--max-rounds",
        "4",
        "--description",
        "Architecture review",
      ]);
      expect(captured).toMatch(/✓|created/);
      expect(captured).toContain("arch-review");
      expect(captured).toContain("2");

      const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
      const content = await fs.readFile(yamlPath, "utf-8");
      expect(content).toContain("name: arch-review");
      expect(content).toContain("Architecture review");
      expect(content).toMatch(/- cto/);
      expect(content).toMatch(/- staff/);
      expect(content).toMatch(/mode: freeform/);
      expect(content).toMatch(/maxRounds: 4/);

      // DB rows
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const row = await db
          .selectFrom("panel_library")
          .selectAll()
          .where("name", "=", "arch-review")
          .executeTakeFirst();
        expect(row?.name).toBe("arch-review");
        expect(row?.description).toBe("Architecture review");

        const members = await db
          .selectFrom("panel_members")
          .selectAll()
          .where("panel_name", "=", "arch-review")
          .orderBy("position", "asc")
          .execute();
        expect(members.map((m) => m.expert_slug)).toEqual(["cto", "staff"]);
      } finally {
        await db.destroy();
      }
    });

    it("rejects when expert library is empty", async () => {
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
        cmd.parseAsync([
          "node",
          "council-panel",
          "create",
          "arch-review",
          "--experts",
          "cto",
        ]),
      ).rejects.toThrow();
      expect(errored.toLowerCase()).toMatch(/no experts|expert.*not found|create experts first/i);
    });

    it("rejects unknown expert slugs", async () => {
      await seedExpert(env, makeExpert("cto", "Dahlia", "CTO"));
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
        cmd.parseAsync([
          "node",
          "council-panel",
          "create",
          "arch-review",
          "--experts",
          "cto,ghost",
        ]),
      ).rejects.toThrow(/ghost|not found/i);
      expect(errored.toLowerCase()).toMatch(/ghost|not found/);
    });

    it("rejects duplicate panel names", async () => {
      await seedExpert(env, makeExpert("cto", "Dahlia", "CTO"));
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await cmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "arch-review",
        "--experts",
        "cto",
      ]);
      let errored = "";
      const cmd2 = buildPanelCommand(
        () => {
          /* noop */
        },
        (s) => {
          errored += s;
        },
      );
      await expect(
        cmd2.parseAsync([
          "node",
          "council-panel",
          "create",
          "arch-review",
          "--experts",
          "cto",
        ]),
      ).rejects.toThrow(/already exists/i);
      expect(errored).toMatch(/already exists/i);
    });

    it("rejects invalid panel name (not kebab-case)", async () => {
      await seedExpert(env, makeExpert("cto", "Dahlia", "CTO"));
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await expect(
        cmd.parseAsync([
          "node",
          "council-panel",
          "create",
          "Bad Name!",
          "--experts",
          "cto",
        ]),
      ).rejects.toThrow(/name|invalid/i);
    });
  });

  describe("panel inspect", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("shows formatted detail for a created panel", async () => {
      await seedExpert(env, makeExpert("cto", "Dahlia Renner", "CTO"));
      await seedExpert(env, makeExpert("staff", "Marcus Chen", "Staff Engineer"));
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await cmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "arch-review",
        "--experts",
        "cto,staff",
        "--description",
        "Architecture review",
      ]);

      let captured = "";
      const cmd2 = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd2.parseAsync(["node", "council-panel", "inspect", "arch-review"]);
      expect(captured).toContain("Panel: arch-review");
      expect(captured).toContain("Architecture review");
      expect(captured).toContain("freeform");
      expect(captured).toContain("cto");
      expect(captured).toContain("Dahlia Renner");
      expect(captured).toContain("staff");
      expect(captured).toContain("Marcus Chen");
    });

    it("reports not found", async () => {
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
        cmd.parseAsync(["node", "council-panel", "inspect", "ghost"]),
      ).rejects.toThrow(/not found/i);
      expect(errored).toMatch(/not found/i);
    });
  });

  describe("panel edit", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("re-validates panel YAML after editor exits", async () => {
      await seedExpert(env, makeExpert("cto", "Dahlia", "CTO"));
      await seedExpert(env, makeExpert("staff", "Marcus", "Staff"));
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await cmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "arch-review",
        "--experts",
        "cto",
      ]);

      // Use a no-op editor (true on unix, cmd /c exit 0 on windows). We simulate
      // an external edit by overwriting the file before invoking edit.
      const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
      await fs.writeFile(
        yamlPath,
        `name: arch-review\ndescription: Updated\nexperts:\n  - cto\n  - staff\n`,
        "utf-8",
      );

      const originalEditor = process.env["EDITOR"];
      const originalVisual = process.env["VISUAL"];
      process.env["EDITOR"] = process.platform === "win32" ? "cmd /c exit 0" : "true";
      delete process.env["VISUAL"];
      try {
        let captured = "";
        const cmd2 = buildPanelCommand((s) => {
          captured += s;
        });
        await cmd2.parseAsync(["node", "council-panel", "edit", "arch-review"]);
        expect(captured).toMatch(/saved|validated/i);

        // DB membership should now reflect both experts.
        const { createDatabase } = await import("../../../../src/memory/db.js");
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          const members = await db
            .selectFrom("panel_members")
            .selectAll()
            .where("panel_name", "=", "arch-review")
            .orderBy("position", "asc")
            .execute();
          expect(members.map((m) => m.expert_slug)).toEqual(["cto", "staff"]);
        } finally {
          await db.destroy();
        }
      } finally {
        if (originalEditor === undefined) delete process.env["EDITOR"];
        else process.env["EDITOR"] = originalEditor;
        if (originalVisual !== undefined) process.env["VISUAL"] = originalVisual;
      }
    });

    it("reports not found", async () => {
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
        cmd.parseAsync(["node", "council-panel", "edit", "ghost"]),
      ).rejects.toThrow(/not found/i);
      expect(errored).toMatch(/not found/i);
    });

    it("operates on a .yml panel in place instead of shadowing it with .yaml", async () => {
      await seedExpert(env, makeExpert("cto", "Dahlia", "CTO"));
      // First create the panel via the CLI (writes .yaml + registers in DB),
      // then rename to .yml on disk to simulate a hand-authored panel file.
      const createCmd = buildPanelCommand(() => {
        /* noop */
      });
      await createCmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "ymlpanel",
        "--experts",
        "cto",
      ]);
      const yamlPath = path.join(env.dataHome, "panels", "ymlpanel.yaml");
      const ymlPath = path.join(env.dataHome, "panels", "ymlpanel.yml");
      await fs.rename(yamlPath, ymlPath);

      const originalEditor = process.env["EDITOR"];
      const originalVisual = process.env["VISUAL"];
      process.env["EDITOR"] = process.platform === "win32" ? "cmd /c exit 0" : "true";
      delete process.env["VISUAL"];
      try {
        const cmd = buildPanelCommand(() => {
          /* noop */
        });
        await cmd.parseAsync(["node", "council-panel", "edit", "ymlpanel"]);
        // .yaml must NOT be re-created — the on-disk .yml file is the source of truth.
        await expect(fs.access(yamlPath)).rejects.toThrow();
        // The .yml file must still be there.
        await fs.access(ymlPath);
      } finally {
        if (originalEditor === undefined) delete process.env["EDITOR"];
        else process.env["EDITOR"] = originalEditor;
        if (originalVisual !== undefined) process.env["VISUAL"] = originalVisual;
      }
    });

    it("inspect resolves a .yml panel in place", async () => {
      await seedExpert(env, makeExpert("cto", "Dahlia Renner", "CTO"));
      const createCmd = buildPanelCommand(() => {
        /* noop */
      });
      await createCmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "ymlinspect",
        "--experts",
        "cto",
      ]);
      const yamlPath = path.join(env.dataHome, "panels", "ymlinspect.yaml");
      const ymlPath = path.join(env.dataHome, "panels", "ymlinspect.yml");
      await fs.rename(yamlPath, ymlPath);

      let captured = "";
      const cmd = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panel", "inspect", "ymlinspect"]);
      expect(captured).toContain("ymlinspect.yml");
      expect(captured).not.toMatch(/ymlinspect\.yaml(?!l)/);
    });

    it("inspect surfaces YAML parse errors instead of masking them as 'not found'", async () => {
      const broken = path.join(env.dataHome, "panels", "broken.yaml");
      await fs.mkdir(path.dirname(broken), { recursive: true });
      // Schema-invalid: missing required `experts`.
      await fs.writeFile(broken, `name: broken\ndescription: oops\n`, "utf-8");
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
        cmd.parseAsync(["node", "council-panel", "inspect", "broken"]),
      ).rejects.toThrow();
      // Must NOT report as "not found" — the YAML exists, it's just invalid.
      const combined = errored.toLowerCase();
      expect(combined).not.toMatch(/not found/);
    });
  });

  describe("panel create — rollback on partial failure", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("unlinks the YAML file when DB membership write fails after the file write", async () => {
      await seedExpert(env, makeExpert("cto", "Dahlia", "CTO"));

      // Force setMembers to fail AFTER the YAML has already been written, so
      // the create command's catch block must clean up the partial state.
      const repoMod = await import(
        "../../../../src/memory/repositories/panel-library-repo.js"
      );
      const { vi } = await import("vitest");
      const spy = vi
        .spyOn(repoMod.PanelLibraryRepository.prototype, "setMembers")
        .mockRejectedValueOnce(new Error("simulated setMembers failure"));

      try {
        const cmd = buildPanelCommand(() => {
          /* noop */
        });
        await expect(
          cmd.parseAsync([
            "node",
            "council-panel",
            "create",
            "rollback-test",
            "--experts",
            "cto",
          ]),
        ).rejects.toThrow(/simulated setMembers failure/);

        // The YAML must have been cleaned up by the rollback.
        const yamlPath = path.join(
          env.dataHome,
          "panels",
          "rollback-test.yaml",
        );
        await expect(fs.access(yamlPath)).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
