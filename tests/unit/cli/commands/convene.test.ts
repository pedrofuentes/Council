/**
 * Tests for `council convene <topic>` (ROADMAP §1.10 + §3.1 wiring).
 *
 * The convene command is the primary way users run a panel debate. It:
 *
 *   1. Loads a built-in panel template (--template <name>)
 *   2. Builds expert system prompts via prompt-builder
 *   3. Creates panel + expert rows in the local SQLite DB
 *   4. Constructs a Debate over the chosen engine
 *   5. Wraps Debate.run() in a DebatePersister (writes turns as they stream)
 *   6. Hands the persisted event stream to the chosen Renderer
 *
 * Tests inject a MockEngine via the engineFactory option so the command
 * can be exercised end-to-end without hitting the Copilot SDK or any
 * network.
 *
 * RED at this commit: src/cli/commands/convene.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine, ExpertSpec } from "../../../../src/engine/index.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";

describe("buildConveneCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-convene-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  function makeMockEngineFactory(): () => CouncilEngine {
    return () =>
      new MockEngine({
        // Generic mock responses keyed at runtime by inserted expert id.
        // The MockEngine returns a default response when the id is unknown.
        responses: {},
      });
  }

  it("registers a 'convene' command with topic positional arg and optional --template", () => {
    const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });
    expect(cmd.name()).toBe("convene");
    expect(cmd.description()).toMatch(/panel|debate/i);
    const templateOpt = cmd.options.find((o) => o.long === "--template");
    expect(templateOpt).toBeDefined();
    // Commander's `mandatory` flag is what `requiredOption()` flips;
    // `required` only refers to whether the option's argument value is
    // required (which it is, for `<name>`).
    expect(templateOpt?.mandatory).toBe(false);
  });

  it("supports --format json|plain, --max-rounds, --mode, --max-words options", () => {
    const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--format");
    expect(longs).toContain("--max-rounds");
    expect(longs).toContain("--mode");
    expect(longs).toContain("--max-words");
  });

  it("end-to-end: creates panel, experts, debate row, and turn rows from a built-in template", async () => {
    let captured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we ship the MVP?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    // Inspect the DB to verify side effects.
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(1);
      expect(panels[0]?.topic).toBe("Should we ship the MVP?");
      const panelId = panels[0]?.id ?? "";

      const experts = await new ExpertRepository(db).findByPanelId(panelId);
      expect(experts.length).toBeGreaterThanOrEqual(2);
      // System prompt should be the fully-rendered 8-section template.
      for (const e of experts) {
        expect(e.systemMessage).toContain("[1] IDENTITY");
        expect(e.systemMessage).toContain("[8] CURRENT TASK");
      }

      const debates = await new DebateRepository(db).findByPanelId(panelId);
      expect(debates).toHaveLength(1);
      expect(debates[0]?.status).toBe("completed");
      const debateId = debates[0]?.id ?? "";

      const turns = await new TurnRepository(db).findByDebateId(debateId);
      // 1 round × N experts.
      expect(turns.length).toBe(experts.length);
    } finally {
      await db.destroy();
    }

    // --format json: every line of stdout (excluding the MOCK warning sent
    // to the writer) should be valid JSON.
    const lines = captured
      .split("\n")
      .filter((l) => l.trim().length > 0 && l.trim().startsWith("{"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const parsed = lines.map((l) => JSON.parse(l) as { kind: string });
    const kinds = parsed.map((p) => p.kind);
    expect(kinds[0]).toBe("panel.assembled");
    expect(kinds).toContain("turn.end");
    expect(kinds[kinds.length - 1]).toBe("debate.end");
  });

  it("end-to-end with --format plain: produces human-readable output", async () => {
    let captured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Topic",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);

    expect(captured.length).toBeGreaterThan(0);
    // Plain format should NOT be parseable as JSON per line.
    expect(captured).not.toMatch(/^\{/);
    // Should mention the panel topic somewhere.
    expect(captured).toContain("Topic");
  });

  it("uses config.defaults.model (not hardcoded DEFAULT_MODEL) for expert registration", async () => {
    // Write a config file that overrides the default model
    const configPath = path.join(testHome, "config.yaml");
    await fs.writeFile(configPath, "defaults:\n  model: test-custom-model\n");

    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Test topic",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);

    // Check the DB — expert rows should have the config model, not the hardcoded one
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      const experts = await new ExpertRepository(db).findByPanelId(panels[0]?.id ?? "");
      expect(experts.length).toBeGreaterThan(0);
      for (const e of experts) {
        expect(e.model).toBe("test-custom-model");
      }
    } finally {
      await db.destroy();
    }
  });

  it("respects --mode structured (4-phase choreography)", async () => {
    let captured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "topic",
      "--template",
      "code-review",
      "--mode",
      "structured",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    const lines = captured
      .split("\n")
      .filter((l) => l.trim().length > 0 && l.trim().startsWith("{"));
    const phases = lines
      .map((l) => JSON.parse(l) as { kind: string; phase?: string })
      .filter((e) => e.kind === "round.start")
      .map((e) => e.phase);
    expect(phases).toEqual(["opening", "cross-examination", "rebuttal", "synthesis"]);
  });

  it("rejects unknown templates with a non-zero exit", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });
    cmd.exitOverride();

    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "topic",
        "--template",
        "this-template-definitely-does-not-exist",
        "--engine",
        "mock",
      ]),
    ).rejects.toThrow();
  });

  it("uses config.defaults.engine when --engine is omitted and shows the mock banner", async () => {
    await fs.writeFile(path.join(testHome, "config.yaml"), "defaults:\n  engine: mock\n", "utf-8");
    let stderrCaptured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (chunk) => {
        stderrCaptured += chunk;
      },
    });

    await cmd.parseAsync(["node", "council-convene", "topic", "--template", "code-review"]);

    expect(stderrCaptured).toContain("[MOCK ENGINE]");
  });

  it("--engine copilot returns a CopilotEngine instance (helper)", async () => {
    // The exported helper is the indirection used by the action; tests
    // verify wiring without actually invoking the engine (which would
    // require a real Copilot session). End-to-end Copilot exercise lives
    // in tests/integration/convene-copilot.test.ts (gated by env var).
    const { makeEngineFromKind } = await import("../../../../src/cli/commands/convene.js");
    const { CopilotEngine } = await import("../../../../src/engine/copilot/adapter.js");
    const engine = makeEngineFromKind("copilot");
    expect(engine).toBeInstanceOf(CopilotEngine);
  });

  it("--engine mock prints a prominent MOCK warning to a separate writeError channel (NOT stdout)", async () => {
    let stdoutCaptured = "";
    let stderrCaptured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        stdoutCaptured += s;
      },
      writeError: (s) => {
        stderrCaptured += s;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "topic",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    // The MOCK warning must NOT pollute the JSON stream on stdout. JSON
    // consumers parse stdout as NDJSON; an inlined warning breaks that.
    // Every non-empty line of stdout must start with `{` (NDJSON purity).
    const stdoutLines = stdoutCaptured.split("\n").filter((l) => l.trim().length > 0);
    expect(stdoutLines.length).toBeGreaterThan(0);
    for (const line of stdoutLines) {
      expect(line.trim().startsWith("{")).toBe(true);
    }

    // The MOCK warning lives on the error channel.
    expect(stderrCaptured.toUpperCase()).toContain("MOCK");
  });

  it("--engine mock tags the persisted debate config with mock=true", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "topic",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(1);
      const config = JSON.parse(panels[0]?.configJson ?? "{}") as { engine?: string };
      expect(config.engine).toBe("mock");
    } finally {
      await db.destroy();
    }
  });

  describe("makeEngineFromKind exhaustiveness (Sentinel pr132 #134)", () => {
    it("throws clearly when called with an unknown kind", async () => {
      const { makeEngineFromKind } = await import("../../../../src/cli/commands/convene.js");
      // Cast to bypass TS exhaustiveness — simulates a future engine kind
      // added to ConveneEngineKind without a matching switch case.
      expect(() => makeEngineFromKind("anthropic-direct" as unknown as "mock")).toThrowError(
        /unknown.*engine.*kind/i,
      );
    });
  });

  describe("--engine validation (Sentinel pr125 #129)", () => {
    it("rejects an unknown --engine value with a clear error", async () => {
      const cmd = buildConveneCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync([
          "node",
          "council-convene",
          "topic",
          "--template",
          "code-review",
          "--engine",
          "anthropic-direct",
        ]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown.toLowerCase()).toMatch(/anthropic-direct|engine.*value|engine.*expected|allowed choices/);
    });
  });

  // ── T1 (context-bleed fix) — recall removed for fresh convene ─────
  // Previously (Sentinel pr222 cycle 3) convene loaded prior-panel
  // memory into the new expert's system prompt. That caused round 2+
  // of new debates to bleed unrelated prior-debate content. The recall
  // path is now removed for `convene`; `resume` is unaffected.

  describe("no context bleed across sequential convene runs (T1)", () => {
    it("does NOT inject prior same-template panel turns into the new expert system prompt", async () => {
      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panel = await new PanelRepository(db).create({
          name: "prior-cr-panel",
          topic: "old topic",
          copilotHome: path.join(testHome, "copilot"),
          configJson: JSON.stringify({ template: "code-review", engine: "copilot" }),
        });
        const senior = await new ExpertRepository(db).create({
          panelId: panel.id,
          slug: "senior",
          displayName: "Senior",
          model: "claude-sonnet-4",
          systemMessage: "(prior system prompt)",
        });
        const debate = await new DebateRepository(db).create({
          panelId: panel.id,
          prompt: "old topic",
          moderator: "round-robin",
        });
        await new TurnRepository(db).create({
          debateId: debate.id,
          round: 1,
          seq: 1,
          speakerKind: "expert",
          expertId: senior.id,
          content: "DISTINCTIVE_RECALL_MARKER_ALPHA — we should adopt microservices for billing.",
        });
        await new DebateRepository(db).update(debate.id, {
          status: "completed",
          endedAt: new Date().toISOString(),
        });
      } finally {
        await db.destroy();
      }

      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
      });
      await cmd.parseAsync([
        "node",
        "council-convene",
        "new topic",
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]);

      const db2 = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panels = await new PanelRepository(db2).findAll();
        const newPanel = panels.find((p) => p.name !== "prior-cr-panel");
        expect(newPanel).toBeDefined();
        const experts = await new ExpertRepository(db2).findByPanelId(newPanel?.id ?? "");
        const newSenior = experts.find((e) => e.slug === "senior");
        expect(newSenior).toBeDefined();
        // Prior-debate content must NOT bleed into the new expert prompt.
        expect(newSenior?.systemMessage).not.toContain("DISTINCTIVE_RECALL_MARKER_ALPHA");
        expect(newSenior?.systemMessage).not.toContain("microservices");
      } finally {
        await db2.destroy();
      }
    });

    it("does NOT bleed content from either mock or real prior panels of the same template", async () => {
      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panelRepo = new PanelRepository(db);
        const expertRepo = new ExpertRepository(db);
        const debateRepo = new DebateRepository(db);
        const turnRepo = new TurnRepository(db);

        async function seedPanel(
          name: string,
          engineKind: "mock" | "copilot",
          marker: string,
        ): Promise<void> {
          const p = await panelRepo.create({
            name,
            topic: "x",
            copilotHome: path.join(testHome, "copilot"),
            configJson: JSON.stringify({ template: "code-review", engine: engineKind }),
          });
          const e = await expertRepo.create({
            panelId: p.id,
            slug: "senior",
            displayName: "Senior",
            model: "claude-sonnet-4",
            systemMessage: "(prior)",
          });
          const d = await debateRepo.create({
            panelId: p.id,
            prompt: "x",
            moderator: "round-robin",
          });
          await turnRepo.create({
            debateId: d.id,
            round: 1,
            seq: 1,
            speakerKind: "expert",
            expertId: e.id,
            content: `${marker} stance.`,
          });
          await debateRepo.update(d.id, {
            status: "completed",
            endedAt: new Date().toISOString(),
          });
        }

        await seedPanel("real-prior", "copilot", "REAL_ONLY_MARKER");
        await new Promise((r) => setTimeout(r, 5));
        await seedPanel("mock-prior", "mock", "MOCK_ONLY_MARKER");
      } finally {
        await db.destroy();
      }

      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
      });
      await cmd.parseAsync([
        "node",
        "council-convene",
        "new topic",
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]);

      const db2 = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panels = await new PanelRepository(db2).findAll();
        const newPanel = panels.find((p) => p.name !== "real-prior" && p.name !== "mock-prior");
        expect(newPanel).toBeDefined();
        const experts = await new ExpertRepository(db2).findByPanelId(newPanel?.id ?? "");
        const senior = experts.find((e) => e.slug === "senior");
        expect(senior).toBeDefined();
        // NEITHER prior marker may bleed into the new expert prompt.
        expect(senior?.systemMessage).not.toContain("MOCK_ONLY_MARKER");
        expect(senior?.systemMessage).not.toContain("REAL_ONLY_MARKER");
      } finally {
        await db2.destroy();
      }
    });
  });
});

// Type guard so typescript-eslint is happy with the intentionally-unused import.
void (null as unknown as ExpertSpec);

/**
 * Tests for user-panel slug resolution (Roadmap 4.2 / Sentinel #291 cycle 2).
 *
 * A user panel YAML in `<dataHome>/panels/<name>.yaml` may reference experts
 * by slug (looked up in the FileExpertLibrary) or define them inline.
 * `convene --template <name>` must:
 *   - prefer user panels over built-in templates
 *   - resolve slug references against the library before assembling the panel
 *   - emit a clear error when a referenced slug is not in the library
 */
