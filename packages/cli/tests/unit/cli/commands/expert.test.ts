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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildExpertCommand } from "../../../../src/cli/commands/expert.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../../src/engine/index.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";
import { mkCanonicalTempDir } from "../../../helpers/tmp.js";

// Stub engine used by `expert train` tests — mirrors the one in
// tests/unit/core/documents/processor.test.ts. It returns a canned
// JSON payload that `analyzeDocuments()` can parse into a profile.
class StubEngine implements CouncilEngine {
  readonly registered: ExpertSpec[] = [];
  readonly removed: string[] = [];
  readonly sends: { expertId: string; prompt: string }[] = [];
  readonly responses: string[];

  constructor(responses: readonly string[] = []) {
    this.responses = [...responses];
  }

  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  async addExpert(spec: ExpertSpec): Promise<void> {
    this.registered.push(spec);
  }
  async removeExpert(expertId: string): Promise<void> {
    this.removed.push(expertId);
  }
  async listModels(): Promise<readonly string[]> {
    return ["stub-model"];
  }
  send(opts: SendOptions): AsyncIterable<EngineEvent> {
    this.sends.push({ expertId: opts.expertId, prompt: opts.prompt });
    const text = this.responses.shift() ?? "";
    const expertId = opts.expertId;
    return (async function* (): AsyncGenerator<EngineEvent, void, void> {
      yield { kind: "message.delta", expertId, text };
      yield {
        kind: "message.complete",
        expertId,
        response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
      };
    })();
  }
}

