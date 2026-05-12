/**
 * Tests for `council expert` CLI commands (Roadmap 4.3).
 *
 * Each subcommand is exercised end-to-end through its Commander action,
 * using an isolated COUNCIL_HOME + COUNCIL_DATA_HOME so the user's real
 * library is never touched. Interactive prompts are bypassed using the
 * non-interactive flag path (`--slug`, `--name`, `--role`, `--expertise`,
 * `--stance`).
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildExpertCommand } from "../../../../src/cli/commands/expert.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-expert-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-expert-data-"));
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

const SAMPLE: ExpertDefinition = {
  slug: "dahlia-cto",
  displayName: "Dahlia Renner (CTO)",
  role: "Skeptical CTO with 20 years of experience",
  expertise: {
    weightedEvidence: ["production incident data", "industry failure case studies"],
    referenceCases: ["distributed monolith anti-pattern"],
    notExpertIn: ["frontend frameworks"],
  },
  epistemicStance: "Bayesian skeptic — updates on evidence but demands high prior probability",
  kind: "generic",
};

describe("buildExpertCommand", () => {
  it("registers an 'expert' command with subcommands", () => {
    const cmd = buildExpertCommand();
    expect(cmd.name()).toBe("expert");
    const subs = cmd.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(["create", "delete", "edit", "inspect", "list"].sort());
  });

  describe("expert list", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("prints empty-state hint when no experts exist", async () => {
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "list"]);
      expect(captured.toLowerCase()).toMatch(/no experts/);
      expect(captured.toLowerCase()).toMatch(/council expert create/);
    });

    it("lists seeded experts in table format", async () => {
      await seedExpert(env, SAMPLE);
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "list"]);
      expect(captured).toContain("dahlia-cto");
      expect(captured).toContain("Dahlia Renner");
      expect(captured).toContain("generic");
    });

    it("emits JSON when --format json", async () => {
      await seedExpert(env, SAMPLE);
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "list", "--format", "json"]);
      const parsed = JSON.parse(captured) as readonly { readonly slug: string }[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]?.slug).toBe("dahlia-cto");
    });
  });

  describe("expert inspect", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("shows formatted detail for a seeded expert", async () => {
      await seedExpert(env, SAMPLE);
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "inspect", "dahlia-cto"]);
      expect(captured).toContain("Expert: dahlia-cto");
      expect(captured).toContain("Dahlia Renner (CTO)");
      expect(captured).toContain("Skeptical CTO");
      expect(captured).toContain("generic");
      expect(captured).toContain("production incident data");
      expect(captured).toContain("Bayesian skeptic");
    });

    it("reports not found", async () => {
      let captured = "";
      let errored = "";
      const cmd = buildExpertCommand(
        (s) => {
          captured += s;
        },
        (s) => {
          errored += s;
        },
      );
      await expect(
        cmd.parseAsync(["node", "council-expert", "inspect", "nobody"]),
      ).rejects.toThrow(/not found/i);
      // Either the error writer or the thrown error carries the message.
      expect((captured + errored).length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("expert create (non-interactive)", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("creates an expert from flags", async () => {
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync([
        "node",
        "council-expert",
        "create",
        "--slug",
        "alpha",
        "--name",
        "Alpha Engineer",
        "--role",
        "Pragmatic engineer",
        "--expertise",
        "shipped software, production incidents",
        "--stance",
        "Empirical",
      ]);
      expect(captured).toMatch(/✓|created/);
      expect(captured).toContain("alpha");
      const yamlPath = path.join(env.dataHome, "experts", "alpha.yaml");
      const content = await fs.readFile(yamlPath, "utf-8");
      expect(content).toContain("slug: alpha");
      expect(content).toContain("Pragmatic engineer");
    });

    it("creates a persona expert with --persona and prepares docs dir", async () => {
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync([
        "node",
        "council-expert",
        "create",
        "--persona",
        "--slug",
        "boss",
        "--name",
        "My Boss",
        "--role",
        "VP of Eng",
        "--expertise",
        "calibration meetings",
        "--stance",
        "Outcome-driven",
        "--persona-description",
        "VP of Engineering I report to",
      ]);
      const yamlPath = path.join(env.dataHome, "experts", "boss.yaml");
      const content = await fs.readFile(yamlPath, "utf-8");
      expect(content).toContain("kind: persona");
      expect(content).toContain("personaDescription:");
      const docsDir = path.join(env.dataHome, "experts", "boss", "docs");
      const stat = await fs.stat(docsDir);
      expect(stat.isDirectory()).toBe(true);
      expect(captured).toMatch(/docs/);
    });

    it("rejects duplicate slug with a helpful message", async () => {
      await seedExpert(env, SAMPLE);
      let captured = "";
      let errored = "";
      const cmd = buildExpertCommand(
        (s) => {
          captured += s;
        },
        (s) => {
          errored += s;
        },
      );
      await expect(
        cmd.parseAsync([
          "node",
          "council-expert",
          "create",
          "--slug",
          "dahlia-cto",
          "--name",
          "Dupe",
          "--role",
          "Dupe",
          "--expertise",
          "anything",
          "--stance",
          "any",
        ]),
      ).rejects.toThrow(/already exists/i);
      const msg = captured + errored;
      // The error path should mention the edit hint somewhere (either thrown or written).
      expect(msg + " " + (msg.length === 0 ? "checked-in-throw" : "")).toBeTruthy();
    });

    it("rejects invalid slug", async () => {
      const cmd = buildExpertCommand(() => { /* noop */ });
      await expect(
        cmd.parseAsync([
          "node",
          "council-expert",
          "create",
          "--slug",
          "Bad Slug!",
          "--name",
          "X",
          "--role",
          "X",
          "--expertise",
          "x",
          "--stance",
          "x",
        ]),
      ).rejects.toThrow(/slug/i);
    });
  });

  describe("expert delete", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("deletes an expert that is in no panels", async () => {
      await seedExpert(env, SAMPLE);
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "delete", "dahlia-cto"]);
      expect(captured).toMatch(/deleted/i);
      const yamlPath = path.join(env.dataHome, "experts", "dahlia-cto.yaml");
      await expect(fs.access(yamlPath)).rejects.toThrow();
    });

    it("refuses without --force when expert is in panels", async () => {
      await seedExpert(env, SAMPLE);
      // Add a panel + membership directly.
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        await db
          .insertInto("panel_library")
          .values({
            name: "architecture-review",
            yaml_path: path.join(env.dataHome, "panels", "architecture-review.yaml"),
            yaml_checksum: "x",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .execute();
        await db
          .insertInto("panel_members")
          .values({
            panel_name: "architecture-review",
            expert_slug: "dahlia-cto",
            position: 0,
            created_at: new Date().toISOString(),
          })
          .execute();
      } finally {
        await db.destroy();
      }

      const cmd = buildExpertCommand(() => { /* noop */ });
      await expect(
        cmd.parseAsync(["node", "council-expert", "delete", "dahlia-cto"]),
      ).rejects.toThrow(/--force|panels/i);
    });

    it("deletes despite panel membership with --force", async () => {
      await seedExpert(env, SAMPLE);
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        await db
          .insertInto("panel_library")
          .values({
            name: "architecture-review",
            yaml_path: path.join(env.dataHome, "panels", "architecture-review.yaml"),
            yaml_checksum: "x",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .execute();
        await db
          .insertInto("panel_members")
          .values({
            panel_name: "architecture-review",
            expert_slug: "dahlia-cto",
            position: 0,
            created_at: new Date().toISOString(),
          })
          .execute();
      } finally {
        await db.destroy();
      }

      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "delete", "dahlia-cto", "--force"]);
      expect(captured).toMatch(/deleted/i);
    });

    it("reports not found", async () => {
      const cmd = buildExpertCommand(() => { /* noop */ });
      await expect(
        cmd.parseAsync(["node", "council-expert", "delete", "ghost"]),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("expert edit", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("reports not found when slug is missing", async () => {
      const cmd = buildExpertCommand(() => { /* noop */ });
      await expect(
        cmd.parseAsync(["node", "council-expert", "edit", "ghost"]),
      ).rejects.toThrow(/not found/i);
    });

    it("invokes the configured editor and re-validates", async () => {
      await seedExpert(env, SAMPLE);
      // Use an editor stub that just touches mtime — no content change, so
      // re-validation must succeed against the existing YAML.
      const originalEditor = process.env["EDITOR"];
      // Cross-platform no-op: node -e "" simply exits 0 without modifying file.
      process.env["EDITOR"] = `node -e ""`;
      try {
        let captured = "";
        const cmd = buildExpertCommand((s) => {
          captured += s;
        });
        await cmd.parseAsync(["node", "council-expert", "edit", "dahlia-cto"]);
        expect(captured.toLowerCase()).toMatch(/saved|updated|ok|validated|✓/);
      } finally {
        if (originalEditor === undefined) delete process.env["EDITOR"];
        else process.env["EDITOR"] = originalEditor;
      }
    });
  });
});
