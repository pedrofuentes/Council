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
import * as yaml from "yaml";

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
    expect(subs).toEqual(["create", "docs", "edit", "inspect", "list"].sort());
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

    it("panel create --model sets defaults.model in YAML", async () => {
      await seedExpert(env, expertDef("cto"));
      await seedExpert(env, expertDef("staff"));

      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await cmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "model-review",
        "--experts",
        "cto,staff",
        "--model",
        "claude-haiku-4.5",
      ]);

      const yamlPath = path.join(env.dataHome, "panels", "model-review.yaml");
      const content = await fs.readFile(yamlPath, "utf-8");
      const parsed = yaml.parse(content) as { defaults?: { model?: string } };
      expect(parsed.defaults?.model).toBe("claude-haiku-4.5");
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

    it("surfaces rollback failures via AggregateError when create fails mid-flight", async () => {
      await seedExpert(env, expertDef("cto"));
      const { vi } = await import("vitest");
      const { PanelLibraryRepository } =
        await import("../../../../src/memory/repositories/panel-library-repo.js");

      const setSpy = vi
        .spyOn(PanelLibraryRepository.prototype, "setMembers")
        .mockImplementationOnce(() => Promise.reject(new Error("simulated setMembers failure")));
      const delSpy = vi
        .spyOn(PanelLibraryRepository.prototype, "delete")
        .mockImplementationOnce(() =>
          Promise.reject(new Error("simulated rollback delete failure")),
        );

      try {
        const cmd = buildPanelCommand(() => {
          /* noop */
        });
        const err = await cmd
          .parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"])
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(err).toBeInstanceOf(AggregateError);
        const errors = (err as AggregateError).errors;
        const messages = errors.map((e) => (e instanceof Error ? e.message : String(e)));
        expect(messages.some((m) => m.includes("simulated rollback delete failure"))).toBe(true);
        expect(messages.length).toBeGreaterThanOrEqual(2);
      } finally {
        setSpy.mockRestore();
        delSpy.mockRestore();
      }
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

    it("panel inspect shows model default when set", async () => {
      await seedExpert(env, expertDef("cto"));
      const createCmd = buildPanelCommand(() => {
        /* noop */
      });
      await createCmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "model-review",
        "--experts",
        "cto",
        "--model",
        "claude-sonnet-4.5",
      ]);

      let captured = "";
      const cmd = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panel", "inspect", "model-review"]);
      expect(captured).toContain("Model:      claude-sonnet-4.5");
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

  describe("panel create — docs folder bootstrap", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("auto-creates <dataHome>/panels/<name>/docs/ when creating a panel", async () => {
      await seedExpert(env, expertDef("cto"));
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await cmd.parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"]);
      const docsDir = path.join(env.dataHome, "panels", "arch-review", "docs");
      const stat = await fs.stat(docsDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe("panel docs", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    async function createPanel(name = "arch-review"): Promise<void> {
      await seedExpert(env, expertDef("cto"));
      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await cmd.parseAsync(["node", "council-panel", "create", name, "--experts", "cto"]);
    }

    it("registers a `docs` subcommand on the panel command", () => {
      const cmd = buildPanelCommand();
      const subs = cmd.commands.map((c) => c.name()).sort();
      expect(subs).toEqual(["create", "docs", "edit", "inspect", "list"].sort());
    });

    it("`panel docs <name>` shows an empty-state hint when no documents exist", async () => {
      await createPanel();
      let captured = "";
      const cmd = buildPanelCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panel", "docs", "arch-review"]);
      expect(captured.toLowerCase()).toMatch(/no documents|empty/);
    });

    it("`panel docs <name>` errors when the panel does not exist", async () => {
      let errored = "";
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        (s) => {
          errored += s;
        },
      );
      await expect(cmd.parseAsync(["node", "council-panel", "docs", "ghost"])).rejects.toThrow(
        /not found/i,
      );
      expect(errored).toMatch(/not found/i);
    });

    it("`panel docs link` records a linked folder and reports document count", async () => {
      await createPanel();
      const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-link-"));
      await fs.writeFile(path.join(linkDir, "a.md"), "# A\nhello world", "utf-8");
      await fs.writeFile(path.join(linkDir, "b.md"), "# B\nbye world", "utf-8");
      try {
        let captured = "";
        const cmd = buildPanelCommand((s) => {
          captured += s;
        });
        await cmd.parseAsync([
          "node",
          "council-panel",
          "docs",
          "link",
          "arch-review",
          "--path",
          linkDir,
          "--yes",
        ]);
        expect(captured).toMatch(/✓|linked/i);
        expect(captured).toContain(path.basename(linkDir));

        // DB row landed.
        const { createDatabase } = await import("../../../../src/memory/db.js");
        const { PanelDocumentRepository } =
          await import("../../../../src/memory/repositories/panel-document-repo.js");
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new PanelDocumentRepository(db);
          const folders = await repo.getLinkedFolders("arch-review");
          expect(folders).toContain(linkDir);
        } finally {
          await db.destroy();
        }
      } finally {
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    });

    it("`panel docs link` errors when --path is a symlink (issue #390)", async () => {
      await createPanel();
      const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-link-real-"));
      const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "council-link-parent-"));
      const linkPath = path.join(linkParent, "alias");
      let linkCreated = false;
      try {
        try {
          await fs.symlink(realDir, linkPath, "junction");
          linkCreated = true;
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "EPERM" && code !== "ENOSYS") throw err;
          try {
            await fs.symlink(realDir, linkPath);
            linkCreated = true;
          } catch {
            return;
          }
        }

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
            "docs",
            "link",
            "arch-review",
            "--path",
            linkPath,
          ]),
        ).rejects.toThrow(/symlink/i);
        expect(errored).toMatch(/symlink/i);
      } finally {
        if (linkCreated) {
          try {
            await fs.unlink(linkPath);
          } catch {
            /* best-effort */
          }
        }
        await fs.rm(realDir, { recursive: true, force: true });
        await fs.rm(linkParent, { recursive: true, force: true });
      }
    });

    it("`panel docs link` errors when --path does not exist", async () => {
      await createPanel();
      let errored = "";
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        (s) => {
          errored += s;
        },
      );
      const missing = path.join(os.tmpdir(), "council-does-not-exist-" + Date.now());
      await expect(
        cmd.parseAsync(["node", "council-panel", "docs", "link", "arch-review", "--path", missing]),
      ).rejects.toThrow(/does not exist|not found/i);
      expect(errored).toMatch(/does not exist|not found/i);
    });

    it("`panel docs link` aborts when confirmation is declined (#472)", async () => {
      await createPanel();
      const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-link-confirm-"));
      await fs.writeFile(path.join(linkDir, "a.md"), "# A\nhello", "utf-8");
      try {
        let captured = "";
        let errored = "";
        const cmd = buildPanelCommand(
          (s) => {
            captured += s;
          },
          (s) => {
            errored += s;
          },
          { confirm: async () => false },
        );
        await expect(
          cmd.parseAsync([
            "node",
            "council-panel",
            "docs",
            "link",
            "arch-review",
            "--path",
            linkDir,
          ]),
        ).rejects.toThrow(/abort|cancel|decline/i);
        expect(errored).toMatch(/abort|cancel|decline/i);
        expect(captured).not.toMatch(/✓|linked/i);

        // Folder must NOT be recorded.
        const { createDatabase } = await import("../../../../src/memory/db.js");
        const { PanelDocumentRepository } =
          await import("../../../../src/memory/repositories/panel-document-repo.js");
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new PanelDocumentRepository(db);
          const folders = await repo.getLinkedFolders("arch-review");
          expect(folders).not.toContain(linkDir);
        } finally {
          await db.destroy();
        }
      } finally {
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    });

    it("`panel docs link --yes` skips the confirmation prompt (#472)", async () => {
      await createPanel();
      const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-link-yes-"));
      await fs.writeFile(path.join(linkDir, "a.md"), "# A\nhello", "utf-8");
      try {
        let confirmCalled = false;
        let captured = "";
        const cmd = buildPanelCommand(
          (s) => {
            captured += s;
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
        await cmd.parseAsync([
          "node",
          "council-panel",
          "docs",
          "link",
          "arch-review",
          "--path",
          linkDir,
          "--yes",
        ]);
        expect(confirmCalled).toBe(false);
        expect(captured).toMatch(/✓|linked/i);
      } finally {
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    });

    it("`panel docs link` proceeds when confirmation is accepted (#472)", async () => {
      await createPanel();
      const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-link-accept-"));
      await fs.writeFile(path.join(linkDir, "a.md"), "# A\nhello", "utf-8");
      try {
        let confirmCalled = false;
        let captured = "";
        const cmd = buildPanelCommand(
          (s) => {
            captured += s;
          },
          () => {
            /* noop */
          },
          {
            confirm: async () => {
              confirmCalled = true;
              return true;
            },
          },
        );
        await cmd.parseAsync([
          "node",
          "council-panel",
          "docs",
          "link",
          "arch-review",
          "--path",
          linkDir,
        ]);
        expect(confirmCalled).toBe(true);
        expect(captured).toMatch(/✓|linked/i);

        const { createDatabase } = await import("../../../../src/memory/db.js");
        const { PanelDocumentRepository } =
          await import("../../../../src/memory/repositories/panel-document-repo.js");
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new PanelDocumentRepository(db);
          const folders = await repo.getLinkedFolders("arch-review");
          expect(folders).toContain(linkDir);
        } finally {
          await db.destroy();
        }
      } finally {
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    });

    it("`panel docs unlink` removes the linked folder", async () => {
      await createPanel();
      const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-unlink-"));
      try {
        const cmd = buildPanelCommand(() => {
          /* noop */
        });
        await cmd.parseAsync([
          "node",
          "council-panel",
          "docs",
          "link",
          "arch-review",
          "--path",
          linkDir,
          "--yes",
        ]);

        let captured = "";
        const cmd2 = buildPanelCommand((s) => {
          captured += s;
        });
        await cmd2.parseAsync([
          "node",
          "council-panel",
          "docs",
          "unlink",
          "arch-review",
          "--path",
          linkDir,
        ]);
        expect(captured).toMatch(/✓|unlinked/i);

        const { createDatabase } = await import("../../../../src/memory/db.js");
        const { PanelDocumentRepository } =
          await import("../../../../src/memory/repositories/panel-document-repo.js");
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new PanelDocumentRepository(db);
          const folders = await repo.getLinkedFolders("arch-review");
          expect(folders).not.toContain(linkDir);
        } finally {
          await db.destroy();
        }
      } finally {
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    });

    it("`panel docs unlink` also removes tracked documents under that folder", async () => {
      await createPanel();
      const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-unlink-docs-"));
      try {
        await fs.writeFile(path.join(linkDir, "a.md"), "# A\nbody", "utf-8");
        const { createDatabase } = await import("../../../../src/memory/db.js");
        const { PanelDocumentRepository } =
          await import("../../../../src/memory/repositories/panel-document-repo.js");

        // Link and then manually track a document for that folder (the
        // chat-startup scanner is what writes panel_documents rows in
        // real use; here we simulate it).
        const cmdLink = buildPanelCommand(() => {
          /* noop */
        });
        await cmdLink.parseAsync([
          "node",
          "council-panel",
          "docs",
          "link",
          "arch-review",
          "--path",
          linkDir,
          "--yes",
        ]);

        const db1 = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new PanelDocumentRepository(db1);
          await repo.trackDocument({
            panelName: "arch-review",
            source: "linked",
            filePath: path.join(linkDir, "a.md"),
            filename: "a.md",
            checksum: "h",
            sizeBytes: 10,
            wordCount: 2,
          });
        } finally {
          await db1.destroy();
        }

        const cmdUnlink = buildPanelCommand(() => {
          /* noop */
        });
        await cmdUnlink.parseAsync([
          "node",
          "council-panel",
          "docs",
          "unlink",
          "arch-review",
          "--path",
          linkDir,
        ]);

        const db2 = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new PanelDocumentRepository(db2);
          const docs = await repo.listDocuments("arch-review");
          expect(docs.find((d) => d.filePath.startsWith(linkDir))).toBeUndefined();
        } finally {
          await db2.destroy();
        }
      } finally {
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    });

    it("`panel docs unlink` also removes the document_index (FTS) entries", async () => {
      // Sentinel cycle 2 #8: assert the FTS row is gone post-unlink.
      await createPanel();
      const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-unlink-fts-"));
      try {
        await fs.writeFile(path.join(linkDir, "a.md"), "# A\nbody\n", "utf-8");
        const { createDatabase } = await import("../../../../src/memory/db.js");
        const { createDocumentIndexer } = await import("../../../../src/core/documents/indexer.js");
        const { PanelDocumentRepository } =
          await import("../../../../src/memory/repositories/panel-document-repo.js");

        const cmdLink = buildPanelCommand(() => {
          /* noop */
        });
        await cmdLink.parseAsync([
          "node",
          "council-panel",
          "docs",
          "link",
          "arch-review",
          "--path",
          linkDir,
          "--yes",
        ]);

        const filePath = path.join(linkDir, "a.md");
        const db1 = await createDatabase(path.join(env.home, "council.db"));
        try {
          const indexer = createDocumentIndexer(db1);
          await indexer.index({
            content: "body",
            sourceType: "panel",
            sourceSlug: "arch-review",
            filePath,
          });
          const repo = new PanelDocumentRepository(db1);
          await repo.trackDocument({
            panelName: "arch-review",
            source: "linked",
            filePath,
            filename: "a.md",
            checksum: "h",
            sizeBytes: 5,
            wordCount: 1,
          });
        } finally {
          await db1.destroy();
        }

        const cmdUnlink = buildPanelCommand(() => {
          /* noop */
        });
        await cmdUnlink.parseAsync([
          "node",
          "council-panel",
          "docs",
          "unlink",
          "arch-review",
          "--path",
          linkDir,
        ]);

        const { sql } = await import("kysely");
        const db2 = await createDatabase(path.join(env.home, "council.db"));
        try {
          const r = await sql<{
            n: number;
          }>`SELECT COUNT(*) as n FROM document_index WHERE file_path = ${filePath}`.execute(db2);
          expect(r.rows[0]?.n).toBe(0);
        } finally {
          await db2.destroy();
        }
      } finally {
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    });
    it("`panel docs unlink` aborts and preserves metadata when FTS cleanup fails (#388)", async () => {
      await createPanel();
      const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-unlink-fts-fail-"));
      try {
        await fs.writeFile(path.join(linkDir, "a.md"), "# A\nbody\n", "utf-8");
        const { createDatabase } = await import("../../../../src/memory/db.js");
        const { PanelDocumentRepository } =
          await import("../../../../src/memory/repositories/panel-document-repo.js");

        const cmdLink = buildPanelCommand(() => {
          /* noop */
        });
        await cmdLink.parseAsync([
          "node",
          "council-panel",
          "docs",
          "link",
          "arch-review",
          "--path",
          linkDir,
          "--yes",
        ]);

        const filePath = path.join(linkDir, "a.md");
        const db1 = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new PanelDocumentRepository(db1);
          await repo.trackDocument({
            panelName: "arch-review",
            source: "linked",
            filePath,
            filename: "a.md",
            checksum: "h",
            sizeBytes: 5,
            wordCount: 1,
          });
          // Drop FTS5 table so indexer.remove() throws during unlink.
          const { sql } = await import("kysely");
          await sql`DROP TABLE document_index`.execute(db1);
        } finally {
          await db1.destroy();
        }

        let captured = "";
        let erred = "";
        const cmdUnlink = buildPanelCommand(
          (s) => {
            captured += s;
          },
          (s) => {
            erred += s;
          },
        );
        // Unlink must FAIL closed when FTS cleanup fails — otherwise
        // metadata is removed but stale `document_index` rows remain
        // queryable (the linked folder is gone so no rescan can heal it).
        await expect(
          cmdUnlink.parseAsync([
            "node",
            "council-panel",
            "docs",
            "unlink",
            "arch-review",
            "--path",
            linkDir,
          ]),
        ).rejects.toThrow(/Unlink aborted/i);

        expect(captured).not.toContain("✓");
        expect(erred.toLowerCase()).toMatch(/unlink aborted/);
        expect(erred.toLowerCase()).toMatch(/linked folder preserved/);

        // The `panel_documents` row MUST still be present so the user
        // can retry the unlink after addressing the FTS failure. Recreate
        // the dropped FTS5 table so the verification can open the DB.
        const verifyDb = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new PanelDocumentRepository(verifyDb);
          const docs = await repo.listDocuments("arch-review");
          expect(docs.some((d) => d.filePath === filePath)).toBe(true);
        } finally {
          await verifyDb.destroy();
        }
      } finally {
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    });

    it("`panel docs unlink` is atomic across multiple docs — a mid-loop FTS failure rolls back earlier deletes (#388)", async () => {
      await createPanel();
      const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-unlink-multi-"));
      try {
        await fs.writeFile(path.join(linkDir, "a.md"), "# A\nbody A\n", "utf-8");
        await fs.writeFile(path.join(linkDir, "b.md"), "# B\nbody B\n", "utf-8");

        const { createDatabase } = await import("../../../../src/memory/db.js");
        const { PanelDocumentRepository } =
          await import("../../../../src/memory/repositories/panel-document-repo.js");
        const { createDocumentIndexer } = await import("../../../../src/core/documents/indexer.js");

        const cmdLink = buildPanelCommand(() => {
          /* noop */
        });
        await cmdLink.parseAsync([
          "node",
          "council-panel",
          "docs",
          "link",
          "arch-review",
          "--path",
          linkDir,
          "--yes",
        ]);

        const filePathA = path.join(linkDir, "a.md");
        const filePathB = path.join(linkDir, "b.md");

        // Track BOTH docs and seed FTS rows for BOTH; then drop the FTS
        // table so the SECOND indexer.remove() call inside the unlink
        // loop will throw. The first call may already have removed
        // doc A's row from the FTS table — under correct atomic
        // semantics that delete must be rolled back when the loop
        // aborts.
        const setupDb = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new PanelDocumentRepository(setupDb);
          await repo.trackDocument({
            panelName: "arch-review",
            source: "linked",
            filePath: filePathA,
            filename: "a.md",
            checksum: "ha",
            sizeBytes: 1,
            wordCount: 1,
          });
          await repo.trackDocument({
            panelName: "arch-review",
            source: "linked",
            filePath: filePathB,
            filename: "b.md",
            checksum: "hb",
            sizeBytes: 1,
            wordCount: 1,
          });
          const indexer = createDocumentIndexer(setupDb);
          await indexer.index({
            content: "alpha alpha uniquetokenaaa",
            sourceType: "panel",
            sourceSlug: "arch-review",
            filePath: filePathA,
          });
          await indexer.index({
            content: "beta beta uniquetokenbbb",
            sourceType: "panel",
            sourceSlug: "arch-review",
            filePath: filePathB,
          });

          // Sanity: both tokens findable now.
          const { sql } = await import("kysely");
          const before = (await sql<{
            cnt: number;
          }>`SELECT COUNT(*) AS cnt FROM document_index WHERE document_index MATCH 'uniquetokenaaa OR uniquetokenbbb'`.execute(
            setupDb,
          )) as unknown as { rows: readonly { cnt: number }[] };
          expect(before.rows[0]?.cnt).toBe(2);
        } finally {
          await setupDb.destroy();
        }

        // Patch LibsqlConnection.prototype.executeQuery so the SECOND
        // `DELETE FROM document_index WHERE file_path = ?` throws.
        // This is the same interception strategy used by the indexer
        // atomicity test and survives the cmd's internal `db` instance.
        const { LibsqlConnection } = await import("@libsql/kysely-libsql");
        const originalExecute = LibsqlConnection.prototype.executeQuery;
        let ftsDeleteCount = 0;
        LibsqlConnection.prototype.executeQuery = async function (
          this: InstanceType<typeof LibsqlConnection>,
          compiledQuery: { sql: string; parameters: readonly unknown[] },
        ): Promise<unknown> {
          const isPerFileFtsDelete = /DELETE\s+FROM\s+document_index\s+WHERE\s+file_path\s*=/i.test(
            compiledQuery.sql,
          );
          if (isPerFileFtsDelete) {
            ftsDeleteCount += 1;
            if (ftsDeleteCount === 2) {
              throw new Error("simulated FTS failure on second doc");
            }
          }
          return (originalExecute as (q: unknown) => unknown).call(this, compiledQuery);
        } as typeof originalExecute;

        try {
          let captured = "";
          let erred = "";
          const cmdUnlink = buildPanelCommand(
            (s) => {
              captured += s;
            },
            (s) => {
              erred += s;
            },
          );
          await expect(
            cmdUnlink.parseAsync([
              "node",
              "council-panel",
              "docs",
              "unlink",
              "arch-review",
              "--path",
              linkDir,
            ]),
          ).rejects.toThrow(/Unlink aborted/i);
          expect(captured).not.toContain("✓");
          expect(erred.toLowerCase()).toMatch(/unlink aborted/);

          // Atomicity check: the FTS row for doc A must STILL be present
          // (rolled back), AND both panel_documents rows must still be
          // present (linked folder preserved).
          const verifyDb = await createDatabase(path.join(env.home, "council.db"));
          try {
            const { sql } = await import("kysely");
            const after = (await sql<{
              cnt: number;
            }>`SELECT COUNT(*) AS cnt FROM document_index WHERE document_index MATCH 'uniquetokenaaa OR uniquetokenbbb'`.execute(
              verifyDb,
            )) as unknown as { rows: readonly { cnt: number }[] };
            expect(after.rows[0]?.cnt).toBe(2);

            const repo = new PanelDocumentRepository(verifyDb);
            const docs = await repo.listDocuments("arch-review");
            expect(docs.some((d) => d.filePath === filePathA)).toBe(true);
            expect(docs.some((d) => d.filePath === filePathB)).toBe(true);
          } finally {
            await verifyDb.destroy();
          }
        } finally {
          LibsqlConnection.prototype.executeQuery = originalExecute;
        }
      } finally {
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    });
  });
});
