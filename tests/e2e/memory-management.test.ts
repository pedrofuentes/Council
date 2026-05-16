import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../src/cli/commands/convene.js";
import { buildMemoryCommand } from "../../src/cli/commands/memory.js";
import { DebateRepository } from "../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../src/memory/repositories/turns.js";

import {
  captureOutput,
  cleanupE2EContext,
  createE2EContext,
  makeMockEngineFactory,
  openTestDb,
  seedCompletedDebate,
  type E2EContext,
} from "./helpers.js";

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

interface MemoryListJsonRow {
  readonly panelName: string;
  readonly panelId: string;
  readonly topic: string | null;
  readonly expertCount: number;
  readonly debateCount: number;
  readonly turnCount: number;
  readonly lastActivity: string | null;
}

interface StoredPanelSummary {
  readonly panelId: string;
  readonly panelName: string;
  readonly expertCount: number;
  readonly debateCount: number;
  readonly debateId: string;
  readonly turnCount: number;
}

function parseNdjson<T>(text: string): readonly T[] {
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as T);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function restoreContextEnv(ctx: E2EContext): void {
  if (ctx.originalHome === undefined) {
    delete process.env.COUNCIL_HOME;
  } else {
    process.env.COUNCIL_HOME = ctx.originalHome;
  }

  if (ctx.originalDataHome === undefined) {
    delete process.env.COUNCIL_DATA_HOME;
  } else {
    process.env.COUNCIL_DATA_HOME = ctx.originalDataHome;
  }
}

async function runConveneCommand(ctx: E2EContext, topic: string): Promise<CommandOutput> {
  const output = captureOutput();
  const cmd = buildConveneCommand({
    engineFactory: makeMockEngineFactory(),
    write: output.write,
    writeError: output.writeError,
  });

  await cmd.parseAsync([
    "node",
    "council-convene",
    topic,
    "--template",
    "code-review",
    "--max-rounds",
    "1",
    "--format",
    "json",
    "--engine",
    "mock",
  ]);

  return {
    stdout: output.stdout(),
    stderr: output.stderr(),
  };
}

async function runMemoryCommand(args: readonly string[]): Promise<CommandOutput> {
  const output = captureOutput();
  const cmd = buildMemoryCommand({
    write: output.write,
    writeError: output.writeError,
  });

  await cmd.parseAsync(["node", "council-memory", ...args]);

  return {
    stdout: output.stdout(),
    stderr: output.stderr(),
  };
}

async function loadLatestPanelSummary(ctx: E2EContext): Promise<StoredPanelSummary> {
  const db = await openTestDb(ctx.testHome);

  try {
    const panels = await new PanelRepository(db).findAll();
    const panel = panels[panels.length - 1];
    if (!panel) {
      throw new Error("Expected a convened panel to exist.");
    }

    const experts = await new ExpertRepository(db).findByPanelId(panel.id);
    const debates = await new DebateRepository(db).findByPanelId(panel.id);
    const debate = debates[debates.length - 1];
    if (!debate) {
      throw new Error(`Expected panel '${panel.name}' to have a persisted debate.`);
    }

    const turns = await new TurnRepository(db).findByDebateId(debate.id);
    return {
      panelId: panel.id,
      panelName: panel.name,
      expertCount: experts.length,
      debateCount: debates.length,
      debateId: debate.id,
      turnCount: turns.length,
    };
  } finally {
    await db.destroy();
  }
}

