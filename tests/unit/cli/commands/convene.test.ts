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

  it("registers a 'convene' command with topic positional arg and required --template", () => {
    const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });
    expect(cmd.name()).toBe("convene");
    expect(cmd.description()).toMatch(/panel|debate/i);
    const templateOpt = cmd.options.find((o) => o.long === "--template");
    expect(templateOpt).toBeDefined();
    expect(templateOpt?.required).toBe(true);
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

  it("requires explicit --engine flag (no silent fallback to mock)", async () => {
    const cmd = buildConveneCommand({
      // No engineFactory passed — must require --engine on CLI.
      write: () => undefined,
    });
    cmd.exitOverride();

    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "topic",
        "--template",
        "code-review",
      ]),
    ).rejects.toThrow();
  });

  it("--engine copilot fails loudly (not yet wired)", async () => {
    const cmd = buildConveneCommand({
      write: () => undefined,
    });
    cmd.exitOverride();

    let thrownMessage = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-convene",
        "topic",
        "--template",
        "code-review",
        "--engine",
        "copilot",
      ]);
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }
    expect(thrownMessage).toMatch(/not yet wired|copilot|adapter/i);
  });

  it("--engine mock prints a prominent MOCK warning to stderr / output", async () => {
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
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);

    // Loud warning so users can never confuse mock output for real LLM.
    expect(captured.toUpperCase()).toContain("MOCK");
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
});

// Type guard so typescript-eslint is happy with the intentionally-unused import.
void (null as unknown as ExpertSpec);
