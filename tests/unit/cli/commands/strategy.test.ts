/**
 * CLI wiring tests for `--strategy` on `convene` and `resume --continue` (#212).
 *
 * Verifies:
 *   - `convene --strategy <name>` is registered as an option (default: round-robin).
 *   - The resolved strategy.name is persisted to `debates.moderator`.
 *   - `convene --strategy devils-advocate:<slug>` flows the contrarian
 *     prompt through to `engine.send()` for the designated advocate.
 *   - `convene --strategy <bad>` exits non-zero with a clear error.
 *   - `resume --continue --strategy <name>` is registered and persists the
 *     strategy name to the new debate row.
 *   - `resume` honors a panel's structured mode by ignoring `--strategy`
 *     (moderator label stays `structured-phases`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { buildResumeCommand } from "../../../../src/cli/commands/resume.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

describe("convene --strategy", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let mockEngine: MockEngine | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-strategy-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    mockEngine = undefined;
    await copyTemplateDb(path.join(testHome, "council.db"));
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
    return () => {
      mockEngine = new MockEngine({ responses: {} });
      return mockEngine;
    };
  }

  it("registers --strategy with a 'round-robin' default", () => {
    const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });
    const opt = cmd.options.find((o) => o.long === "--strategy");
    expect(opt).toBeDefined();
    expect(opt?.defaultValue).toBe("round-robin");
  });

  it("persists the resolved strategy name to debates.moderator", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
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
      "--strategy",
      "consensus-check",
    ]);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      const panelId = panels[0]?.id ?? "";
      const debates = await new DebateRepository(db).findByPanelId(panelId);
      expect(debates[0]?.moderator).toBe("consensus-check");
    } finally {
      await db.destroy();
    }
  });

  it("flows the devils-advocate contrarian prompt to engine.send() for the designated advocate", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
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
      "--strategy",
      "devils-advocate:senior",
    ]);

    expect(mockEngine).toBeDefined();
    const sent = mockEngine?.sentPrompts ?? [];
    expect(sent.length).toBeGreaterThan(0);

    // Exactly one expert (the designated advocate) gets the contrarian
    // framing in round 0. We can't map sent.expertId→slug directly
    // (engine sees ExpertSpec.id, DB has a separate row id), so we
    // verify the count and that the advocate prompt is present.
    const contrarianPrompts = sent.filter((p) => p.prompt.includes("devil's advocate"));
    expect(contrarianPrompts).toHaveLength(1);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      const debates = await new DebateRepository(db).findByPanelId(panels[0]?.id ?? "");
      expect(debates[0]?.moderator).toBe("devils-advocate");
    } finally {
      await db.destroy();
    }
  });

  it("rejects an unknown --strategy value with a clear error", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });

    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "Topic",
        "--template",
        "code-review",
        "--engine",
        "mock",
        "--strategy",
        "socratic",
      ]),
    ).rejects.toThrowError(/Unknown --strategy value/);
  });

  it("ignores --strategy when --mode is structured (does not call the resolver)", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });

    // 'socratic' is NOT a registered strategy name. Passing it together
    // with --mode structured must not throw, because the resolver is
    // never invoked in structured mode (phase-prompts drive the debate).
    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "Topic",
        "--template",
        "code-review",
        "--mode",
        "structured",
        "--engine",
        "mock",
        "--strategy",
        "socratic",
      ]),
    ).resolves.toBeDefined();

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      const debates = await new DebateRepository(db).findByPanelId(panels[0]?.id ?? "");
      expect(debates[0]?.moderator).toBe("structured-phases");
    } finally {
      await db.destroy();
    }
  });
});

describe("resume --continue --strategy", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-resume-strategy-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
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

  async function seedPanel(mode: "freeform" | "structured"): Promise<string> {
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panel = await new PanelRepository(db).create({
        name: "panel-x",
        topic: "Original topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode }),
      });
      const cto = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "cto",
        displayName: "CTO",
        model: "claude-sonnet-4",
        systemMessage: "[1] IDENTITY",
      });
      await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "pm",
        displayName: "PM",
        model: "claude-sonnet-4",
        systemMessage: "[1] IDENTITY",
      });
      // Seed an initial completed debate so loadTranscript() does not
      // reject the resume call. The strategy under test will create a
      // SECOND debate row, which the assertions check.
      const initial = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "Original",
        moderator: mode === "structured" ? "structured-phases" : "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: initial.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: "Prior turn.",
      });
      await new DebateRepository(db).update(initial.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      return panel.id;
    } finally {
      await db.destroy();
    }
  }

  it("registers --strategy with a 'round-robin' default", () => {
    const cmd = buildResumeCommand({ engineFactory: makeMockEngineFactory() });
    const opt = cmd.options.find((o) => o.long === "--strategy");
    expect(opt).toBeDefined();
    expect(opt?.defaultValue).toBe("round-robin");
  });

  it("persists the resolved strategy name to the new debate row (freeform panel)", async () => {
    const panelId = await seedPanel("freeform");
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-resume",
      "panel-x",
      "--prompt",
      "Follow-up?",
      "--engine",
      "mock",
      "--max-rounds",
      "1",
      "--strategy",
      "consensus-check",
    ]);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const debates = await new DebateRepository(db).findByPanelId(panelId);
      // Two debates: the seed + the one created by --continue.
      expect(debates).toHaveLength(2);
      const continueDebate = debates.find((d) => d.prompt === "Follow-up?");
      expect(continueDebate?.moderator).toBe("consensus-check");
    } finally {
      await db.destroy();
    }
  });

  it("ignores --strategy when the panel runs in structured mode", async () => {
    const panelId = await seedPanel("structured");
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });

    // 'socratic' is NOT a registered strategy name. The resume path
    // detects panelMode === "structured" before invoking the resolver,
    // so an invalid --strategy value must not throw.
    await expect(
      cmd.parseAsync([
        "node",
        "council-resume",
        "panel-x",
        "--prompt",
        "Follow-up?",
        "--engine",
        "mock",
        "--max-rounds",
        "1",
        "--strategy",
        "socratic",
      ]),
    ).resolves.toBeDefined();

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const debates = await new DebateRepository(db).findByPanelId(panelId);
      const continueDebate = debates.find((d) => d.prompt === "Follow-up?");
      expect(continueDebate?.moderator).toBe("structured-phases");
    } finally {
      await db.destroy();
    }
  });

  it("warns via writeError when the panel configJson is malformed", async () => {
    // Seed a panel with malformed configJson directly via the
    // PanelRepository (the convene happy path always writes valid JSON).
    const db = await createDatabase(path.join(testHome, "council.db"));
    let panelId = "";
    try {
      const panel = await new PanelRepository(db).create({
        name: "panel-bad",
        topic: "T",
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{not valid json",
      });
      panelId = panel.id;
      const cto = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "cto",
        displayName: "CTO",
        model: "claude-sonnet-4",
        systemMessage: "[1] IDENTITY",
      });
      const initial = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "Original",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: initial.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: "Prior turn.",
      });
      await new DebateRepository(db).update(initial.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }

    const errLines: string[] = [];
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (s) => {
        errLines.push(s);
      },
    });

    await cmd.parseAsync([
      "node",
      "council-resume",
      "panel-bad",
      "--prompt",
      "Follow-up?",
      "--engine",
      "mock",
      "--max-rounds",
      "1",
    ]);

    const joined = errLines.join("");
    expect(joined).toMatch(/malformed configJson/);
    expect(joined).toMatch(/panel-bad/);

    // Falls back to freeform mode (default round-robin strategy).
    const db2 = await createDatabase(path.join(testHome, "council.db"));
    try {
      const debates = await new DebateRepository(db2).findByPanelId(panelId);
      const continueDebate = debates.find((d) => d.prompt === "Follow-up?");
      expect(continueDebate?.moderator).toBe("round-robin");
    } finally {
      await db2.destroy();
    }
  });
});
