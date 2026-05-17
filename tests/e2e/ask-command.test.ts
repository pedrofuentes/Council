/**
 * E2E tests for `council ask <panel> "<question>"` — one-shot single-expert
 * chat workflow with full database and environment setup.
 *
 * This is a test-only file (TDD ordering exemption applies).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAskCommand } from "../../src/cli/commands/ask.js";
import { DebateRepository } from "../../src/memory/repositories/debates.js";
import { TurnRepository } from "../../src/memory/repositories/turns.js";

import {
  captureOutput,
  cleanupE2EContext,
  createE2EContext,
  destroyTestDb,
  makeMockEngineFactory,
  openTestDb,
  seedPanelWithExperts,
  type E2EContext,
} from "./helpers.js";

function isTransientDbLockError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);

  return /busy|lock|ebusy|eperm|enotempty|sqlite_busy/i.test(`${code} ${message}`);
}

async function isDbReleased(testHome: string): Promise<boolean> {
  try {
    const db = await openTestDb(testHome);
    await destroyTestDb(db);
    return true;
  } catch (error: unknown) {
    if (isTransientDbLockError(error)) {
      return false;
    }

    throw error;
  }
}

async function waitForDbRelease(testHome: string): Promise<void> {
  await expect
    .poll(async () => isDbReleased(testHome), {
      interval: 50,
      timeout: 2_000,
    })
    .toBe(true);
}

describe.sequential("ask command e2e", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    await cleanupE2EContext(ctx);
  });

  it("ask default expert — runs 1-round 1-expert debate, persists to DB, outputs turn events", async () => {
    const { panelName, panelId } = await seedPanelWithExperts(ctx.testHome);
    const output = captureOutput();

    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: output.write,
      writeError: output.writeError,
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      panelName,
      "Should we use microservices?",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    // Wait for DB to be fully released
    await waitForDbRelease(ctx.testHome);

    // Verify DB has debate and turn
    const db = await openTestDb(ctx.testHome);
    try {
      const debates = await new DebateRepository(db).findByPanelId(panelId);
      expect(debates).toHaveLength(1);
      expect(debates[0]?.status).toBe("completed");
      expect(debates[0]?.prompt).toBe("Should we use microservices?");

      const turns = await new TurnRepository(db).findByDebateId(debates[0]?.id ?? "");
      expect(turns).toHaveLength(1); // 1 expert × 1 round = 1 turn
    } finally {
      await destroyTestDb(db);
    }

    // Verify output contains turn events
    const stdout = output.stdout();
    const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds).toContain("turn.end");
    expect(kinds[kinds.length - 1]).toBe("debate.end");
  });

  it("ask specific expert (--expert) — PM responds not CTO", async () => {
    const { panelName } = await seedPanelWithExperts(ctx.testHome, {
      expertSlugs: ["cto", "pm"],
    });
    const output = captureOutput();

    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: output.write,
      writeError: output.writeError,
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      panelName,
      "What should we prioritize?",
      "--expert",
      "pm",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    // Verify PM responded (not CTO)
    const stdout = output.stdout();
    const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    const turnEnds = lines
      .map((l) => JSON.parse(l) as { kind: string; expertSlug?: string })
      .filter((e) => e.kind === "turn.end");

    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.expertSlug).toBe("pm");
  });

  it("ask with --max-words — command accepts flag and completes", async () => {
    const { panelName, panelId } = await seedPanelWithExperts(ctx.testHome);
    const output = captureOutput();

    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: output.write,
      writeError: output.writeError,
    });

    // Verify command accepts --max-words flag without error
    await cmd.parseAsync([
      "node",
      "council-ask",
      panelName,
      "Explain your architecture",
      "--max-words",
      "100",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    // Wait for DB to be fully released
    await waitForDbRelease(ctx.testHome);

    // Verify the debate ran successfully
    // Note: MockEngine doesn't enforce word limits, so we only verify the flag is accepted
    const db = await openTestDb(ctx.testHome);
    try {
      const debates = await new DebateRepository(db).findByPanelId(panelId);
      expect(debates).toHaveLength(1);
      expect(debates[0]?.status).toBe("completed");
    } finally {
      await destroyTestDb(db);
    }

    // Verify output contains debate.end event
    const stdout = output.stdout();
    const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds).toContain("debate.end");
  });

  it("ask non-existent panel — error contains 'not found' or similar", async () => {
    const output = captureOutput();
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: output.write,
      writeError: output.writeError,
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-ask",
        "nonexistent-panel",
        "What?",
        "--engine",
        "mock",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }

    expect(thrown.toLowerCase()).toMatch(/no panel|not found/);
  });

  it("ask non-existent expert slug — error lists available slugs", async () => {
    const { panelName } = await seedPanelWithExperts(ctx.testHome, {
      expertSlugs: ["cto", "pm"],
    });
    const output = captureOutput();
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: output.write,
      writeError: output.writeError,
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-ask",
        panelName,
        "What?",
        "--expert",
        "nonexistent",
        "--engine",
        "mock",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }

    expect(thrown.toLowerCase()).toMatch(/no expert|not found/);
    expect(thrown).toMatch(/cto/);
    expect(thrown).toMatch(/pm/);
  });

  it("ask plain vs JSON format — plain is human-readable, JSON is valid NDJSON", async () => {
    const { panelName } = await seedPanelWithExperts(ctx.testHome);

    // Test JSON format
    const jsonOutput = captureOutput();
    const jsonCmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: jsonOutput.write,
      writeError: jsonOutput.writeError,
    });

    await jsonCmd.parseAsync([
      "node",
      "council-ask",
      panelName,
      "What is your recommendation?",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    const jsonStdout = jsonOutput.stdout();
    const jsonLines = jsonStdout.split("\n").filter((l) => l.trim().length > 0);
    expect(jsonLines.length).toBeGreaterThan(0);

    // All non-empty lines should be valid JSON
    for (const line of jsonLines) {
      expect(line.trim()).toMatch(/^\{/);
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // JSON format should NOT contain plain-text preambles
    expect(jsonStdout).not.toMatch(/^# Asking/m);

    // Test explicit plain format
    const plainOutput = captureOutput();
    const plainCmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: plainOutput.write,
      writeError: plainOutput.writeError,
    });

    await plainCmd.parseAsync([
      "node",
      "council-ask",
      panelName,
      "What is your recommendation?",
      "--engine",
      "mock",
      "--format",
      "plain",
    ]);

    const plainStdout = plainOutput.stdout();

    // Plain format should be human-readable and NOT start with JSON
    expect(plainStdout).not.toMatch(/^\{/);
    expect(plainStdout).toContain("CTO"); // default = first expert (displayName)
  });

  it("ask persists to DB — panel, debate (status=completed), turn", async () => {
    const { panelName, panelId } = await seedPanelWithExperts(ctx.testHome);
    const output = captureOutput();

    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: output.write,
      writeError: output.writeError,
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      panelName,
      "Test question",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    // Wait for DB to be fully released
    await waitForDbRelease(ctx.testHome);

    // Verify everything persisted correctly
    const db = await openTestDb(ctx.testHome);
    try {
      const debates = await new DebateRepository(db).findByPanelId(panelId);
      expect(debates).toHaveLength(1);
      expect(debates[0]?.status).toBe("completed");
      expect(debates[0]?.panelId).toBe(panelId);
      expect(debates[0]?.prompt).toBe("Test question");

      const debateId = debates[0]?.id ?? "";
      const turns = await new TurnRepository(db).findByDebateId(debateId);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.debateId).toBe(debateId);
      expect(turns[0]?.round).toBe(0); // rounds are 0-indexed
    } finally {
      await destroyTestDb(db);
    }
  });
});
