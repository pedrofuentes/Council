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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
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
    setQuiet(false);
    vi.restoreAllMocks();
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

  describe("SIGINT interrupt handling (T6)", () => {
    it("registers a SIGINT handler via subscribeInterrupt for the debate", async () => {
      let subscribed = false;
      let unsubscribed = false;
      let capturedHandler: (() => void) | undefined;
      const subscribeInterrupt = (handler: () => void): (() => void) => {
        subscribed = true;
        capturedHandler = handler;
        return () => {
          unsubscribed = true;
        };
      };

      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: () => undefined,
        subscribeInterrupt,
      });

      await cmd.parseAsync([
        "node",
        "council-convene",
        "topic",
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--format",
        "json",
        "--engine",
        "mock",
      ]);

      expect(subscribed).toBe(true);
      expect(typeof capturedHandler).toBe("function");
      expect(unsubscribed).toBe(true);
    });

    it("aborts the debate and writes an interrupted message when SIGINT fires", async () => {
      let captured = "";
      let errored = "";
      let unsubscribed = false;
      // Fire the handler synchronously the moment it's registered — this
      // simulates Ctrl+C arriving the instant the debate starts. The
      // AbortController short-circuits debate.run before any turn runs.
      const subscribeInterrupt = (handler: () => void): (() => void) => {
        handler();
        return () => {
          unsubscribed = true;
        };
      };

      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          captured += s;
        },
        writeError: (s) => {
          errored += s;
        },
        subscribeInterrupt,
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

      // Debate emitted debate.end with reason: "aborted" — partial
      // results (the panel.assembled event + the debate row) are
      // persisted; no turns ran.
      const lines = captured
        .split("\n")
        .filter((l) => l.trim().length > 0 && l.trim().startsWith("{"))
        .map((l) => JSON.parse(l) as { kind: string; reason?: string });
      const end = lines.find((e) => e.kind === "debate.end");
      expect(end).toBeDefined();
      expect(end?.reason).toBe("aborted");

      // User-facing message routed to stderr (so JSON stdout stays clean).
      expect(errored).toMatch(/interrupted/i);
      expect(errored).toMatch(/partial/i);

      // Listener was unsubscribed even though debate was interrupted —
      // covers both Sentinel pr769 finding 1 (no leaked listener on
      // setup failure) and finding 2 (self-unsubscribe in handler).
      expect(unsubscribed).toBe(true);

      // Partial results saved: the panel row + the debate row exist,
      // and the debate row is in a terminal `aborted` state (not stuck
      // at `running`). DebatePersister maps reason "aborted" → status
      // "aborted" — this assertion locks in that contract.
      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panels = await new PanelRepository(db).findAll();
        expect(panels).toHaveLength(1);
        const debates = await new DebateRepository(db).findByPanelId(panels[0]?.id ?? "");
        expect(debates).toHaveLength(1);
        expect(debates[0]?.status).toBe("aborted");
        expect(debates[0]?.endedAt).toBeTruthy();
      } finally {
        await db.destroy();
      }
    });
    it("unsubscribes the SIGINT handler even if setup throws before the debate runs", async () => {
      // Regression for Sentinel pr769 finding 1: any throw on the
      // setup path AFTER the SIGINT handler is subscribed must not
      // leak the process-level listener. We trigger the literal
      // finding-1 scenario — a throw from inside the expertRepo.create
      // loop, which is now inside the protected `try { ... } finally
      // { unsubscribeInterrupt() }` block (it was NOT in commit b07f02b,
      // hence the original leak).
      //
      // Mechanism: two `--human` participants with the same display
      // name slugify to the same slug. The first expertRepo.create
      // for the human succeeds; the second violates UNIQUE(panel_id,
      // slug) (see src/memory/migrations/001_init.sql) and throws
      // inside the setup loop, well before `runWithEngine` is reached.
      let subscribed = false;
      let unsubscribed = false;
      const subscribeInterrupt = (_handler: () => void): (() => void) => {
        subscribed = true;
        return () => {
          unsubscribed = true;
        };
      };

      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: () => undefined,
        subscribeInterrupt,
      });

      await expect(
        cmd.parseAsync([
          "node",
          "council-convene",
          "topic",
          "--template",
          "code-review",
          "--engine",
          "mock",
          "--human",
          "Alex",
          "--human",
          "Alex",
        ]),
      ).rejects.toThrow();

      expect(subscribed).toBe(true);
      // The critical assertion: even though expertRepo.create threw
      // mid-loop (before runWithEngine started), the finally block
      // fired and the listener was removed. Against commit b07f02b
      // (which put the subscribe INSIDE a narrower try wrapping only
      // runWithEngine) this assertion is false — the listener leaks.
      expect(unsubscribed).toBe(true);
    });
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

  it("suppresses the mock banner when quiet mode is enabled", async () => {
    setQuiet(true);
    let stderrCaptured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (chunk) => {
        stderrCaptured += chunk;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "topic",
      "--template",
      "code-review",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    expect(stderrCaptured).not.toContain("[MOCK ENGINE]");
  });

  it("suppresses auto-compose informational messages when quiet mode is enabled", async () => {
    setQuiet(true);
    let stdoutCaptured = "";
    let stderrCaptured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: (chunk) => {
        stdoutCaptured += chunk;
      },
      writeError: (chunk) => {
        stderrCaptured += chunk;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "topic",
      "--engine",
      "mock",
      "--format",
      "json",
      "--max-rounds",
      "1",
      "--yes",
      "--heuristic-memory",
    ]);

    expect(stderrCaptured).not.toContain("Auto-composed panel:");
    expect(stderrCaptured).not.toContain("[MOCK ENGINE]");
    expect(stdoutCaptured).toContain('"kind":"debate.end"');
  });

  it("prints auto-compose informational messages when quiet mode is disabled", async () => {
    let stdoutCaptured = "";
    let stderrCaptured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: (chunk) => {
        stdoutCaptured += chunk;
      },
      writeError: (chunk) => {
        stderrCaptured += chunk;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "topic",
      "--engine",
      "mock",
      "--format",
      "json",
      "--max-rounds",
      "1",
      "--yes",
      "--heuristic-memory",
    ]);

    expect(stderrCaptured).toContain("Auto-composed panel:");
    expect(stderrCaptured).toContain("Morgan Chen");
    expect(stderrCaptured).toContain("[MOCK ENGINE]");
    expect(stdoutCaptured).toContain('"kind":"debate.end"');
  });

  it("suppresses migration messages when quiet mode is enabled", async () => {
    setQuiet(true);
    let stderrCaptured = "";
    const migrationLogs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      migrationLogs.push(String(message ?? ""));
    });
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (chunk) => {
        stderrCaptured += chunk;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "topic",
      "--template",
      "code-review",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    expect(stderrCaptured).not.toContain("Migrated");
    expect(migrationLogs.join("\n")).not.toContain("Migrated");
  });

  it("suppresses zero-change migration messages unless --verbose is passed", async () => {
    const firstRun = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });
    await firstRun.parseAsync([
      "node",
      "council-convene",
      "topic one",
      "--template",
      "code-review",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    let stderrCaptured = "";
    const migrationLogs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      migrationLogs.push(String(message ?? ""));
    });

    const secondRun = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (chunk) => {
        stderrCaptured += chunk;
      },
    });
    await secondRun.parseAsync([
      "node",
      "council-convene",
      "topic two",
      "--template",
      "code-review",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    expect(stderrCaptured).not.toContain("Migrated 0 panels and 0 experts");
    expect(migrationLogs.join("\n")).not.toContain("Migrated 0 panels and 0 experts");

    stderrCaptured = "";
    migrationLogs.length = 0;
    const verboseRun = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (chunk) => {
        stderrCaptured += chunk;
      },
    });
    await verboseRun.parseAsync([
      "node",
      "council-convene",
      "topic three",
      "--template",
      "code-review",
      "--engine",
      "mock",
      "--format",
      "json",
      "--verbose",
    ]);

    const combinedNotices = [stderrCaptured, migrationLogs.join("\n")].join("\n");
    expect(combinedNotices).toContain("Migrated 0 panels and 0 experts");
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
      expect(thrown.toLowerCase()).toMatch(
        /anthropic-direct|engine.*value|engine.*expected|allowed choices/,
      );
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

  it("builds an ad-hoc panel from --experts without invoking auto-compose confirmation", async () => {
    await seedLibraryExpert("library-alpha", "LibraryAlpha");
    await seedLibraryExpert("library-beta", "LibraryBeta");

    let confirmCalled = false;
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      confirmProvider: () => ({
        confirm: async () => {
          confirmCalled = true;
          return false;
        },
      }),
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Ad-hoc experts topic",
      "--experts",
      "library-alpha,library-beta",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);

    expect(confirmCalled).toBe(false);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(1);
      const experts = await new ExpertRepository(db).findByPanelId(panels[0]?.id ?? "");
      expect(experts.map((e) => e.slug).sort()).toEqual(["library-alpha", "library-beta"]);
    } finally {
      await db.destroy();
    }
  });

  it("uses template defaults while overriding template members with --experts", async () => {
    await seedLibraryExpert("override-alpha", "OverrideAlpha");
    await seedLibraryExpert("override-beta", "OverrideBeta");
    await writeUserPanel(
      "structured-template",
      [
        "name: structured-template",
        "defaults:",
        "  mode: structured",
        "  maxRounds: 4",
        "experts:",
        "  - template-missing",
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
      "Template override topic",
      "--template",
      "structured-template",
      "--experts",
      "override-alpha,override-beta",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(1);
      const experts = await new ExpertRepository(db).findByPanelId(panels[0]?.id ?? "");
      expect(experts.map((e) => e.slug).sort()).toEqual(["override-alpha", "override-beta"]);
    } finally {
      await db.destroy();
    }

    const phases = captured
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as { kind: string; phase?: string })
      .filter((event) => event.kind === "round.start")
      .map((event) => event.phase);
    expect(phases).toEqual(["opening", "cross-examination", "rebuttal", "synthesis"]);
  });

  it("uses template maxRounds defaults with --experts in freeform mode", async () => {
    await seedLibraryExpert("round-alpha", "RoundAlpha");
    await seedLibraryExpert("round-beta", "RoundBeta");
    await writeUserPanel(
      "freeform-rounds-template",
      [
        "name: freeform-rounds-template",
        "defaults:",
        "  maxRounds: 3",
        "experts:",
        "  - template-missing",
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
      "Freeform template defaults topic",
      "--template",
      "freeform-rounds-template",
      "--experts",
      "round-alpha,round-beta",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    const roundStarts = captured
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as { kind: string })
      .filter((event) => event.kind === "round.start");
    expect(roundStarts).toHaveLength(3);
  });

  it("migrates built-in experts before resolving --template with --experts on first run", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Built-in template experts topic",
      "--template",
      "code-review",
      "--experts",
      "senior,security",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(1);
      const experts = await new ExpertRepository(db).findByPanelId(panels[0]?.id ?? "");
      expect(experts.map((e) => e.slug).sort()).toEqual(["security", "senior"]);
    } finally {
      await db.destroy();
    }
  });

  it("errors when --experts references a slug that is not in the library", async () => {
    await seedLibraryExpert("library-known", "Known");

    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (chunk) => {
        stderr += chunk;
      },
    });
    cmd.exitOverride();

    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "topic",
        "--experts",
        "library-known,library-missing",
        "--engine",
        "mock",
      ]),
    ).rejects.toThrow(/library-missing|not in the library|expert/i);
    expect(stderr).toMatch(/library-missing|not in the library|expert/i);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      expect(await new PanelRepository(db).findAll()).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it("errors when --experts is empty or whitespace only", async () => {
    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (chunk) => {
        stderr += chunk;
      },
    });
    cmd.exitOverride();

    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "topic",
        "--experts",
        " ,  ",
        "--engine",
        "mock",
      ]),
    ).rejects.toThrow(/at least one expert slug is required|--experts/i);
    expect(stderr).toMatch(/at least one expert slug is required|--experts/i);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      expect(await new PanelRepository(db).findAll()).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it("rejects duplicate --experts slugs before persisting a panel", async () => {
    await seedLibraryExpert("dup-alpha", "DupAlpha");

    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (chunk) => {
        stderr += chunk;
      },
    });
    cmd.exitOverride();

    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "topic",
        "--experts",
        "dup-alpha,dup-alpha",
        "--engine",
        "mock",
      ]),
    ).rejects.toThrow(/duplicate expert slug|unique|constraint/i);
    expect(stderr).toMatch(/duplicate expert slug|unique|constraint/i);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      expect(await new PanelRepository(db).findAll()).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it("rejects --experts lists longer than eight members before persistence", async () => {
    const expertSlugs = [
      "expert-one",
      "expert-two",
      "expert-three",
      "expert-four",
      "expert-five",
      "expert-six",
      "expert-seven",
      "expert-eight",
      "expert-nine",
    ] as const;
    for (const slug of expertSlugs) {
      await seedLibraryExpert(slug, slug);
    }

    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (chunk) => {
        stderr += chunk;
      },
    });
    cmd.exitOverride();

    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "topic",
        "--experts",
        expertSlugs.join(","),
        "--engine",
        "mock",
      ]),
    ).rejects.toThrow(/at most 8|8 experts|max/i);
    expect(stderr).toMatch(/at most 8|8 experts|max/i);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      expect(await new PanelRepository(db).findAll()).toHaveLength(0);
    } finally {
      await db.destroy();
    }
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
