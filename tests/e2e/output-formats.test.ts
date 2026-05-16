/**
 * E2E tests for output format correctness across commands.
 *
 * Verifies:
 *   - convene JSON output is valid NDJSON with proper event structure
 *   - convene plain output contains expected human-readable elements
 *   - export markdown has proper structure (headers, expert names)
 *   - export ADR has all required sections
 *   - sessions JSON format produces valid NDJSON
 *   - memory list JSON format produces valid NDJSON
 *   - export JSON matches resume JSON event kinds
 *
 * This is a test-only file (TDD ordering exemption applies).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../src/cli/commands/convene.js";
import { buildExportCommand } from "../../src/cli/commands/export.js";
import { buildMemoryCommand } from "../../src/cli/commands/memory.js";
import { buildResumeCommand } from "../../src/cli/commands/resume.js";
import { buildSessionsCommand } from "../../src/cli/commands/sessions.js";

import {
  captureOutput,
  cleanupE2EContext,
  createE2EContext,
  makeMockEngineFactory,
  seedCompletedDebate,
  type E2EContext,
} from "./helpers.js";

/**
 * Delay helper to allow DB connections to fully close on Windows.
 * SQLite on Windows sometimes needs a brief moment to release file locks.
 */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface JsonEvent {
  readonly kind: string;
  [key: string]: unknown;
}

function parseNdjson<T>(output: string): T[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as T);
}

