/**
 * Tests for `council ask <panel> "<question>"` — one-shot single-expert
 * chat. (Implicit roadmap item; README-advertised since session 1.)
 *
 * RED at this commit: src/cli/commands/ask.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAskCommand } from "../../../../src/cli/commands/ask.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";

async function seedPanel(testHome: string): Promise<{ panelName: string; panelId: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name: "ask-test-panel",
      topic: "General",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "[1] IDENTITY\nYou are a CTO.",
    });
    await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "pm",
      displayName: "PM",
      model: "claude-sonnet-4",
      systemMessage: "[1] IDENTITY\nYou are a PM.",
    });
    return { panelName: panel.name, panelId: panel.id };
  } finally {
    await db.destroy();
  }
}

describe("buildAskCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-ask-test-"));
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
    return () => new MockEngine({ responses: {} });
  }

  it("registers an 'ask' command with panel + question positional args", () => {
    const cmd = buildAskCommand({ engineFactory: makeMockEngineFactory() });
    expect(cmd.name()).toBe("ask");
    expect(cmd.description()).toMatch(/ask|expert|question/i);
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--expert");
    expect(longs).toContain("--engine");
    expect(longs).toContain("--format");
  });

  it("rejects unknown panel name", async () => {
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync([
        "node", "council-ask", "no-such-panel", "What?", "--engine", "mock",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/no panel|not found/);
  });

  it("suggests chat or convene when the name matches a library template in the data home", async () => {
    const originalDataHome = process.env["COUNCIL_DATA_HOME"];
    const libraryHome = path.join(testHome, "library-home");
    const panelsDir = path.join(libraryHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(
      path.join(panelsDir, "template-only-panel.yaml"),
      [
        "name: template-only-panel",
        "description: Template-only panel",
        "experts:",
        "  - slug: reviewer",
        "    displayName: Reviewer",
        "    role: Reviews code",
        "    expertise:",
        "      weightedEvidence:",
        "        - Reads diffs carefully",
        "      referenceCases: []",
        "      notExpertIn: []",
        "    epistemicStance: Cautious",
      ].join("\n"),
      "utf-8",
    );
    process.env["COUNCIL_DATA_HOME"] = libraryHome;

    try {
      const cmd = buildAskCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
      });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync([
          "node", "council-ask", "template-only-panel", "What?", "--engine", "mock",
        ]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown).toMatch(/template-only-panel/);
      expect(thrown).toMatch(/chat .*template-only-panel/i);
      expect(thrown).toMatch(/convene --template template-only-panel/i);
    } finally {
      if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    }
  });

  it("uses config.paths.dataHome for template-aware guidance when --engine is provided", async () => {
    const originalDataHome = process.env["COUNCIL_DATA_HOME"];
    const libraryHome = path.join(testHome, "config-data-home");
    const panelsDir = path.join(libraryHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(
      path.join(panelsDir, "config-template-panel.yaml"),
      [
        "name: config-template-panel",
        "description: Template-only panel from config.paths.dataHome",
        "experts:",
        "  - slug: reviewer",
        "    displayName: Reviewer",
        "    role: Reviews code",
        "    expertise:",
        "      weightedEvidence:",
        "        - Reads diffs carefully",
        "      referenceCases: []",
        "      notExpertIn: []",
        "    epistemicStance: Cautious",
      ].join("\n"),
      "utf-8",
    );
    delete process.env["COUNCIL_DATA_HOME"];
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      `paths:\n  dataHome: "${libraryHome.replace(/\\/g, "/")}"\n`,
      "utf-8",
    );

    try {
      const cmd = buildAskCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
      });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync([
          "node", "council-ask", "config-template-panel", "What?", "--engine", "mock",
        ]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown).toMatch(/config-template-panel/);
      expect(thrown).toMatch(/chat .*config-template-panel/i);
      expect(thrown).toMatch(/convene --template config-template-panel/i);
    } finally {
      if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    }
  });

  it("rejects unknown --expert slug", async () => {
    await seedPanel(testHome);
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync([
        "node", "council-ask", "ask-test-panel", "What?",
        "--expert", "ghost", "--engine", "mock",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/no expert|not found/);
  });

  it("resolves engine from config when --engine is omitted (no longer throws)", async () => {
    await seedPanel(testHome);
    const cmd = buildAskCommand({ write: () => undefined });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync([
        "node", "council-ask", "ask-test-panel", "What?",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    // Should NOT throw about missing --engine anymore
    expect(thrown.toLowerCase()).not.toMatch(/--engine.*required|required.*engine/);
  });

  it("e2e: runs a 1-expert 1-round debate, persists debate + turn rows", async () => {
    const seed = await seedPanel(testHome);
    let captured = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => { captured += s; },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node", "council-ask", seed.panelName, "What should we ship?",
      "--engine", "mock", "--format", "json",
    ]);

    // DB should have one new debate with 1 turn (default expert = first = cto).
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const debates = await new DebateRepository(db).findByPanelId(seed.panelId);
      expect(debates).toHaveLength(1);
      expect(debates[0]?.status).toBe("completed");
      expect(debates[0]?.prompt).toBe("What should we ship?");
      const turns = await new TurnRepository(db).findByDebateId(debates[0]?.id ?? "");
      expect(turns).toHaveLength(1); // 1 expert × 1 round = 1 turn
    } finally {
      await db.destroy();
    }

    // NDJSON output should include turn.end + debate.end
    const lines = captured.split("\n").filter((l) => l.trim().startsWith("{"));
    const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds).toContain("turn.end");
    expect(kinds[kinds.length - 1]).toBe("debate.end");
  });

  it("--expert picks the specified expert (not the default first)", async () => {
    const seed = await seedPanel(testHome);
    let captured = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => { captured += s; },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node", "council-ask", seed.panelName, "Question",
      "--expert", "pm", "--engine", "mock", "--format", "json",
    ]);

    // The turn should be attributed to pm, not cto.
    const lines = captured.split("\n").filter((l) => l.trim().startsWith("{"));
    const turnEnds = lines
      .map((l) => JSON.parse(l) as { kind: string; expertSlug?: string })
      .filter((e) => e.kind === "turn.end");
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.expertSlug).toBe("pm");
  });

  it("--format plain: produces human-readable output with expert name", async () => {
    await seedPanel(testHome);
    let captured = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => { captured += s; },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node", "council-ask", "ask-test-panel", "Question",
      "--engine", "mock",
    ]);

    // Plain format should mention the expert and NOT start with '{'.
    expect(captured).not.toMatch(/^\{/);
    expect(captured).toContain("CTO"); // default = first expert
  });

  it("--format json: all non-empty output lines are valid NDJSON (no plain-text preamble)", async () => {
    await seedPanel(testHome);
    let captured = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => { captured += s; },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node", "council-ask", "ask-test-panel", "Question",
      "--engine", "mock", "--format", "json",
    ]);

    const lines = captured.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.trim()).toMatch(/^\{/);
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // No plain-text headings should appear
    expect(captured).not.toMatch(/^# Asking/m);
  });

  it("--engine with invalid value rejects with clear error", async () => {
    await seedPanel(testHome);
    const cmd = buildAskCommand({
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync([
        "node", "council-ask", "ask-test-panel", "Question",
        "--engine", "nope",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/unknown.*engine|expected.*mock.*copilot|allowed choices/);
  });
});
