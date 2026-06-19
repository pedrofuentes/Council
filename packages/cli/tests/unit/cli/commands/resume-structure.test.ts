/**
 * Tests for resume command structure improvements (T-17):
 *   - CLI-21: Rename --continue to --prompt
 *   - DX-12: Prefix match and --latest
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildResumeCommand } from "../../../../src/cli/commands/resume.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

describe("resume --prompt rename (CLI-21)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-resume-prompt-"));
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

  it("supports --prompt option instead of --continue", () => {
    const cmd = buildResumeCommand({ engineFactory: makeMockEngineFactory() });
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--prompt");
    expect(longs).not.toContain("--continue");
  });

  it("--prompt runs a new debate (same behavior as old --continue)", async () => {
    // Seed panel with debate
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panel = await new PanelRepository(db).create({
        name: "prompt-rename-panel",
        topic: "test topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ mode: "freeform" }),
      });
      const expert = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "dev",
        displayName: "Developer",
        model: "mock",
        systemMessage: "You are a developer.",
      });
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "initial prompt",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: expert.id,
        content: "Opening statement.",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync([
      "node",
      "council-resume",
      "prompt-rename-panel",
      "--prompt",
      "What about costs?",
      "--engine",
      "mock",
      "--max-rounds",
      "1",
      "--format",
      "json",
    ]);

    // Should produce debate output (NDJSON events)
    const lines = captured.split("\n").filter((l) => l.trim().startsWith("{"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[lines.length - 1]).toMatch(/"debate\.end"/);
  });
});

describe("resume prefix match and --latest (DX-12)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-resume-prefix-"));
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

  async function seedPanel(name: string): Promise<void> {
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panel = await new PanelRepository(db).create({
        name,
        topic: `Topic for ${name}`,
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ mode: "freeform" }),
      });
      const expert = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "dev",
        displayName: "Developer",
        model: "mock",
        systemMessage: "You are a developer.",
      });
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: `Prompt for ${name}`,
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: expert.id,
        content: `Content from ${name}`,
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }
  }

  it("auto-selects when prefix matches exactly one panel", async () => {
    await seedPanel("architecture-review-2025");

    let captured = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });
    // "architecture" is a prefix of "architecture-review-2025"
    await cmd.parseAsync(["node", "council-resume", "architecture"]);

    expect(captured).toContain("architecture-review-2025");
    expect(captured).toContain("Content from architecture-review-2025");
  });

  it("rejects with ambiguity error when prefix matches multiple panels", async () => {
    await seedPanel("arch-review-a");
    await new Promise((r) => setTimeout(r, 5));
    await seedPanel("arch-review-b");

    let captured = "";
    let stderr = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
      writeError: (s) => {
        stderr += s;
      },
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-resume", "arch"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    // Must throw an ambiguity error
    expect(thrown).toMatch(/ambiguous/i);
    // Listing goes to stderr, not stdout
    expect(stderr).toMatch(/arch-review-a/);
    expect(stderr).toMatch(/arch-review-b/);
    // No transcript output produced
    expect(captured).toBe("");
  });

  it("--latest resumes the most recent session", async () => {
    await seedPanel("first-panel");
    await new Promise((r) => setTimeout(r, 5));
    await seedPanel("second-panel");

    let captured = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-resume", "--latest"]);

    expect(captured).toContain("second-panel");
    expect(captured).toContain("Content from second-panel");
  });

  it("--latest errors when no panels exist", async () => {
    let stderr = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (s) => {
        stderr += s;
      },
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-resume", "--latest"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).toMatch(/no.*panel|no.*session|no.*debate/i);
    expect(stderr).toMatch(/no.*panel/i);
  });

  it("errors when no panel argument is provided and --latest is not set", async () => {
    let stderr = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (s) => {
        stderr += s;
      },
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-resume"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).toMatch(/panel.*required/i);
    expect(stderr).toMatch(/panel.*required/i);
  });
});
