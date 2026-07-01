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
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

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

/**
 * Seed a panel whose sole (default) expert carries an attacker-controlled,
 * LLM-sourced identity. Auto-composed panels derive `displayName`/`slug` from
 * model output, so a malicious or compromised provider can smuggle ANSI escape
 * sequences and CR/LF into them. Returns the expert id so callers can force a
 * failure keyed by that id.
 */
async function seedExpertPanel(
  testHome: string,
  expert: { readonly slug: string; readonly displayName: string },
): Promise<{ panelName: string; panelId: string; expertId: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name: "ask-sanitize-panel",
      topic: "General",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const created = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: expert.slug,
      displayName: expert.displayName,
      model: "claude-sonnet-4",
      systemMessage: "[1] IDENTITY\nYou are an expert.",
    });
    return { panelName: panel.name, panelId: panel.id, expertId: created.id };
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
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    setQuiet(false);
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
      await cmd.parseAsync(["node", "council-ask", "no-such-panel", "What?", "--engine", "mock"]);
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
          "node",
          "council-ask",
          "template-only-panel",
          "What?",
          "--engine",
          "mock",
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
          "node",
          "council-ask",
          "config-template-panel",
          "What?",
          "--engine",
          "mock",
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
        "node",
        "council-ask",
        "ask-test-panel",
        "What?",
        "--expert",
        "ghost",
        "--engine",
        "mock",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/no expert|not found/);
  });

  it("resolves engine from config when --engine is omitted", async () => {
    await seedPanel(testHome);
    await fs.writeFile(path.join(testHome, "config.yaml"), "defaults:\n  engine: mock\n", "utf-8");

    let errorOutput = "";
    const cmd = buildAskCommand({
      write: () => undefined,
      writeError: (s) => {
        errorOutput += s;
      },
    });
    cmd.exitOverride();

    await cmd.parseAsync(["node", "council-ask", "ask-test-panel", "What?", "--format", "json"]);

    expect(errorOutput).toMatch(/MOCK ENGINE/);
  });

  it("e2e: runs a 1-expert 1-round debate, persists debate + turn rows", async () => {
    const seed = await seedPanel(testHome);
    let captured = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      seed.panelName,
      "What should we ship?",
      "--engine",
      "mock",
      "--format",
      "json",
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

  it("exits non-zero when the only expert fails and no answer is produced (#194)", async () => {
    const seed = await seedPanel(testHome);
    // Resolve the default (first) expert id so we can seed a failure for it.
    const db = await createDatabase(path.join(testHome, "council.db"));
    let ctoId = "";
    try {
      const experts = await new ExpertRepository(db).findByPanelId(seed.panelId);
      ctoId = experts.find((e) => e.slug === "cto")?.id ?? "";
    } finally {
      await db.destroy();
    }
    expect(ctoId).not.toBe("");

    const failingFactory = (): CouncilEngine =>
      new MockEngine({
        failures: { [ctoId]: { code: "PROVIDER_ERROR", message: "provider exploded" } },
      });
    const cmd = buildAskCommand({
      engineFactory: failingFactory,
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-ask",
        seed.panelName,
        "What should we ship?",
        "--engine",
        "mock",
        "--format",
        "json",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).not.toBe("");
    expect(thrown.toLowerCase()).toMatch(/no answer|failed|did not respond/);

    // The debate row exists but persisted zero turns (the user got no answer).
    const verifyDb = await createDatabase(path.join(testHome, "council.db"));
    try {
      const debates = await new DebateRepository(verifyDb).findByPanelId(seed.panelId);
      expect(debates).toHaveLength(1);
      const turns = await new TurnRepository(verifyDb).findByDebateId(debates[0]?.id ?? "");
      expect(turns).toHaveLength(0);
    } finally {
      await verifyDb.destroy();
    }
  });

  it("--expert picks the specified expert (not the default first)", async () => {
    const seed = await seedPanel(testHome);
    let captured = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      seed.panelName,
      "Question",
      "--expert",
      "pm",
      "--engine",
      "mock",
      "--format",
      "json",
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
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync(["node", "council-ask", "ask-test-panel", "Question", "--engine", "mock"]);

    // Plain format should mention the expert and NOT start with '{'.
    expect(captured).not.toMatch(/^\{/);
    expect(captured).toContain("CTO"); // default = first expert
  });

  it("--format json: all non-empty output lines are valid NDJSON (no plain-text preamble)", async () => {
    await seedPanel(testHome);
    let captured = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      "ask-test-panel",
      "Question",
      "--engine",
      "mock",
      "--format",
      "json",
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

  it("writes setup progress to stderr without contaminating json stdout", async () => {
    await seedPanel(testHome);
    const writes: { readonly stream: "stdout" | "stderr"; readonly text: string }[] = [];
    let stdout = "";
    let stderr = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        stdout += s;
        writes.push({ stream: "stdout", text: s });
      },
      writeError: (s) => {
        stderr += s;
        writes.push({ stream: "stderr", text: s });
      },
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      "ask-test-panel",
      "Question",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    expect(stderr).toContain("Preparing answer…\n");
    expect(stdout).not.toContain("Preparing answer");
    expect(stderr).not.toContain("\r");
    expect(stderr).not.toContain("\x1B");

    const firstStdoutIndex = writes.findIndex((entry) => entry.stream === "stdout");
    const progressIndex = writes.findIndex((entry) => entry.text.includes("Preparing answer"));
    expect(progressIndex).toBeGreaterThanOrEqual(0);
    expect(firstStdoutIndex).toBeGreaterThan(progressIndex);

    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.trim()).toMatch(/^\{/);
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("suppresses setup progress when quiet mode is enabled", async () => {
    await seedPanel(testHome);
    setQuiet(true);
    let stdout = "";
    let stderr = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        stdout += s;
      },
      writeError: (s) => {
        stderr += s;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      "ask-test-panel",
      "Question",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    expect(stderr).not.toContain("Preparing answer");
    expect(stdout).not.toContain("Preparing answer");
    expect(stdout.split("\n").some((line) => line.trim().startsWith("{"))).toBe(true);
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
        "node",
        "council-ask",
        "ask-test-panel",
        "Question",
        "--engine",
        "nope",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/unknown.*engine|expected.*mock.*copilot|allowed choices/);
  });

  it("sanitizes an LLM-sourced expert displayName/slug in the stderr failure notice (#1811)", async () => {
    // The zero-answer failure notice interpolates the LLM-sourced expert
    // identity straight into stderr. A crafted displayName/slug carrying ANSI
    // escapes + CR/LF could forge or overwrite terminal lines (spoof a fake
    // "OK", hide the real error). It must be sanitized the same way the echoed
    // question already is (ask.ts:172) — one line, no control sequences.
    const seed = await seedExpertPanel(testHome, {
      slug: "ev\x1B[0mil",
      displayName: "Evil\x1B[31m\r\nName",
    });
    const failingFactory = (): CouncilEngine =>
      new MockEngine({
        failures: { [seed.expertId]: { code: "PROVIDER_ERROR", message: "provider exploded" } },
      });
    let stderr = "";
    const cmd = buildAskCommand({
      engineFactory: failingFactory,
      write: () => undefined,
      writeError: (s) => {
        stderr += s;
      },
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-ask",
        seed.panelName,
        "What?",
        "--engine",
        "mock",
        "--format",
        "json",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).not.toBe("");

    // The notice must render on a single sanitized line: CR/LF collapsed to a
    // space (so the name cannot break out of its line) and ANSI stripped.
    const failureLine = stderr.split("\n").find((line) => line.includes("did not respond"));
    expect(failureLine).toBeDefined();
    expect(failureLine).toContain("Evil Name"); // LF no longer splits the name
    expect(failureLine).toContain("(evil)"); // slug ANSI stripped
    expect(failureLine).not.toContain("\x1B"); // no escape sequences
    expect(failureLine).not.toContain("\r"); // no carriage returns
  });

  it("sanitizes an LLM-sourced expert displayName/slug in the stdout preamble (#1811)", async () => {
    // The "# Asking …" preamble is written directly by ask.ts (bypassing the
    // renderer's own sanitization), so it must sanitize the LLM-sourced
    // identity itself before it reaches the terminal.
    const seed = await seedExpertPanel(testHome, {
      slug: "ev\x1B[0mil",
      displayName: "Evil\x1B[31m\r\nName",
    });
    let stdout = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        stdout += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      seed.panelName,
      "What?",
      "--engine",
      "mock",
      "--format",
      "plain",
    ]);

    const askingLine = stdout.split("\n").find((line) => line.startsWith("# Asking"));
    expect(askingLine).toBeDefined();
    expect(askingLine).toContain("Evil Name");
    expect(askingLine).toContain("(evil)");
    expect(askingLine).not.toContain("\x1B");
    expect(askingLine).not.toContain("\r");
  });

  it("help output documents the --engine usage examples (#672)", () => {
    // Regression guard: the ask examples must keep the required --engine flag
    // (and the --expert follow-up form). They live in addHelpText("after"),
    // which Commander omits from helpInformation(), so render via outputHelp().
    const cmd = buildAskCommand({ engineFactory: makeMockEngineFactory() });
    let help = "";
    cmd.configureOutput({
      writeOut: (chunk: string) => {
        help += chunk;
      },
      writeErr: (chunk: string) => {
        help += chunk;
      },
    });
    cmd.outputHelp();

    expect(help).toContain(
      'council ask my-panel "What about the migration risk?" --engine copilot',
    );
    expect(help).toContain('council ask my-panel "Quick follow-up" --expert cto --engine copilot');
  });
});
