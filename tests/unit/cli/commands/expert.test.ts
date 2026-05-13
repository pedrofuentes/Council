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
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../../src/engine/index.js";

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
    expect(subs).toEqual(["create", "delete", "docs", "edit", "inspect", "list", "train"].sort());
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
      await expect(cmd.parseAsync(["node", "council-expert", "inspect", "nobody"])).rejects.toThrow(
        /not found/i,
      );
      expect(errored + captured).toMatch(/not found|nobody/i);
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
      await cmd.parseAsync(["node", "council-expert", "delete", "dahlia-cto", "--force"]);
      expect(captured).toMatch(/deleted/i);
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

    async function seedDocRow(
      slug: string,
      filename: string,
      wordCount: number,
    ): Promise<void> {
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { DocumentRepository } = await import(
        "../../../../src/memory/repositories/document-repository.js"
      );
      const { createDocumentIndexer } = await import(
        "../../../../src/core/documents/indexer.js"
      );
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
      await cmd.parseAsync([
        "node",
        "council-expert",
        "docs",
        "boss",
        "--remove",
        "alpha.md",
      ]);
      expect(captured).toMatch(/removed/i);
      expect(captured).toContain("alpha.md");

      // Verify DB row flipped to 'removed' and FTS5 index pruned.
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { DocumentRepository } = await import(
        "../../../../src/memory/repositories/document-repository.js"
      );
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
      await cmd.parseAsync([
        "node",
        "council-expert",
        "docs",
        "boss",
        "--remove",
        "alpha.md",
      ]);

      // Must NOT report success with ✓ when FTS cleanup failed.
      expect(captured).not.toContain("✓");
      // Combined output must surface the partial-failure warning.
      expect((captured + erred).toLowerCase()).toMatch(
        /fts index cleanup failed|removed from tracking but/i,
      );

      // DB row must still have been marked removed (tracking is the
      // source of truth).
      const { DocumentRepository } = await import(
        "../../../../src/memory/repositories/document-repository.js"
      );
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
      await cmd.parseAsync([
        "node",
        "council-expert",
        "docs",
        "boss",
        "--remove",
        "alpha.md",
      ]);
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
        cmd.parseAsync([
          "node",
          "council-expert",
          "docs",
          "boss",
          "--remove",
          "missing.md",
        ]),
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
      await cmd.parseAsync([
        "node",
        "council-expert",
        "docs",
        "boss",
        "--remove",
        filePath,
      ]);
      expect(captured).toMatch(/removed/i);

      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { DocumentRepository } = await import(
        "../../../../src/memory/repositories/document-repository.js"
      );
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
      await expect(
        cmd.parseAsync([
          "node",
          "council-expert",
          "train",
          "boss",
          "--engine",
          "bogus",
        ]),
      ).rejects.toThrow(/engine/i);
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
      const { DocumentRepository } = await import(
        "../../../../src/memory/repositories/document-repository.js"
      );
      const { ProfileRepository } = await import(
        "../../../../src/memory/repositories/profile-repository.js"
      );
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
      const { DocumentRepository } = await import(
        "../../../../src/memory/repositories/document-repository.js"
      );
      const { ProfileRepository } = await import(
        "../../../../src/memory/repositories/profile-repository.js"
      );
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
      const { DocumentRepository } = await import(
        "../../../../src/memory/repositories/document-repository.js"
      );
      const { ProfileRepository } = await import(
        "../../../../src/memory/repositories/profile-repository.js"
      );

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
      const { DocumentRepository } = await import(
        "../../../../src/memory/repositories/document-repository.js"
      );
      const { ProfileRepository } = await import(
        "../../../../src/memory/repositories/profile-repository.js"
      );

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

      // Force the bulk-clear path to fail so the retrain reports a
      // failure and must abort BEFORE deleting the existing profile.
      // Post-#383 the cli uses DocumentRepository.markAllRemovedByExpert
      // (single bulk SQL UPDATE) instead of a per-row markRemoved loop.
      const originalMarkAll =
        DocumentRepository.prototype.markAllRemovedByExpert;
      DocumentRepository.prototype.markAllRemovedByExpert =
        async function (): Promise<void> {
          throw new Error("simulated DB failure");
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
        DocumentRepository.prototype.markAllRemovedByExpert = originalMarkAll;
      }

      expect(erred.toLowerCase()).toMatch(/failed to clear/);
      expect(captured + erred).toMatch(/profile preserved/i);

      // The pre-existing profile must still be in place.
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const profile = await new ProfileRepository(db).findBySlug("boss");
        expect(profile?.communicationStyle).toMatch(/baseline/i);
      } finally {
        await db.destroy();
      }
    });
  });
});