describe("buildConveneCommand — user panels with slug references", () => {
  let testHome: string;
  let testDataHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-convene-slug-test-"));
    testDataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-convene-data-"));
    originalHome = process.env["COUNCIL_HOME"];
    originalDataHome = process.env["COUNCIL_DATA_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    process.env["COUNCIL_DATA_HOME"] = testDataHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    for (const dir of [testHome, testDataHome]) {
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* best effort */
      }
    }
  });

  function makeMockEngineFactory(): () => CouncilEngine {
    return () => new MockEngine({ responses: {} });
  }

  async function seedLibraryExpert(slug: string, displayName: string): Promise<void> {
    const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const library = new FileExpertLibrary(testDataHome, db);
      await library.create({
        slug,
        displayName,
        role: `${displayName} role`,
        model: "gpt-4o",
        expertise: {
          weightedEvidence: [`${displayName} domain evidence`],
          referenceCases: [],
          notExpertIn: [],
        },
        epistemicStance: `${displayName} stance grounded in domain reasoning.`,
        kind: "generic",
      });
    } finally {
      await db.destroy();
    }
  }

  async function writeUserPanel(name: string, body: string): Promise<void> {
    const panelsDir = path.join(testDataHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(path.join(panelsDir, `${name}.yaml`), body, "utf-8");
  }

  it("resolves slug references in a user panel against the expert library", async () => {
    await seedLibraryExpert("library-alpha", "LibraryAlpha");
    await seedLibraryExpert("library-beta", "LibraryBeta");
    await writeUserPanel(
      "my-team",
      [
        "name: my-team",
        "description: User panel referencing library experts by slug",
        "experts:",
        "  - library-alpha",
        "  - library-beta",
        "",
      ].join("\n"),
    );

    let captured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Slug-resolution topic",
      "--template",
      "my-team",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    // The debate must have actually run — the slug-resolution code path
    // assembles a real panel that the engine drives to completion.
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(1);
      const panelId = panels[0]?.id ?? "";
      const experts = await new ExpertRepository(db).findByPanelId(panelId);
      // Two slug refs in the user panel → two resolved experts on the debate.
      expect(experts.map((e) => e.slug).sort()).toEqual(["library-alpha", "library-beta"]);
    } finally {
      await db.destroy();
    }

    // panel.assembled must be the first emitted event — confirms the
    // command path reached the engine, not just YAML parsing.
    const firstLine = captured.split("\n").find((l) => l.trim().startsWith("{"));
    expect(firstLine).toBeDefined();
    const firstEvent = JSON.parse(firstLine ?? "{}") as { kind: string };
    expect(firstEvent.kind).toBe("panel.assembled");
  });

  it("panel defaults.model is used when expert has no model override", async () => {
    await fs.writeFile(path.join(testHome, "config.yaml"), "defaults:\n  model: global-model\n");
    await writeUserPanel(
      "panel-default-model",
      [
        "name: panel-default-model",
        "defaults:",
        "  model: panel-model",
        "experts:",
        "  - slug: alpha",
        "    displayName: Alpha",
        "    role: Alpha role",
        "    expertise:",
        "      weightedEvidence:",
        "        - alpha evidence",
        "    epistemicStance: Empirical",
        "  - slug: beta",
        "    displayName: Beta",
        "    role: Beta role",
        "    expertise:",
        "      weightedEvidence:",
        "        - beta evidence",
        "    epistemicStance: Empirical",
        "",
      ].join("\n"),
    );

    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Panel default model topic",
      "--template",
      "panel-default-model",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      const experts = await new ExpertRepository(db).findByPanelId(panels[0]?.id ?? "");
      expect(experts.length).toBe(2);
      for (const expert of experts) {
        expect(expert.model).toBe("panel-model");
      }
    } finally {
      await db.destroy();
    }
  });

  it("expert.model overrides panel defaults.model in model resolution", async () => {
    await fs.writeFile(path.join(testHome, "config.yaml"), "defaults:\n  model: global-model\n");
    await writeUserPanel(
      "expert-override-test",
      [
        "name: expert-override-test",
        "defaults:",
        "  model: panel-model",
        "experts:",
        "  - slug: no-override",
        "    displayName: No Override",
        "    role: test",
        "    expertise:",
        "      weightedEvidence: [x]",
        "    epistemicStance: neutral",
        "  - slug: has-override",
        "    displayName: Has Override",
        "    role: test",
        "    model: expert-specific-model",
        "    expertise:",
        "      weightedEvidence: [x]",
        "    epistemicStance: neutral",
        "",
      ].join("\n"),
    );

    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });
    await cmd.parseAsync([
      "node",
      "council-convene",
      "Test topic",
      "--template",
      "expert-override-test",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      const experts = await new ExpertRepository(db).findByPanelId(panels[0]?.id ?? "");
      const noOverride = experts.find((e) => e.slug === "no-override");
      const hasOverride = experts.find((e) => e.slug === "has-override");
      expect(noOverride?.model).toBe("panel-model");
      expect(hasOverride?.model).toBe("expert-specific-model");
    } finally {
      await db.destroy();
    }
  });

  it("emits a clear error when a slug reference is not in the library", async () => {
    await seedLibraryExpert("library-known", "Known");
    await writeUserPanel(
      "broken-team",
      ["name: broken-team", "experts:", "  - library-known", "  - library-missing", ""].join("\n"),
    );

    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });
    cmd.exitOverride();

    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "topic",
        "--template",
        "broken-team",
        "--engine",
        "mock",
      ]),
    ).rejects.toThrow(/not in the library.*library-missing.*council expert create/s);
  });
});