describe("memory management e2e", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await cleanupE2EContext(ctx);
        return;
      } catch (error: unknown) {
        restoreContextEnv(ctx);
        if (!String(error).includes("EBUSY") || attempt === 4) {
          return;
        }
        await wait(250);
      }
    }
  });

  it("memory list after convene shows persisted panel counts", async () => {
    await runConveneCommand(ctx, "Should we ship this pull request?");
    const panel = await loadLatestPanelSummary(ctx);

    const result = await runMemoryCommand(["list"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(panel.panelName);
    expect(result.stdout).toContain(
      `experts: ${panel.expertCount}, debates: ${panel.debateCount}, turns: ${panel.turnCount}`,
    );
  });

  it("memory list --panel filters to one seeded panel", async () => {
    await seedCompletedDebate(ctx.testHome, { panelName: "test-panel" });
    await seedCompletedDebate(ctx.testHome, { panelName: "other-panel" });

    const result = await runMemoryCommand(["list", "--panel", "test-panel"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("test-panel");
    expect(result.stdout).not.toContain("other-panel");
  });

  it("memory list --format json emits valid NDJSON after convene", async () => {
    await runConveneCommand(ctx, "Should we merge this refactor?");
    const panel = await loadLatestPanelSummary(ctx);

    const result = await runMemoryCommand(["list", "--format", "json"]);
    const rows = parseNdjson<MemoryListJsonRow>(result.stdout);

    expect(result.stderr).toBe("");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      panelName: panel.panelName,
      panelId: panel.panelId,
      expertCount: panel.expertCount,
      debateCount: panel.debateCount,
      turnCount: panel.turnCount,
    });
  });

  it("memory inspect panel shows topic, debate status, and experts", async () => {
    await seedCompletedDebate(ctx.testHome, {
      panelName: "test-panel",
      topic: "Should we ship the MVP?",
      prompt: "Should we ship the MVP?",
    });

    const result = await runMemoryCommand(["inspect", "test-panel"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# test-panel");
    expect(result.stdout).toContain("Topic: Should we ship the MVP?");
    expect(result.stdout).toContain("CTO (cto)");
    expect(result.stdout).toContain("PM (pm)");
    expect(result.stdout).toContain("status: completed");
    expect(result.stdout).toContain("turns: 2");
  });

  it("memory inspect --expert shows prompt preview, turn count, and model", async () => {
    await seedCompletedDebate(ctx.testHome, { panelName: "test-panel" });

    const result = await runMemoryCommand(["inspect", "test-panel", "--expert", "cto"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# CTO (cto) in test-panel");
    expect(result.stdout).toContain("Model: claude-sonnet-4");
    expect(result.stdout).toContain("Turns by this expert: 1");
    expect(result.stdout).toContain("System prompt (preview, 600 chars):");
    expect(result.stdout).toContain("[1] IDENTITY");
    expect(result.stdout).toContain("You are cto.");
  });

  it("memory reset (soft) deletes debates and turns but keeps panel and experts", async () => {
    const seeded = await seedCompletedDebate(ctx.testHome, { panelName: "test-panel" });

    const result = await runMemoryCommand(["reset", seeded.panelName, "--yes"]);

    const db = await openTestDb(ctx.testHome);
    try {
      const panel = await new PanelRepository(db).findByName(seeded.panelName);
      expect(panel).not.toBeUndefined();
      if (!panel) {
        throw new Error("Expected reset panel to remain in the database.");
      }

      const experts = await new ExpertRepository(db).findByPanelId(panel.id);
      const debates = await new DebateRepository(db).findByPanelId(panel.id);
      const turns = await new TurnRepository(db).findByDebateId(seeded.debateId);

      expect(result.stdout).toContain(`Reset panel '${seeded.panelName}'`);
      expect(experts).toHaveLength(2);
      expect(debates).toHaveLength(0);
      expect(turns).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it("memory reset --hard deletes the panel and its experts", async () => {
    const seeded = await seedCompletedDebate(ctx.testHome, { panelName: "test-panel" });

    await runMemoryCommand(["reset", seeded.panelName, "--hard", "--yes"]);

    const db = await openTestDb(ctx.testHome);
    try {
      const panel = await new PanelRepository(db).findByName(seeded.panelName);
      const experts = await new ExpertRepository(db).findByPanelId(seeded.panelId);
      const debates = await new DebateRepository(db).findByPanelId(seeded.panelId);
      const turns = await new TurnRepository(db).findByDebateId(seeded.debateId);

      expect(panel).toBeUndefined();
      expect(experts).toHaveLength(0);
      expect(debates).toHaveLength(0);
      expect(turns).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it("memory reset --expert removes one expert and keeps the others", async () => {
    const seeded = await seedCompletedDebate(ctx.testHome, { panelName: "test-panel" });

    await runMemoryCommand(["reset", seeded.panelName, "--expert", "cto", "--yes"]);

    const db = await openTestDb(ctx.testHome);
    try {
      const experts = await new ExpertRepository(db).findByPanelId(seeded.panelId);
      const debates = await new DebateRepository(db).findByPanelId(seeded.panelId);

      expect(experts.map((expert) => expert.slug)).toEqual(["pm"]);
      expect(debates).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });

  it("memory reset without --yes refuses and leaves data intact", async () => {
    const seeded = await seedCompletedDebate(ctx.testHome, { panelName: "test-panel" });
    const output = captureOutput();
    const cmd = buildMemoryCommand({
      write: output.write,
      writeError: output.writeError,
    });

    await expect(
      cmd.parseAsync(["node", "council-memory", "reset", seeded.panelName]),
    ).rejects.toThrow(/--yes/);

    const db = await openTestDb(ctx.testHome);
    try {
      const panel = await new PanelRepository(db).findByName(seeded.panelName);
      expect(panel).not.toBeUndefined();
      if (!panel) {
        throw new Error("Expected panel to remain after a refused reset.");
      }

      const experts = await new ExpertRepository(db).findByPanelId(panel.id);
      const debates = await new DebateRepository(db).findByPanelId(panel.id);
      const turns = await new TurnRepository(db).findByDebateId(seeded.debateId);

      expect(output.stdout()).toBe("");
      expect(output.stderr()).toBe("");
      expect(experts).toHaveLength(2);
      expect(debates).toHaveLength(1);
      expect(turns).toHaveLength(2);
    } finally {
      await db.destroy();
    }
  });

  it("memory list empty state reports that no panels exist", async () => {
    const result = await runMemoryCommand(["list"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/No panels in the local DB/i);
  });

  it("memory reset then re-convene creates a fresh debate on a new panel", async () => {
    const topic = "Should we split this module?";

    await runConveneCommand(ctx, topic);
    const firstPanel = await loadLatestPanelSummary(ctx);

    await runMemoryCommand(["reset", firstPanel.panelName, "--yes"]);
    await wait(1_100);
    await runConveneCommand(ctx, topic);

    const db = await openTestDb(ctx.testHome);
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(2);

      const latestPanel = panels[panels.length - 1];
      expect(latestPanel?.name).not.toBe(firstPanel.panelName);

      const resetPanelDebates = await new DebateRepository(db).findByPanelId(firstPanel.panelId);
      const reconvenedPanelDebates = latestPanel
        ? await new DebateRepository(db).findByPanelId(latestPanel.id)
        : [];

      expect(resetPanelDebates).toHaveLength(0);
      expect(reconvenedPanelDebates).toHaveLength(1);
      expect(reconvenedPanelDebates[0]?.id).not.toBe(firstPanel.debateId);
    } finally {
      await db.destroy();
    }
  });
});