describe.sequential("output formats e2e", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    // Give Windows time to release all file locks before cleanup
    await delay(3000);

    try {
      await cleanupE2EContext(ctx);
    } catch (err) {
      if (err instanceof Error && err.message.includes("EBUSY")) {
        await delay(2000);
        await cleanupE2EContext(ctx).catch(() => {
          console.warn("Cleanup delayed due to Windows file lock - temp files may persist");
        });
      } else {
        throw err;
      }
    }
  });

  it("convene JSON output is valid NDJSON", async () => {
    const output = captureOutput();
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: output.write,
      writeError: output.writeError,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt TypeScript?",
      "--template",
      "code-review",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    const stdout = output.stdout();
    const events = parseNdjson<JsonEvent>(stdout);

    // At least one event should be present
    expect(events.length).toBeGreaterThan(0);

    // Every event must have a `kind` field
    for (const event of events) {
      expect(event).toHaveProperty("kind");
      expect(typeof event.kind).toBe("string");
    }

    // First event should be panel.assembled
    expect(events[0]?.kind).toBe("panel.assembled");

    // Last event should be debate.end
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.kind).toBe("debate.end");
  });

  it("convene plain output structure", async () => {
    const output = captureOutput();
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: output.write,
      writeError: output.writeError,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt TypeScript?",
      "--template",
      "code-review",
      "--engine",
      "mock",
      "--format",
      "plain",
    ]);

    const stdout = output.stdout();

    // Should contain the topic
    expect(stdout).toContain("Should we adopt TypeScript?");

    // Should contain expert names (code-review template has Senior Developer, Security Auditor, etc.)
    expect(stdout.toLowerCase()).toMatch(/senior developer|security|performance|maintainer/);

    // Should NOT be JSON
    expect(stdout.trim()).not.toMatch(/^\{/);
  });

  it("export markdown has proper structure", async () => {
    const { panelName } = await seedCompletedDebate(ctx.testHome);

    const output = captureOutput();
    const cmd = buildExportCommand({
      write: output.write,
      writeError: output.writeError,
    });

    await cmd.parseAsync(["node", "council-export", panelName, "--format", "markdown"]);

    const stdout = output.stdout();

    // Should contain markdown header
    expect(stdout).toMatch(/^#\s+/m);

    // Should contain expert display names (CTO, PM)
    expect(stdout).toMatch(/CTO|PM/);

    // Should have some debate content
    expect(stdout.length).toBeGreaterThan(50);
  });

  it("export ADR has required sections", async () => {
    const { panelName } = await seedCompletedDebate(ctx.testHome);

    const output = captureOutput();
    const cmd = buildExportCommand({
      write: output.write,
      writeError: output.writeError,
    });

    await cmd.parseAsync(["node", "council-export", panelName, "--format", "adr"]);

    const stdout = output.stdout();

    // All required ADR sections must be present
    expect(stdout).toContain("## Status");
    expect(stdout).toContain("## Context");
    expect(stdout).toContain("## Options Considered");
    expect(stdout).toContain("## Discussion");
    expect(stdout).toContain("## Decision");
  });

  it("sessions JSON format valid", async () => {
    // First run convene to create a session
    const conveneOutput = captureOutput();
    const conveneCmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: conveneOutput.write,
      writeError: conveneOutput.writeError,
    });

    await conveneCmd.parseAsync([
      "node",
      "council-convene",
      "API design decision",
      "--template",
      "code-review",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    // Now run sessions --format json
    const sessionsOutput = captureOutput();
    const sessionsCmd = buildSessionsCommand(sessionsOutput.write);

    await sessionsCmd.parseAsync(["node", "council-sessions", "--format", "json"]);

    const stdout = sessionsOutput.stdout();
    const sessions = parseNdjson<{ id: string; name: string; topic: string | null }>(stdout);

    // At least one session should be present
    expect(sessions.length).toBeGreaterThan(0);

    // Each session should have required fields
    for (const session of sessions) {
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("name");
      expect(session).toHaveProperty("topic");
      expect(typeof session.id).toBe("string");
      expect(typeof session.name).toBe("string");
    }
  });

  it("memory list JSON valid", async () => {
    // Seed a completed debate first
    await seedCompletedDebate(ctx.testHome);

    const output = captureOutput();
    const cmd = buildMemoryCommand({
      write: output.write,
      writeError: output.writeError,
    });

    await cmd.parseAsync(["node", "council-memory", "list", "--format", "json"]);

    const stdout = output.stdout();
    const summaries = parseNdjson<{
      panelName: string;
      panelId: string;
      expertCount: number;
      debateCount: number;
      turnCount: number;
    }>(stdout);

    // At least one panel should be present
    expect(summaries.length).toBeGreaterThan(0);

    // Each summary should have expected structure
    for (const summary of summaries) {
      expect(summary).toHaveProperty("panelName");
      expect(summary).toHaveProperty("panelId");
      expect(summary).toHaveProperty("expertCount");
      expect(summary).toHaveProperty("debateCount");
      expect(summary).toHaveProperty("turnCount");
      expect(typeof summary.panelName).toBe("string");
      expect(typeof summary.panelId).toBe("string");
      expect(typeof summary.expertCount).toBe("number");
      expect(typeof summary.debateCount).toBe("number");
      expect(typeof summary.turnCount).toBe("number");
    }
  });

  it("export JSON matches resume JSON", async () => {
    const { panelName } = await seedCompletedDebate(ctx.testHome);

    // Export JSON
    const exportOutput = captureOutput();
    const exportCmd = buildExportCommand({
      write: exportOutput.write,
      writeError: exportOutput.writeError,
    });

    await exportCmd.parseAsync(["node", "council-export", panelName, "--format", "json"]);

    const exportEvents = parseNdjson<JsonEvent>(exportOutput.stdout());

    // Resume JSON (transcript mode, no --continue)
    const resumeOutput = captureOutput();
    const resumeCmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: resumeOutput.write,
      writeError: resumeOutput.writeError,
    });

    await resumeCmd.parseAsync(["node", "council-resume", panelName, "--format", "json"]);

    const resumeEvents = parseNdjson<JsonEvent>(resumeOutput.stdout());

    // Both should have events
    expect(exportEvents.length).toBeGreaterThan(0);
    expect(resumeEvents.length).toBeGreaterThan(0);

    // Extract event kinds
    const exportKinds = exportEvents.map((e) => e.kind);
    const resumeKinds = resumeEvents.map((e) => e.kind);

    // Both should produce the same event kinds in the same order
    expect(exportKinds).toEqual(resumeKinds);
  });
});