const STUB_PROFILE_JSON = JSON.stringify({
  communicationStyle: "Terse and direct.",
  decisionPatterns: ["consult-data", "ship-incrementally"],
  biases: ["recency"],
  vocabulary: ["ship", "data"],
  epistemicStance: "Empirical, updates on evidence.",
});

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await mkCanonicalTempDir("council-expert-home-");
  const dataHome = await mkCanonicalTempDir("council-expert-data-");
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
    expect(subs).toEqual(["create", "delete", "docs", "edit", "inspect", "list", "train"].sort());
  });

  it("defaults bare expert to the list action", { timeout: 30_000 }, async () => {
    const env = await makeEnv();
    try {
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert"]);
      expect(captured).toContain('No experts found. Create one with "council expert create".');
      expect(captured).not.toContain("Usage:");
    } finally {
      await teardown(env);
    }
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

    it("expert inspect shows model when set", async () => {
      await seedExpert(env, {
        ...SAMPLE,
        slug: "model-seeded",
        displayName: "Model Seeded",
        model: "claude-sonnet-4.5",
      });
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "inspect", "model-seeded"]);
      expect(captured).toContain("Model:  claude-sonnet-4.5");
    });

    it("surfaces the learned persona profile when one exists (F20)", async () => {
      const PERSONA: ExpertDefinition = {
        slug: "boss",
        displayName: "My Boss",
        role: "VP Eng",
        expertise: { weightedEvidence: ["calibration"], referenceCases: [], notExpertIn: [] },
        epistemicStance: "Outcome-driven",
        kind: "persona",
        personaDescription: "VP of Engineering",
      };
      await seedExpert(env, PERSONA);

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { ProfileRepository } = await import(
        "../../../../src/memory/repositories/profile-repository.js"
      );
      {
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          await new ProfileRepository(db).upsert("boss", {
            communicationStyle: "Terse, metrics-driven, action-oriented.",
            decisionPatterns: ["consult-data", "ship-incrementally"],
            biases: ["recency-bias"],
            vocabulary: ["ship", "metrics", "north-star"],
            epistemicStance: "Empirical; updates beliefs on measured outcomes.",
            lastUpdated: "2026-06-01T00:00:00.000Z",
            documentCount: 3,
            totalWords: 1200,
          });
        } finally {
          await db.destroy();
        }
      }

      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "inspect", "boss"]);
      // The training-derived profile must be visible, not just the manual
      // persona description.
      expect(captured).toContain("VP of Engineering");
      expect(captured).toMatch(/Terse, metrics-driven/);
      expect(captured).toContain("Empirical; updates beliefs on measured outcomes.");
      expect(captured).toContain("consult-data");
      expect(captured).toContain("recency-bias");
      expect(captured).toContain("north-star");
    });

    it("includes the learned profile in --format json output (F20)", async () => {
      const PERSONA: ExpertDefinition = {
        slug: "boss",
        displayName: "My Boss",
        role: "VP Eng",
        expertise: { weightedEvidence: ["calibration"], referenceCases: [], notExpertIn: [] },
        epistemicStance: "Outcome-driven",
        kind: "persona",
        personaDescription: "VP of Engineering",
      };
      await seedExpert(env, PERSONA);

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { ProfileRepository } = await import(
        "../../../../src/memory/repositories/profile-repository.js"
      );
      {
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          await new ProfileRepository(db).upsert("boss", {
            communicationStyle: "Terse, metrics-driven, action-oriented.",
            decisionPatterns: ["consult-data"],
            biases: ["recency-bias"],
            vocabulary: ["ship"],
            epistemicStance: "Empirical.",
            lastUpdated: "2026-06-01T00:00:00.000Z",
            documentCount: 3,
            totalWords: 1200,
          });
        } finally {
          await db.destroy();
        }
      }

      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync([
        "node",
        "council-expert",
        "inspect",
        "boss",
        "--format",
        "json",
      ]);
      const parsed = JSON.parse(captured) as { profile?: { communicationStyle?: string } };
      expect(parsed.profile?.communicationStyle).toBe("Terse, metrics-driven, action-oriented.");
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
      await expect(cmd.parseAsync(["node", "council-expert", "inspect", "nobody"])).rejects.toThrow(
        /not found/i,
      );
      expect(errored + captured).toMatch(/not found|nobody/i);
    });

    it("throws CliUserError (not plain Error) for not-found", async () => {
      const cmd = buildExpertCommand(() => {
        /* noop */
      });
      try {
        await cmd.parseAsync(["node", "council-expert", "inspect", "nobody"]);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CliUserError);
      }
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

    it("expert create --model sets the model field in YAML", async () => {
      const createCmd = buildExpertCommand(() => {
        /* noop */
      });
      await createCmd.parseAsync([
        "node",
        "council-expert",
        "create",
        "--slug",
        "model-alpha",
        "--name",
        "Model Alpha",
        "--role",
        "Model-aware engineer",
        "--expertise",
        "model selection",
        "--stance",
        "Empirical",
        "--model",
        "claude-haiku-4.5",
      ]);

      const yamlPath = path.join(env.dataHome, "experts", "model-alpha.yaml");
      const content = await fs.readFile(yamlPath, "utf-8");
      expect(content).toContain("model: claude-haiku-4.5");

      let captured = "";
      const inspectCmd = buildExpertCommand((s) => {
        captured += s;
      });
      await inspectCmd.parseAsync(["node", "council-expert", "inspect", "model-alpha"]);
      expect(captured).toContain("Model:  claude-haiku-4.5");
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

    it("documents persona training in create help", () => {
      const create = buildExpertCommand().commands.find((command) => command.name() === "create");
      const help = create?.helpInformation() ?? "";
      expect(help).toMatch(/--persona/);
      expect(help).toMatch(/document-based training/i);
    });

    it("rejects duplicate slug with a helpful message", async () => {
      await seedExpert(env, SAMPLE);
      let errored = "";
      const cmd = buildExpertCommand(
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
      // Error stream carries the user-facing hint pointing at `expert edit`.
      expect(errored).toMatch(/already exists/i);
      expect(errored).toMatch(/council expert edit/i);
    });

    it("recreates a ghost expert when the YAML file is gone but the DB row remains", async () => {
      await seedExpert(env, SAMPLE);
      const yamlPath = path.join(env.dataHome, "experts", "dahlia-cto.yaml");
      await fs.unlink(yamlPath);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        let listCaptured = "";
        await buildExpertCommand((s) => {
          listCaptured += s;
        }).parseAsync(["node", "council-expert", "list"]);
        expect(listCaptured).toContain("No experts found");

        await expect(
          buildExpertCommand(() => {
            /* noop */
          }).parseAsync(["node", "council-expert", "inspect", "dahlia-cto"]),
        ).rejects.toThrow(/not found/i);
        await expect(
          buildExpertCommand(() => {
            /* noop */
          }).parseAsync(["node", "council-expert", "delete", "dahlia-cto", "--yes"]),
        ).rejects.toThrow(/not found/i);

        let createCaptured = "";
        await buildExpertCommand((s) => {
          createCaptured += s;
        }).parseAsync([
          "node",
          "council-expert",
          "create",
          "--slug",
          "dahlia-cto",
          "--name",
          "Dahlia Recreated",
          "--role",
          "Recovered from stale cache",
          "--expertise",
          "incident reviews",
          "--stance",
          "Empirical",
        ]);

        expect(createCaptured).toMatch(/created/i);
        const recreatedYaml = await fs.readFile(yamlPath, "utf-8");
        expect(recreatedYaml).toContain("displayName: Dahlia Recreated");
        expect(recreatedYaml).toContain("role: Recovered from stale cache");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Recovering stale expert cache row for slug "dahlia-cto"'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("rejects invalid slug", async () => {
      const cmd = buildExpertCommand(() => {
        /* noop */
      });
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

    it(
      "fails fast (non-zero, no misleading ✓) when required fields are missing in non-TTY mode (PM-08)",
      { timeout: 15_000 },
      async () => {
        // Regression for PM-08: `expert create --slug x --persona` with a
        // non-interactive stdin used to print a misleading "✓ slug" prefill
        // line and exit 0 while persisting nothing — the wizard hit EOF on
        // stdin and was abandoned. The command must instead fail fast with an
        // actionable, non-zero error and create nothing.
        const originalIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

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

        try {
          await expect(
            cmd.parseAsync([
              "node",
              "council-expert",
              "create",
              "--slug",
              "trained-cfo",
              "--persona",
            ]),
          ).rejects.toThrow(/non-interactive/i);

          // No misleading success indicator may be printed.
          expect(captured).not.toContain("✓");
          // The error must point the user at the flags to supply.
          expect(errored).toMatch(/non-interactive/i);
          expect(errored).toMatch(/--name/);
          // Nothing may be persisted: no YAML and absent from `expert list`.
          const yamlPath = path.join(env.dataHome, "experts", "trained-cfo.yaml");
          await expect(fs.access(yamlPath)).rejects.toThrow();

          let listed = "";
          await buildExpertCommand((s) => {
            listed += s;
          }).parseAsync(["node", "council-expert", "list"]);
          expect(listed).not.toContain("trained-cfo");
        } finally {
          Object.defineProperty(process.stdin, "isTTY", {
            value: originalIsTTY,
            configurable: true,
          });
        }
      },
    );
  });

  describe("expert delete", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("deletes an expert that is in no panels with --yes", async () => {
      await seedExpert(env, SAMPLE);
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "delete", "dahlia-cto", "--yes"]);
      expect(captured).toMatch(/deleted/i);
      const yamlPath = path.join(env.dataHome, "experts", "dahlia-cto.yaml");
      await expect(fs.access(yamlPath)).rejects.toThrow();
    });

    it("requires --yes in non-interactive mode even without --force", async () => {
      await seedExpert(env, SAMPLE);
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

      const cmd = buildExpertCommand(() => {
        /* noop */
      });

      try {
        await expect(
          cmd.parseAsync(["node", "council-expert", "delete", "dahlia-cto"]),
        ).rejects.toThrow(/--yes/i);
      } finally {
        Object.defineProperty(process.stdin, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
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

      const cmd = buildExpertCommand(() => {
        /* noop */
      });
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
      await cmd.parseAsync(["node", "council-expert", "delete", "dahlia-cto", "--force", "--yes"]);
      expect(captured).toMatch(/deleted/i);
    });

    it("rejects --force without --yes in non-interactive mode", async () => {
      await seedExpert(env, SAMPLE);
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        await db
          .insertInto("panel_library")
          .values({
            name: "automation-panel",
            yaml_path: path.join(env.dataHome, "panels", "automation-panel.yaml"),
            yaml_checksum: "x",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .execute();
        await db
          .insertInto("panel_members")
          .values({
            panel_name: "automation-panel",
            expert_slug: "dahlia-cto",
            position: 0,
            created_at: new Date().toISOString(),
          })
          .execute();
      } finally {
        await db.destroy();
      }

      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

      const cmd = buildExpertCommand(() => {
        /* noop */
      });

      try {
        await expect(
          cmd.parseAsync(["node", "council-expert", "delete", "dahlia-cto", "--force"]),
        ).rejects.toThrow(/--yes/i);
      } finally {
        Object.defineProperty(process.stdin, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });

    it("--force without --yes succeeds in interactive (TTY) mode", async () => {
      await seedExpert(env, SAMPLE);
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        await db
          .insertInto("panel_library")
          .values({
            name: "tty-panel",
            yaml_path: path.join(env.dataHome, "panels", "tty-panel.yaml"),
            yaml_checksum: "x",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .execute();
        await db
          .insertInto("panel_members")
          .values({
            panel_name: "tty-panel",
            expert_slug: "dahlia-cto",
            position: 0,
            created_at: new Date().toISOString(),
          })
          .execute();
      } finally {
        await db.destroy();
      }

      // Simulate interactive TTY mode
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });

      try {
        await cmd.parseAsync(["node", "council-expert", "delete", "dahlia-cto", "--force"]);
        expect(captured).toMatch(/deleted/i);
      } finally {
        Object.defineProperty(process.stdin, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });

    it("reports not found", async () => {
      const cmd = buildExpertCommand(() => {
        /* noop */
      });
      await expect(cmd.parseAsync(["node", "council-expert", "delete", "ghost"])).rejects.toThrow(
        /not found/i,
      );
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
      const cmd = buildExpertCommand(() => {
        /* noop */
      });
      await expect(cmd.parseAsync(["node", "council-expert", "edit", "ghost"])).rejects.toThrow(
        /not found/i,
      );
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

    it("syncs DB metadata (displayName + checksum) after a real YAML mutation", async () => {
      await seedExpert(env, SAMPLE);
      // Write a node stub that rewrites the YAML with a new displayName so
      // we can verify that the DB metadata row + yaml_checksum get refreshed
      // on save (not just that the YAML parses).
      const stubPath = path.join(env.home, "edit-stub.cjs");
      await fs.writeFile(
        stubPath,
        `const fs = require('fs');
const p = process.argv[2];
let body = fs.readFileSync(p, 'utf-8');
body = body.replace(/displayName: .*/, 'displayName: Dahlia Renner (Renamed CTO)');
body = body.replace(/^role: .*/m, 'role: Renamed role');
fs.writeFileSync(p, body, 'utf-8');`,
        "utf-8",
      );

      const originalEditor = process.env["EDITOR"];
      process.env["EDITOR"] = `node "${stubPath}"`;
      try {
        let captured = "";
        const cmd = buildExpertCommand((s) => {
          captured += s;
        });
        await cmd.parseAsync(["node", "council-expert", "edit", "dahlia-cto"]);
        expect(captured.toLowerCase()).toMatch(/saved|✓/);

        // Verify DB metadata caught up with the on-disk YAML edit.
        const { createDatabase } = await import("../../../../src/memory/db.js");
        const { ExpertLibraryRepository } =
          await import("../../../../src/memory/repositories/expert-library-repo.js");
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          const repo = new ExpertLibraryRepository(db);
          const row = await repo.findBySlug("dahlia-cto");
          expect(row?.displayName).toBe("Dahlia Renner (Renamed CTO)");
          const onDisk = await fs.readFile(
            path.join(env.dataHome, "experts", "dahlia-cto.yaml"),
            "utf-8",
          );
          const { createHash } = await import("node:crypto");
          const expected = createHash("sha256").update(onDisk).digest("hex");
          expect(row?.yamlChecksum).toBe(expected);
        } finally {
          await db.destroy();
        }
      } finally {
        if (originalEditor === undefined) delete process.env["EDITOR"];
        else process.env["EDITOR"] = originalEditor;
      }
    });

    it("rejects slug renames via edit", async () => {
      await seedExpert(env, SAMPLE);
      const stubPath = path.join(env.home, "edit-rename.cjs");
      await fs.writeFile(
        stubPath,
        `const fs = require('fs');
const p = process.argv[2];
const body = fs.readFileSync(p, 'utf-8').replace(/^slug: .*/m, 'slug: renamed-slug');
fs.writeFileSync(p, body, 'utf-8');`,
        "utf-8",
      );
      const originalEditor = process.env["EDITOR"];
      process.env["EDITOR"] = `node "${stubPath}"`;
      try {
        const cmd = buildExpertCommand(
          () => {
            /* noop */
          },
          () => {
            /* noop */
          },
        );
        await expect(
          cmd.parseAsync(["node", "council-expert", "edit", "dahlia-cto"]),
        ).rejects.toThrow(/slug/i);
      } finally {
        if (originalEditor === undefined) delete process.env["EDITOR"];
        else process.env["EDITOR"] = originalEditor;
      }
    });

    it("rejects when the editor exits with a non-zero status", async () => {
      await seedExpert(env, SAMPLE);
      const originalEditor = process.env["EDITOR"];
      // node -e "process.exit(2)" — exits non-zero regardless of file arg.
      process.env["EDITOR"] = `node -e process.exit(2)`;
      try {
        const cmd = buildExpertCommand(
          () => {
            /* noop */
          },
          () => {
            /* noop */
          },
        );
        await expect(
          cmd.parseAsync(["node", "council-expert", "edit", "dahlia-cto"]),
        ).rejects.toThrow(/editor/i);
      } finally {
        if (originalEditor === undefined) delete process.env["EDITOR"];
        else process.env["EDITOR"] = originalEditor;
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // expert docs (Roadmap 6.6)
  // ────────────────────────────────────────────────────────────────────
  describe("expert docs", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    const PERSONA: ExpertDefinition = {
      slug: "boss",
      displayName: "My Boss",
      role: "VP Eng",
      expertise: { weightedEvidence: ["calibration"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "Outcome-driven",
      kind: "persona",
      personaDescription: "VP of Engineering",
    };

    async function seedDocRow(slug: string, filename: string, wordCount: number): Promise<void> {
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { DocumentRepository } =
        await import("../../../../src/memory/repositories/document-repository.js");
      const { createDocumentIndexer } = await import("../../../../src/core/documents/indexer.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const docsDir = path.join(env.dataHome, "experts", slug, "docs");
        await fs.mkdir(docsDir, { recursive: true });
        const filePath = path.join(docsDir, filename);
        const repo = new DocumentRepository(db);
        const created = await repo.create({
          expertSlug: slug,
          filePath,
          filename,
          checksum: `cs-${filename}`,
          sizeBytes: 100,
          wordCount,
        });
        await repo.updateStatus(created.id, "processed", new Date().toISOString());
        const indexer = createDocumentIndexer(db);
        await indexer.index({
          content: `content of ${filename}`,
          sourceType: "expert",
          sourceSlug: slug,
          filePath,
        });
      } finally {
        await db.destroy();
      }
    }

    it("prints empty-state hint when persona has no indexed documents", async () => {
      await seedExpert(env, PERSONA);
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "docs", "boss"]);
      expect(captured.toLowerCase()).toMatch(/no documents/);
      expect(captured).toContain("boss");
    });

    it("lists indexed documents in a table", async () => {
      await seedExpert(env, PERSONA);
      await seedDocRow("boss", "alpha.md", 100);
      await seedDocRow("boss", "beta.txt", 250);
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "docs", "boss"]);
      expect(captured).toContain("alpha.md");
      expect(captured).toContain("beta.txt");
      expect(captured).toContain("100");
      expect(captured).toContain("250");
      expect(captured.toLowerCase()).toContain("processed");
    });

    it("reports not found when slug does not exist", async () => {
      const cmd = buildExpertCommand(
        () => {
          /* noop */
        },
        () => {
          /* noop */
        },
      );
      await expect(cmd.parseAsync(["node", "council-expert", "docs", "ghost"])).rejects.toThrow(
        /not found/i,
      );
    });

    it("rejects non-persona experts", async () => {
      await seedExpert(env, SAMPLE);
      const cmd = buildExpertCommand(
        () => {
          /* noop */
        },
        () => {
          /* noop */
        },
      );
      await expect(
        cmd.parseAsync(["node", "council-expert", "docs", "dahlia-cto"]),
      ).rejects.toThrow(/persona/i);
    });

    it("--remove un-indexes a document and marks it removed in DB", async () => {
      await seedExpert(env, PERSONA);
      await seedDocRow("boss", "alpha.md", 100);
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "docs", "boss", "--remove", "alpha.md"]);
      expect(captured).toMatch(/removed/i);
      expect(captured).toContain("alpha.md");

      // Verify DB row flipped to 'removed' and FTS5 index pruned.
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { DocumentRepository } =
        await import("../../../../src/memory/repositories/document-repository.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new DocumentRepository(db);
        const rows = await repo.findByExpert("boss");
        expect(rows.length).toBe(1);
        expect(rows[0]?.status).toBe("removed");
        const checksums = await repo.getChecksumMap("boss");
        expect(checksums.size).toBe(0);
        const { sql } = await import("kysely");
        const fts = (await sql<{
          c: number;
        }>`SELECT COUNT(*) AS c FROM document_index WHERE file_path = ${rows[0]?.filePath ?? ""}`.execute(
          db,
        )) as { rows: readonly { readonly c: number }[] };
        expect(fts.rows[0]?.c).toBe(0);
      } finally {
        await db.destroy();
      }
    });

    it("--remove warns and suppresses ✓ when FTS index cleanup fails (#382)", async () => {
      await seedExpert(env, PERSONA);
      await seedDocRow("boss", "alpha.md", 100);
      // Drop the FTS5 table so indexer.remove() throws when called by the CLI.
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { sql } = await import("kysely");
      const dropDb = await createDatabase(path.join(env.home, "council.db"));
      try {
        await sql`DROP TABLE document_index`.execute(dropDb);
      } finally {
        await dropDb.destroy();
      }

      let captured = "";
      let erred = "";
      const cmd = buildExpertCommand(
        (s) => {
          captured += s;
        },
        (s) => {
          erred += s;
        },
      );
      await cmd.parseAsync(["node", "council-expert", "docs", "boss", "--remove", "alpha.md"]);

      // Must NOT report success with ✓ when FTS cleanup failed.
      expect(captured).not.toContain("✓");
      // Combined output must surface the partial-failure warning.
      expect((captured + erred).toLowerCase()).toMatch(
        /fts index cleanup failed|removed from tracking but/i,
      );

      // DB row must still have been marked removed (tracking is the
      // source of truth).
      const { DocumentRepository } =
        await import("../../../../src/memory/repositories/document-repository.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const rows = await new DocumentRepository(db).findByExpert("boss");
        expect(rows[0]?.status).toBe("removed");
      } finally {
        await db.destroy();
      }
    });

    it("--remove preserves the file on disk", async () => {
      await seedExpert(env, PERSONA);
      await seedDocRow("boss", "alpha.md", 50);
      const filePath = path.join(env.dataHome, "experts", "boss", "docs", "alpha.md");
      await fs.writeFile(filePath, "actual content", "utf-8");
      const cmd = buildExpertCommand(() => {
        /* noop */
      });
      await cmd.parseAsync(["node", "council-expert", "docs", "boss", "--remove", "alpha.md"]);
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });

    it("--remove errors when file is not in the index", async () => {
      await seedExpert(env, PERSONA);
      const cmd = buildExpertCommand(
        () => {
          /* noop */
        },
        () => {
          /* noop */
        },
      );
      await expect(
        cmd.parseAsync(["node", "council-expert", "docs", "boss", "--remove", "missing.md"]),
      ).rejects.toThrow(/not found|not indexed|no such/i);
    });

    it("--remove also accepts a full file path", async () => {
      await seedExpert(env, PERSONA);
      await seedDocRow("boss", "alpha.md", 75);
      const filePath = path.join(env.dataHome, "experts", "boss", "docs", "alpha.md");
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-expert", "docs", "boss", "--remove", filePath]);
      expect(captured).toMatch(/removed/i);

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { DocumentRepository } =
        await import("../../../../src/memory/repositories/document-repository.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const rows = await new DocumentRepository(db).findByExpert("boss");
        expect(rows[0]?.status).toBe("removed");
      } finally {
        await db.destroy();
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // expert train (Roadmap 6.6)
  // ────────────────────────────────────────────────────────────────────
  describe("expert train", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    const PERSONA: ExpertDefinition = {
      slug: "boss",
      displayName: "My Boss",
      role: "VP Eng",
      expertise: { weightedEvidence: ["calibration"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "Outcome-driven",
      kind: "persona",
      personaDescription: "VP of Engineering",
    };

    async function writeDoc(slug: string, filename: string, body: string): Promise<string> {
      const docsDir = path.join(env.dataHome, "experts", slug, "docs");
      await fs.mkdir(docsDir, { recursive: true });
      const p = path.join(docsDir, filename);
      await fs.writeFile(p, body, "utf-8");
      return p;
    }

    it("rejects an unknown --engine value", async () => {
      await seedExpert(env, PERSONA);
      const cmd = buildExpertCommand(
        () => {
          /* noop */
        },
        () => {
          /* noop */
        },
        { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
      );
      cmd.exitOverride();
      for (const sub of cmd.commands) sub.exitOverride();
      await expect(
        cmd.parseAsync(["node", "council-expert", "train", "boss", "--engine", "bogus"]),
      ).rejects.toThrow(/engine|allowed choices/i);
    });

    it("reports not found when slug does not exist", async () => {
      const cmd = buildExpertCommand(
        () => {
          /* noop */
        },
        () => {
          /* noop */
        },
        { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
      );
      await expect(cmd.parseAsync(["node", "council-expert", "train", "ghost"])).rejects.toThrow(
        /not found/i,
      );
    });

    it("rejects non-persona experts", async () => {
      await seedExpert(env, SAMPLE);
      const cmd = buildExpertCommand(
        () => {
          /* noop */
        },
        () => {
          /* noop */
        },
        { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
      );
      await expect(
        cmd.parseAsync(["node", "council-expert", "train", "dahlia-cto"]),
      ).rejects.toThrow(/persona/i);
    });

    it("processes new documents and reports progress", async () => {
      await seedExpert(env, PERSONA);
      await writeDoc("boss", "intro.md", "Hello world from the boss.");
      let captured = "";
      const cmd = buildExpertCommand(
        (s) => {
          captured += s;
        },
        () => {
          /* noop */
        },
        { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
      );
      await cmd.parseAsync(["node", "council-expert", "train", "boss"]);
      expect(captured).toContain("intro.md");
      expect(captured.toLowerCase()).toMatch(/processed|trained|complete/);

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { DocumentRepository } =
        await import("../../../../src/memory/repositories/document-repository.js");
      const { ProfileRepository } =
        await import("../../../../src/memory/repositories/profile-repository.js");
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const docs = await new DocumentRepository(db).findByExpert("boss");
        expect(docs.length).toBe(1);
        expect(docs[0]?.status).toBe("processed");
        const profile = await new ProfileRepository(db).findBySlug("boss");
        expect(profile?.communicationStyle).toMatch(/terse|direct/i);
      } finally {
        await db.destroy();
      }
    });

    it("--retrain deletes the existing profile and reprocesses all docs", async () => {
      await seedExpert(env, PERSONA);
      const docPath = await writeDoc("boss", "intro.md", "First training document.");
      // First training run.
      const cmd1 = buildExpertCommand(
        () => {
          /* noop */
        },
        () => {
          /* noop */
        },
        { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
      );
      await cmd1.parseAsync(["node", "council-expert", "train", "boss"]);

      // Sanity: profile exists and doc is tracked.
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { DocumentRepository } =
        await import("../../../../src/memory/repositories/document-repository.js");
      const { ProfileRepository } =
        await import("../../../../src/memory/repositories/profile-repository.js");
      let db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const profile = await new ProfileRepository(db).findBySlug("boss");
        expect(profile).not.toBeNull();
      } finally {
        await db.destroy();
      }

      // Second run with --retrain: doc unchanged; without retrain a vanilla
      // train would skip it. Retrain must clear the profile and reprocess.
      let captured = "";
      const stub = new StubEngine([
        JSON.stringify({
          communicationStyle: "Rewritten from scratch.",
          decisionPatterns: ["fresh"],
          biases: ["fresh"],
          vocabulary: ["fresh"],
          epistemicStance: "Rebuilt.",
        }),
      ]);
      const cmd2 = buildExpertCommand(
        (s) => {
          captured += s;
        },
        () => {
          /* noop */
        },
        { engineFactory: () => stub },
      );
      await cmd2.parseAsync(["node", "council-expert", "train", "boss", "--retrain"]);
      expect(captured.toLowerCase()).toMatch(/retrain|rebuild|cleared profile/);

      db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const profile = await new ProfileRepository(db).findBySlug("boss");
        expect(profile?.communicationStyle).toMatch(/rewritten/i);
        // Document should still be tracked (re-indexed, status processed).
        const docs = await new DocumentRepository(db).findByExpert("boss");
        const active = docs.filter((d) => d.status !== "removed");
        expect(active.some((d) => d.filePath === docPath)).toBe(true);
      } finally {
        await db.destroy();
      }
      // Stub engine must have been called for the retrain analysis.
      expect(stub.sends.length).toBeGreaterThan(0);
    });

    it("--retrain aborts atomically and preserves tracking when FTS cleanup fails (#383)", async () => {
      await seedExpert(env, PERSONA);
      await writeDoc("boss", "intro.md", "First training document.");

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { DocumentRepository } =
        await import("../../../../src/memory/repositories/document-repository.js");
      const { ProfileRepository } =
        await import("../../../../src/memory/repositories/profile-repository.js");

      const filePath = path.join(env.dataHome, "experts", "boss", "docs", "intro.md");

      // Seed a baseline profile + a tracked-processed doc row so retrain
      // has something to clear, then DROP the `document_index` FTS table
      // so the indexer.removeAll() invocation inside retrain throws.
      {
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          await new ProfileRepository(db).upsert("boss", {
            communicationStyle: "Pre-existing baseline.",
            decisionPatterns: ["baseline"],
            biases: ["baseline"],
            vocabulary: ["baseline"],
            epistemicStance: "Baseline.",
            lastUpdated: new Date().toISOString(),
            documentCount: 1,
            totalWords: 4,
          });
          const repo = new DocumentRepository(db);
          const created = await repo.create({
            expertSlug: "boss",
            filePath,
            filename: "intro.md",
            checksum: "cs",
            sizeBytes: 1,
            wordCount: 4,
          });
          await repo.updateStatus(created.id, "processed", new Date().toISOString());
          const { sql } = await import("kysely");
          await sql`DROP TABLE document_index`.execute(db);
        } finally {
          await db.destroy();
        }
      }

      let captured = "";
      let erred = "";
      const cmd = buildExpertCommand(
        (s) => {
          captured += s;
        },
        (s) => {
          erred += s;
        },
        { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
      );
      await expect(
        cmd.parseAsync(["node", "council-expert", "train", "boss", "--retrain"]),
      ).rejects.toThrow(/retrain aborted/i);

      // ✓ must NOT be emitted on failure.
      expect(captured).not.toContain("✓");
      // The error must indicate the abort was atomic: profile AND
      // tracking preserved (not just the profile).
      expect(erred.toLowerCase()).toMatch(/retrain aborted/);
      expect(erred.toLowerCase()).toMatch(/profile and tracking preserved/);

      // The pre-existing profile AND tracked doc must both still be in
      // place — otherwise we'd have a partial-clear: docs marked removed
      // (or document_index rows deleted) while the profile lingers, or
      // the converse — both of which corrupt retrieval.
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const profile = await new ProfileRepository(db).findBySlug("boss");
        expect(profile?.communicationStyle).toMatch(/baseline/i);
        const docs = await new DocumentRepository(db).findByExpert("boss");
        const active = docs.filter((d) => d.status !== "removed");
        expect(active.some((d) => d.filePath === filePath)).toBe(true);
      } finally {
        await db.destroy();
      }
    });

    it("--retrain aborts and preserves the profile when a doc clear fails", async () => {
      await seedExpert(env, PERSONA);
      await writeDoc("boss", "intro.md", "First training document.");

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { DocumentRepository } =
        await import("../../../../src/memory/repositories/document-repository.js");
      const { ProfileRepository } =
        await import("../../../../src/memory/repositories/profile-repository.js");

      // Seed a baseline profile and a tracked doc row so retrain has
      // something to clear and a profile to (try to) discard.
      {
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          await new ProfileRepository(db).upsert("boss", {
            communicationStyle: "Pre-existing baseline.",
            decisionPatterns: ["baseline"],
            biases: ["baseline"],
            vocabulary: ["baseline"],
            epistemicStance: "Baseline.",
            lastUpdated: new Date().toISOString(),
            documentCount: 1,
            totalWords: 4,
          });
          const filePath = path.join(env.dataHome, "experts", "boss", "docs", "intro.md");
          const repo = new DocumentRepository(db);
          const created = await repo.create({
            expertSlug: "boss",
            filePath,
            filename: "intro.md",
            checksum: "cs",
            sizeBytes: 1,
            wordCount: 4,
          });
          await repo.updateStatus(created.id, "processed", new Date().toISOString());
        } finally {
          await db.destroy();
        }
      }

      // Force the atomic clear path to fail so the retrain reports a
      // failure and must abort BEFORE deleting the existing profile.
      // Post-#383 / #425: clearForRetrain throws a typed
      // ClearForRetrainError that flags whether the rollback succeeded.
      // Stub with rollbackFailed=false to exercise the "clean rollback,
      // existing profile + tracking preserved" branch in the CLI.
      const { ClearForRetrainError } =
        await import("../../../../src/memory/repositories/document-repository.js");
      const originalClear = DocumentRepository.prototype.clearForRetrain;
      DocumentRepository.prototype.clearForRetrain = async function (): Promise<void> {
        throw new ClearForRetrainError("simulated DB failure (rolled back cleanly)", {
          cause: new Error("simulated DB failure"),
          rollbackFailed: false,
        });
      };

      let captured = "";
      let erred = "";
      try {
        const cmd = buildExpertCommand(
          (s) => {
            captured += s;
          },
          (s) => {
            erred += s;
          },
          { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
        );
        await expect(
          cmd.parseAsync(["node", "council-expert", "train", "boss", "--retrain"]),
        ).rejects.toThrow(/retrain aborted|failed to clear/i);
      } finally {
        DocumentRepository.prototype.clearForRetrain = originalClear;
      }

      expect(erred.toLowerCase()).toMatch(/failed to clear/);
      expect(captured + erred).toMatch(/profile.*preserved/i);

      // The pre-existing profile must still be in place.
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const profile = await new ProfileRepository(db).findBySlug("boss");
        expect(profile?.communicationStyle).toMatch(/baseline/i);
      } finally {
        await db.destroy();
      }
    });

    it("--retrain warns of inconsistent state when ROLLBACK itself fails (no 'preserved' claim) (#425)", async () => {
      await seedExpert(env, PERSONA);
      await writeDoc("boss", "intro.md", "First training document.");

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { DocumentRepository, ClearForRetrainError } =
        await import("../../../../src/memory/repositories/document-repository.js");
      const { ProfileRepository } =
        await import("../../../../src/memory/repositories/profile-repository.js");

      // Seed a baseline profile + a tracked doc so retrain has work to do.
      {
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          await new ProfileRepository(db).upsert("boss", {
            communicationStyle: "Pre-existing baseline.",
            decisionPatterns: ["baseline"],
            biases: ["baseline"],
            vocabulary: ["baseline"],
            epistemicStance: "Baseline.",
            lastUpdated: new Date().toISOString(),
            documentCount: 1,
            totalWords: 4,
          });
          const filePath = path.join(env.dataHome, "experts", "boss", "docs", "intro.md");
          const repo = new DocumentRepository(db);
          const created = await repo.create({
            expertSlug: "boss",
            filePath,
            filename: "intro.md",
            checksum: "cs",
            sizeBytes: 1,
            wordCount: 4,
          });
          await repo.updateStatus(created.id, "processed", new Date().toISOString());
        } finally {
          await db.destroy();
        }
      }

      // Stub clearForRetrain to throw a ClearForRetrainError flagged
      // rollbackFailed=true so the CLI exercises its conservative
      // "state unknown" branch (#425).
      const originalClear = DocumentRepository.prototype.clearForRetrain;
      DocumentRepository.prototype.clearForRetrain = async function (): Promise<void> {
        throw new ClearForRetrainError("simulated cleanup failure AND rollback failure", {
          cause: new Error("simulated cleanup failure"),
          rollbackFailed: true,
          rollbackError: new Error("simulated ROLLBACK failure"),
        });
      };

      let captured = "";
      let erred = "";
      try {
        const cmd = buildExpertCommand(
          (s) => {
            captured += s;
          },
          (s) => {
            erred += s;
          },
          { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
        );
        await expect(
          cmd.parseAsync(["node", "council-expert", "train", "boss", "--retrain"]),
        ).rejects.toThrow(/retrain aborted|failed to clear/i);
      } finally {
        DocumentRepository.prototype.clearForRetrain = originalClear;
      }

      const combined = (captured + erred).toLowerCase();
      expect(erred.toLowerCase()).toMatch(/failed to clear/);
      expect(combined).toMatch(/inconsistent state/);
      // CRITICAL: must NOT claim preservation when rollback failed.
      expect(combined).not.toMatch(/profile.*preserved/);
      expect(combined).not.toMatch(/tracking preserved/);
    });

    // ──────────────────────────────────────────────────────────────────
    // --file / --url ingestion (T10)
    // ──────────────────────────────────────────────────────────────────

    it("--file copies the given file into the expert docs dir before training", async () => {
      await seedExpert(env, PERSONA);
      // Create a source file OUTSIDE the expert docs dir.
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-src-"));
      const srcPath = path.join(srcDir, "external-notes.md");
      await fs.writeFile(srcPath, "External notes for the boss.", "utf-8");

      let captured = "";
      const cmd = buildExpertCommand(
        (s) => {
          captured += s;
        },
        () => {
          /* noop */
        },
        { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
      );
      try {
        await cmd.parseAsync([
          "node",
          "council-expert",
          "train",
          "boss",
          "--file",
          srcPath,
        ]);
        // File copied into docs dir.
        const dest = path.join(env.dataHome, "experts", "boss", "docs", "external-notes.md");
        const body = await fs.readFile(dest, "utf-8");
        expect(body).toBe("External notes for the boss.");
        // Progress message mentions copy.
        expect(captured.toLowerCase()).toMatch(/copying|copied/);
        expect(captured).toContain("external-notes.md");
      } finally {
        await fs.rm(srcDir, { recursive: true, force: true });
      }
    });

    it("--file can be passed multiple times (variadic)", async () => {
      await seedExpert(env, PERSONA);
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-src-"));
      const a = path.join(srcDir, "a.md");
      const b = path.join(srcDir, "b.md");
      await fs.writeFile(a, "alpha", "utf-8");
      await fs.writeFile(b, "beta", "utf-8");

      const cmd = buildExpertCommand(
        () => {
          /* noop */
        },
        () => {
          /* noop */
        },
        { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
      );
      try {
        await cmd.parseAsync([
          "node",
          "council-expert",
          "train",
          "boss",
          "--file",
          a,
          "--file",
          b,
        ]);
        const docsDir = path.join(env.dataHome, "experts", "boss", "docs");
        expect(await fs.readFile(path.join(docsDir, "a.md"), "utf-8")).toBe("alpha");
        expect(await fs.readFile(path.join(docsDir, "b.md"), "utf-8")).toBe("beta");
      } finally {
        await fs.rm(srcDir, { recursive: true, force: true });
      }
    });

    it("--file errors clearly when the source file does not exist", async () => {
      await seedExpert(env, PERSONA);
      let erred = "";
      const cmd = buildExpertCommand(
        () => {
          /* noop */
        },
        (s) => {
          erred += s;
        },
        { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
      );
      const missing = path.join(env.dataHome, "does-not-exist.md");
      await expect(
        cmd.parseAsync(["node", "council-expert", "train", "boss", "--file", missing]),
      ).rejects.toThrow(/not found|no such file/i);
      expect(erred.toLowerCase()).toMatch(/not found|no such file/);
    });

    it("--url downloads content into the expert docs dir before training", async () => {
      await seedExpert(env, PERSONA);
      const body = "Downloaded report contents.";
      const fakeFetch = vi.fn(async (url: string | URL) => {
        const u = typeof url === "string" ? url : url.toString();
        expect(u).toBe("https://example.com/reports/report.md");
        return new Response(body, { status: 200, headers: { "content-type": "text/markdown" } });
      });
      vi.stubGlobal("fetch", fakeFetch);
      try {
        let captured = "";
        const cmd = buildExpertCommand(
          (s) => {
            captured += s;
          },
          () => {
            /* noop */
          },
          { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
        );
        await cmd.parseAsync([
          "node",
          "council-expert",
          "train",
          "boss",
          "--url",
          "https://example.com/reports/report.md",
        ]);
        expect(fakeFetch).toHaveBeenCalledTimes(1);
        const dest = path.join(env.dataHome, "experts", "boss", "docs", "report.md");
        expect(await fs.readFile(dest, "utf-8")).toBe(body);
        expect(captured.toLowerCase()).toMatch(/download/);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("--url errors clearly when the fetch fails with a non-OK status", async () => {
      await seedExpert(env, PERSONA);
      const fakeFetch = vi.fn(
        async () => new Response("nope", { status: 404, statusText: "Not Found" }),
      );
      vi.stubGlobal("fetch", fakeFetch);
      try {
        let erred = "";
        const cmd = buildExpertCommand(
          () => {
            /* noop */
          },
          (s) => {
            erred += s;
          },
          { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
        );
        await expect(
          cmd.parseAsync([
            "node",
            "council-expert",
            "train",
            "boss",
            "--url",
            "https://example.com/missing.md",
          ]),
        ).rejects.toThrow(/404|failed to (download|fetch)/i);
        expect(erred.toLowerCase()).toMatch(/404|failed to (download|fetch)/);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("--url rejects non-http(s) URLs", async () => {
      await seedExpert(env, PERSONA);
      let erred = "";
      const cmd = buildExpertCommand(
        () => {
          /* noop */
        },
        (s) => {
          erred += s;
        },
        { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
      );
      await expect(
        cmd.parseAsync([
          "node",
          "council-expert",
          "train",
          "boss",
          "--url",
          "file:///etc/passwd",
        ]),
      ).rejects.toThrow(/http|url/i);
      expect(erred.toLowerCase()).toMatch(/http|url/);
    });

    it("--url redacts userinfo and query string from progress and error logs", async () => {
      await seedExpert(env, PERSONA);
      const sensitive = "https://user:secrettoken@example.com/reports/report.md?sig=abc123";
      const fakeFetch = vi.fn(async () => new Response("nope", { status: 500 }));
      vi.stubGlobal("fetch", fakeFetch);
      try {
        let captured = "";
        let erred = "";
        const cmd = buildExpertCommand(
          (s) => {
            captured += s;
          },
          (s) => {
            erred += s;
          },
          { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
        );
        await expect(
          cmd.parseAsync(["node", "council-expert", "train", "boss", "--url", sensitive]),
        ).rejects.toThrow();
        const all = captured + erred;
        expect(all).not.toContain("secrettoken");
        expect(all).not.toContain("abc123");
        expect(all).not.toContain("user:");
        expect(all).toContain("example.com");
        expect(all).toContain("report.md");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("does not orphan a --file when a later --url input fails (atomic ingestion, F14)", async () => {
      await seedExpert(env, PERSONA);
      // A valid local file is passed alongside a URL that 404s. The file
      // must NOT be left orphaned in the docs dir when ingestion aborts.
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-src-"));
      const srcPath = path.join(srcDir, "good-notes.md");
      await fs.writeFile(srcPath, "Good notes for the boss.", "utf-8");

      const fakeFetch = vi.fn(
        async () => new Response("nope", { status: 404, statusText: "Not Found" }),
      );
      vi.stubGlobal("fetch", fakeFetch);
      try {
        let erred = "";
        const cmd = buildExpertCommand(
          () => {
            /* noop */
          },
          (s) => {
            erred += s;
          },
          { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
        );
        await expect(
          cmd.parseAsync([
            "node",
            "council-expert",
            "train",
            "boss",
            "--file",
            srcPath,
            "--url",
            "https://example.com/missing.md",
          ]),
        ).rejects.toThrow(/404|failed to (download|fetch)/i);
        expect(erred.toLowerCase()).toMatch(/404|failed to (download|fetch)/);

        // No orphaned file: the valid file must not have landed in docs.
        const docsDir = path.join(env.dataHome, "experts", "boss", "docs");
        const entries = await fs.readdir(docsDir).catch(() => [] as string[]);
        expect(entries).not.toContain("good-notes.md");
        // And no other (non-dot) files were committed either.
        expect(entries.filter((e) => !e.startsWith("."))).toEqual([]);

        // Training never recorded any document for the expert.
        const { createDatabase } = await import("../../../../src/memory/db.js");
        const { DocumentRepository } = await import(
          "../../../../src/memory/repositories/document-repository.js"
        );
        const db = await createDatabase(path.join(env.home, "council.db"));
        try {
          const docs = await new DocumentRepository(db).findByExpert("boss");
          expect(docs.length).toBe(0);
        } finally {
          await db.destroy();
        }
      } finally {
        vi.unstubAllGlobals();
        await fs.rm(srcDir, { recursive: true, force: true });
      }
    });

    it("--url rejects responses whose Content-Length exceeds the size cap", async () => {
      await seedExpert(env, PERSONA);
      const tooBig = 100 * 1024 * 1024; // 100 MB
      const fakeFetch = vi.fn(
        async () =>
          new Response("x", {
            status: 200,
            headers: { "content-length": String(tooBig) },
          }),
      );
      vi.stubGlobal("fetch", fakeFetch);
      try {
        let erred = "";
        const cmd = buildExpertCommand(
          () => {
            /* noop */
          },
          (s) => {
            erred += s;
          },
          { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
        );
        await expect(
          cmd.parseAsync([
            "node",
            "council-expert",
            "train",
            "boss",
            "--url",
            "https://example.com/huge.md",
          ]),
        ).rejects.toThrow(/exceeds|too large|size/i);
        expect(erred.toLowerCase()).toMatch(/exceeds|too large|size/);
        // Destination file must not be left behind.
        const dest = path.join(env.dataHome, "experts", "boss", "docs", "huge.md");
        await expect(fs.access(dest)).rejects.toBeTruthy();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // F15: training summary counter wording
    // ──────────────────────────────────────────────────────────────────

    it(
      "training summary labels skipped (already-trained) count unambiguously from newly-processed (F15)",
      { timeout: 30_000 },
      async () => {
        await seedExpert(env, PERSONA);
        // First run: ingest existing.md so it becomes "already up to date" on
        // the next run.
        await writeDoc("boss", "existing.md", "Previously trained content.");
        const cmd1 = buildExpertCommand(
          () => {
            /* noop */
          },
          () => {
            /* noop */
          },
          { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
        );
        await cmd1.parseAsync(["node", "council-expert", "train", "boss"]);

        // Second run: new.md is new (filesProcessed ≥ 1); existing.md is
        // unchanged (filesSkipped ≥ 1).  The summary must NOT use the old
        // misleading "(N unchanged)" placement adjacent to "Processed N".
        await writeDoc("boss", "new.md", "Brand new content for second run.");
        let captured = "";
        const cmd2 = buildExpertCommand(
          (s) => {
            captured += s;
          },
          () => {
            /* noop */
          },
          { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
        );
        await cmd2.parseAsync(["node", "council-expert", "train", "boss"]);

        // Must use clear "already up to date" label for skipped count.
        expect(captured).toMatch(/already up to date/i);
        // Old "(N unchanged)" parenthetical must be gone.
        expect(captured).not.toMatch(/\(\d+ unchanged/);
      },
    );

    // F21: --url format hint
    // ──────────────────────────────────────────────────────────────────

    it("--url help text accurately describes the supported-extension constraint (F21)", () => {
      const train = buildExpertCommand().commands.find((c) => c.name() === "train");
      const help = train?.helpInformation() ?? "";
      expect(help).toMatch(/supported file extension/i);
      // The corrected hint must NOT falsely claim HTML is unsupported.
      expect(help).not.toMatch(/HTML pages are not/i);
    });

    it(
      "--url fetch-failure error includes the supported-extension constraint hint (F21)",
      { timeout: 30_000 },
      async () => {
        await seedExpert(env, PERSONA);
        const fakeFetch = vi.fn(
          async () => new Response("Not Found", { status: 404, statusText: "Not Found" }),
        );
        vi.stubGlobal("fetch", fakeFetch);
        try {
          let erred = "";
          const cmd = buildExpertCommand(
            () => {
              /* noop */
            },
            (s) => {
              erred += s;
            },
            { engineFactory: () => new StubEngine([STUB_PROFILE_JSON]) },
          );
          await expect(
            cmd.parseAsync([
              "node",
              "council-expert",
              "train",
              "boss",
              "--url",
              "https://example.com/page.html",
            ]),
          ).rejects.toThrow(/404|failed to (download|fetch)/i);
          expect(erred).toMatch(/supported file extension/i);
          expect(erred).not.toMatch(/HTML pages are not/i);
        } finally {
          vi.unstubAllGlobals();
        }
      },
    );
  });
});
