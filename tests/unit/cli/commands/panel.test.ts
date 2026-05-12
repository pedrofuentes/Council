/**
 * Tests for `council panel` CLI commands (Roadmap 4.4).
 *
 * Each subcommand is exercised end-to-end through its Commander action,
 * using an isolated COUNCIL_HOME + COUNCIL_DATA_HOME. Interactive prompts
 * are bypassed using non-interactive flags (`--experts`, `--mode`,
 * `--max-rounds`, `--description`).
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

describe("buildPanelCommand", () => {
  it("registers a 'panel' command with subcommands", () => {
    const cmd = buildPanelCommand();
    expect(cmd.name()).toBe("panel");
    const subs = cmd.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(["create", "edit", "inspect", "list"].sort());
  });

  describe("panel create (non-interactive)", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("creates a panel from flags referencing library experts by slug", async () => {
      await seedExpert(env, expertDef("cto"));
      await seedExpert(env, expertDef("staff"));

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
        "Multi-perspective review",
      ]);
      expect(captured).toMatch(/✓|created/i);
      expect(captured).toContain("arch-review");

      const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
      const content = await fs.readFile(yamlPath, "utf-8");
      expect(content).toContain("name: arch-review");
      expect(content).toContain("Multi-perspective review");
      expect(content).toContain("- cto");
      expect(content).toContain("- staff");
      expect(content).toContain("freeform");
      expect(content).toMatch(/maxRounds: 4/);

      // DB records present.
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelLibraryRepository } =
        await import("../../../../src/memory/repositories/panel-library-repo.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new PanelLibraryRepository(db);
        const row = await repo.findByName("arch-review");
        expect(row?.name).toBe("arch-review");
        const members = await repo.getMembers("arch-review");
        expect(members).toEqual(["cto", "staff"]);
      } finally {
        await db.destroy();
      }
    });

    it("rejects invalid (non-kebab-case) panel names", async () => {
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await expect(
        cmd.parseAsync(["node", "council-panel", "create", "Bad Name!", "--experts", "cto"]),
      ).rejects.toThrow(/name|kebab/i);
    });

    it("rejects duplicate panel name", async () => {
      await seedExpert(env, expertDef("cto"));
      const cmd1 = buildPanelCommand(() => {
        /* noop */
      });
      await cmd1.parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"]);

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
        cmd2.parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"]),
      ).rejects.toThrow(/already exists/i);
      expect(errored).toMatch(/already exists/i);
    });

    it("rejects empty expert list", async () => {
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await expect(
        cmd.parseAsync(["node", "council-panel", "create", "arch-review", "--experts", ""]),
      ).rejects.toThrow(/expert/i);
    });

    it("rejects unknown expert slugs with a helpful message", async () => {
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
        cmd.parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "ghost"]),
      ).rejects.toThrow(/ghost|not found|unknown/i);
      expect(errored).toMatch(/ghost|not found|unknown/i);
    });

    it("rejects unknown --mode value", async () => {
      await seedExpert(env, expertDef("cto"));
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await expect(
        cmd.parseAsync([
          "node",
          "council-panel",
          "create",
          "arch-review",
          "--experts",
          "cto",
          "--mode",
          "bogus",
        ]),
      ).rejects.toThrow(/mode/i);
    });
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
      expect(captured.toLowerCase()).toMatch(/no panels|council panel create/);
    });

    it("lists user panels in table format", async () => {
      await seedExpert(env, expertDef("cto"));
      await seedExpert(env, expertDef("staff"));
      const createCmd = buildPanelCommand(() => {
        /* noop */
      });
      await createCmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "arch-review",
        "--experts",
        "cto,staff",
        "--description",
        "Architecture deliberation across CTO and Staff Engineer perspectives",
      ]);

      let captured = "";
      const cmd = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panel", "list"]);
      expect(captured).toContain("arch-review");
      expect(captured).toContain("2");
      expect(captured).toMatch(/Architecture/);
    });

    it("emits JSON when --format json", async () => {
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

      let captured = "";
      const cmd = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panel", "list", "--format", "json"]);
      const parsed = JSON.parse(captured) as readonly { readonly name: string }[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]?.name).toBe("arch-review");
    });

    it("rejects unknown --format value", async () => {
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await expect(
        cmd.parseAsync(["node", "council-panel", "list", "--format", "xml"]),
      ).rejects.toThrow(/format/i);
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

    it("shows panel definition with member details", async () => {
      await seedExpert(env, expertDef("cto"));
      await seedExpert(env, expertDef("staff"));
      const createCmd = buildPanelCommand(() => {
        /* noop */
      });
      await createCmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "arch-review",
        "--experts",
        "cto,staff",
        "--description",
        "Architecture deliberation",
      ]);

      let captured = "";
      const cmd = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panel", "inspect", "arch-review"]);
      expect(captured).toContain("arch-review");
      expect(captured).toContain("Architecture deliberation");
      expect(captured).toContain("cto");
      expect(captured).toContain("staff");
      expect(captured).toContain("generic");
      // file path should appear
      expect(captured).toMatch(/arch-review\.yaml/);
    });

    it("reports not found for unknown panel", async () => {
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
        cmd.parseAsync(["node", "council-panel", "inspect", "ghost-panel"]),
      ).rejects.toThrow(/not found/i);
      expect(errored).toMatch(/not found|ghost-panel/i);
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

    it("reports not found when panel is missing", async () => {
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await expect(cmd.parseAsync(["node", "council-panel", "edit", "ghost"])).rejects.toThrow(
        /not found/i,
      );
    });

    it("invokes the configured editor and re-validates on save (no-op edit)", async () => {
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

      const originalEditor = process.env["EDITOR"];
      process.env["EDITOR"] = `node -e ""`;
      try {
        let captured = "";
        const cmd = buildPanelCommand((s) => {
          captured += s;
        });
        await cmd.parseAsync(["node", "council-panel", "edit", "arch-review"]);
        expect(captured.toLowerCase()).toMatch(/saved|validated|✓|ok/);
      } finally {
        if (originalEditor === undefined) delete process.env["EDITOR"];
        else process.env["EDITOR"] = originalEditor;
      }
    });

    it("persists a checksum that matches the validated on-disk YAML", async () => {
      await seedExpert(env, expertDef("cto"));
      await seedExpert(env, expertDef("staff"));
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

      // Stub editor: deterministically rewrite the YAML so the checksum after
      // edit MUST differ from the pre-edit checksum. The regression we're
      // guarding against is a TOCTOU read where the checksum reflects a
      // different read than the validated parse.
      const stubPath = path.join(env.home, "panel-edit-rewrite.cjs");
      await fs.writeFile(
        stubPath,
        `const fs = require('fs');
const p = process.argv[2];
fs.writeFileSync(p, 'name: arch-review\\ndescription: After edit\\nexperts:\\n  - cto\\n  - staff\\n', 'utf-8');`,
        "utf-8",
      );
      const originalEditor = process.env["EDITOR"];
      process.env["EDITOR"] = `node "${stubPath}"`;
      try {
        const cmd = buildPanelCommand(() => {
          /* noop */
        });
        await cmd.parseAsync(["node", "council-panel", "edit", "arch-review"]);
      } finally {
        if (originalEditor === undefined) delete process.env["EDITOR"];
        else process.env["EDITOR"] = originalEditor;
      }

      const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
      const onDisk = await fs.readFile(yamlPath, "utf-8");
      const { createHash } = await import("node:crypto");
      const expected = createHash("sha256").update(onDisk).digest("hex");

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelLibraryRepository } = await import(
        "../../../../src/memory/repositories/panel-library-repo.js"
      );
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new PanelLibraryRepository(db);
        const row = await repo.findByName("arch-review");
        expect(row?.yamlChecksum).toBe(expected);
        const members = await repo.getMembers("arch-review");
        expect(members).toEqual(["cto", "staff"]);
      } finally {
        await db.destroy();
      }
    });

    it("prints validation errors when the edited YAML has an invalid schema", async () => {
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

      // Stub editor: corrupt the YAML by removing the required `experts:` list.
      const stubPath = path.join(env.home, "panel-edit-bad.cjs");
      await fs.writeFile(
        stubPath,
        `const fs = require('fs');
const p = process.argv[2];
fs.writeFileSync(p, 'name: arch-review\\n', 'utf-8');`,
        "utf-8",
      );
      const originalEditor = process.env["EDITOR"];
      process.env["EDITOR"] = `node "${stubPath}"`;
      try {
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
          cmd.parseAsync(["node", "council-panel", "edit", "arch-review"]),
        ).rejects.toThrow(/invalid|validation|experts/i);
        expect(errored.toLowerCase()).toMatch(/invalid|validation|experts/);
      } finally {
        if (originalEditor === undefined) delete process.env["EDITOR"];
        else process.env["EDITOR"] = originalEditor;
      }
    });

    it("rejects edits referencing unknown expert slugs (FK validation)", async () => {
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

      // Stub editor: rewrite YAML to reference an unknown expert slug.
      const stubPath = path.join(env.home, "panel-edit-fk.cjs");
      await fs.writeFile(
        stubPath,
        `const fs = require('fs');
const p = process.argv[2];
fs.writeFileSync(p, 'name: arch-review\\nexperts:\\n  - ghost-expert\\n', 'utf-8');`,
        "utf-8",
      );
      const originalEditor = process.env["EDITOR"];
      process.env["EDITOR"] = `node "${stubPath}"`;
      try {
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
          cmd.parseAsync(["node", "council-panel", "edit", "arch-review"]),
        ).rejects.toThrow(/ghost-expert|not found|unknown/i);
        expect(errored).toMatch(/ghost-expert|not found|unknown/i);
      } finally {
        if (originalEditor === undefined) delete process.env["EDITOR"];
        else process.env["EDITOR"] = originalEditor;
      }
    });

    it("rejects when the editor exits with a non-zero status", async () => {
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

      const originalEditor = process.env["EDITOR"];
      process.env["EDITOR"] = `node -e process.exit(2)`;
      try {
        const cmd = buildPanelCommand(
          () => {
            /* noop */
          },
          () => {
            /* noop */
          },
        );
        await expect(
          cmd.parseAsync(["node", "council-panel", "edit", "arch-review"]),
        ).rejects.toThrow(/editor/i);
      } finally {
        if (originalEditor === undefined) delete process.env["EDITOR"];
        else process.env["EDITOR"] = originalEditor;
      }
    });
  });
});
