/**
 * Tests for `council export <panel> --format md|json|adr [--output <path>]`
 * (ROADMAP §3.6).
 *
 * RED at this commit: src/cli/commands/export.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildExportCommand } from "../../../../src/cli/commands/export.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";

async function seedPanelWithDebate(testHome: string): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "export-test",
      topic: "Should we ship the MVP?",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const cto = await expertRepo.create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    const pm = await expertRepo.create({
      panelId: panel.id,
      slug: "pm",
      displayName: "PM",
      model: "claude-sonnet-4",
      systemMessage: "You are a PM.",
    });
    const debate = await debateRepo.create({
      panelId: panel.id,
      prompt: "Should we ship the MVP?",
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO position: ship now to get user feedback fast.",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM position: hold two weeks for the auth flow.",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 1,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO synthesis: launch behind a feature flag now.",
    });
    await debateRepo.update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: panel.name };
  } finally {
    await db.destroy();
  }
}

async function seedPanelWithMultipleDebates(testHome: string): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "export-multi-debate",
      topic: "Panel topic metadata",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const cto = await expertRepo.create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    const pm = await expertRepo.create({
      panelId: panel.id,
      slug: "pm",
      displayName: "PM",
      model: "claude-sonnet-4",
      systemMessage: "You are a PM.",
    });

    const firstDebate = await debateRepo.create({
      panelId: panel.id,
      prompt: "Original first debate prompt",
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: firstDebate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "First debate opening note.",
    });
    await debateRepo.update(firstDebate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });

    const substantiveDebate = await debateRepo.create({
      panelId: panel.id,
      prompt: "Substantive follow-up debate prompt",
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: substantiveDebate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO analysis: shipping behind a feature flag balances risk.",
    });
    await turnRepo.create({
      debateId: substantiveDebate.id,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM analysis: auth checklist must be complete first.",
    });
    await turnRepo.create({
      debateId: substantiveDebate.id,
      round: 1,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO conclusion: ship behind a feature flag after checklist.",
    });
    await turnRepo.create({
      debateId: substantiveDebate.id,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM conclusion: agree to phased launch after checklist.",
    });
    await debateRepo.update(substantiveDebate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });

    const latestShortDebate = await debateRepo.create({
      panelId: panel.id,
      prompt: "Latest but less substantive prompt",
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: latestShortDebate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: pm.id,
      content: "Latest short debate note.",
    });
    await debateRepo.update(latestShortDebate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });

    return { panelName: panel.name };
  } finally {
    await db.destroy();
  }
}

async function seedPanelWithShortTurns(testHome: string): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name: "short-turn-panel",
      topic: "Brief exchange",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const cto = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    const pm = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "pm",
      displayName: "PM",
      model: "claude-sonnet-4",
      systemMessage: "You are a PM.",
    });
    const debate = await new DebateRepository(db).create({
      panelId: panel.id,
      prompt: "Brief exchange prompt",
      moderator: "round-robin",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "Yes.",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "No.",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 1,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "Maybe.",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "Okay.",
    });
    await new DebateRepository(db).update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: panel.name };
  } finally {
    await db.destroy();
  }
}

describe("buildExportCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-export-test-"));
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

  it("registers an 'export' command with required panel arg + format/output options", () => {
    const cmd = buildExportCommand();
    expect(cmd.name()).toBe("export");
    expect(cmd.description()).toMatch(/export|transcript|share|panel/i);
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--format");
    expect(longs).toContain("--output");
  });

  it("rejects unknown panel name with clear error", async () => {
    const cmd = buildExportCommand({ write: () => undefined });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-export", "no-such-panel"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/no panel|not found/);
  });

  it("--format markdown (default): includes topic, status, expert displayNames, content", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({ write: (s) => { captured += s; } });
    await cmd.parseAsync(["node", "council-export", seed.panelName]);

    expect(captured).toContain("Should we ship the MVP?"); // topic / prompt
    expect(captured.toLowerCase()).toMatch(/status.*completed|completed/);
    // Expert attribution by displayName
    expect(captured).toContain("CTO");
    expect(captured).toContain("PM");
    // Turn content
    expect(captured).toContain("ship now to get user feedback fast");
    expect(captured).toContain("hold two weeks for the auth flow");
    expect(captured).toContain("launch behind a feature flag now");
    // Markdown structure — at least one heading
    expect(captured).toMatch(/^#/m);
  });

  it("--format json: emits NDJSON identical-shape to resume --format json", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({ write: (s) => { captured += s; } });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "json"]);

    const lines = captured.split("\n").filter((l) => l.trim().startsWith("{"));
    const events = lines.map((l) => JSON.parse(l) as { kind: string });
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("panel.assembled");
    expect(kinds.filter((k) => k === "turn.end")).toHaveLength(3);
    expect(kinds[kinds.length - 1]).toBe("debate.end");
  });

  it("--format adr: emits ADR template with Status, Context, Options, Decision sections", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({ write: (s) => { captured += s; } });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    // ADR canonical headers
    expect(captured).toMatch(/Decision Record|^# /m);
    expect(captured.toLowerCase()).toContain("status");
    expect(captured.toLowerCase()).toContain("context");
    expect(captured.toLowerCase()).toMatch(/options|positions|considered/);
    expect(captured.toLowerCase()).toContain("decision");
    // The user prompt (Context) must appear
    expect(captured).toContain("Should we ship the MVP?");
    // Final synthesis content should appear in Decision section
    expect(captured).toContain("launch behind a feature flag now");
  });

  it("--format adr: uses the first debate prompt for Context and the selected debate content for the body", async () => {
    const seed = await seedPanelWithMultipleDebates(testHome);
    let captured = "";
    const cmd = buildExportCommand({ write: (s) => { captured += s; } });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    expect(captured).toContain("Original first debate prompt");
    expect(captured).toContain("CTO conclusion: ship behind a feature flag after checklist.");
    expect(captured).toContain("PM conclusion: agree to phased launch after checklist.");
    expect(captured).not.toContain("Latest short debate note.");
  });

  it("--format adr: marks a completed debate with very short turns as Proposed", async () => {
    const seed = await seedPanelWithShortTurns(testHome);
    let captured = "";
    const cmd = buildExportCommand({ write: (s) => { captured += s; } });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    expect(captured).toMatch(/## Status\s+\s*Proposed/m);
    expect(captured).not.toContain("Accepted");
  });

  it("--output <path> writes to file instead of stdout", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const outPath = path.join(testHome, "transcript.md");
    let stdoutCaptured = "";
    const cmd = buildExportCommand({ write: (s) => { stdoutCaptured += s; } });
    await cmd.parseAsync([
      "node",
      "council-export",
      seed.panelName,
      "--format",
      "markdown",
      "--output",
      outPath,
    ]);

    // File should exist with the expected content.
    const fileContent = await fs.readFile(outPath, "utf-8");
    expect(fileContent).toContain("CTO");
    expect(fileContent).toContain("ship now to get user feedback fast");
    // stdout should NOT have the transcript content (only maybe a "Wrote..." confirmation).
    expect(stdoutCaptured).not.toContain("ship now to get user feedback fast");
  });

  it("--format garbage rejects with clear error", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const cmd = buildExportCommand({ write: () => undefined });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-export",
        seed.panelName,
        "--format",
        "yaml",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/yaml|format.*expected|unknown.*format/);
  });

  it("--format adr: single-round debate shows 'no further discussion' message", async () => {
    // Seed a panel with exactly 1 turn per expert (single round, no synthesis round)
    const db = await createDatabase(path.join(testHome, "council.db"));
    let panelName: string;
    try {
      const panel = await new PanelRepository(db).create({
        name: "single-round",
        topic: "Quick decision",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
      });
      const cto = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "cto",
        displayName: "CTO",
        model: "claude-sonnet-4",
        systemMessage: "You are a CTO.",
      });
      const pm = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "pm",
        displayName: "PM",
        model: "claude-sonnet-4",
        systemMessage: "You are a PM.",
      });
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "Quick decision needed",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: "CTO says: ship it immediately.",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 1,
        speakerKind: "expert",
        expertId: pm.id,
        content: "PM says: agreed, let's go.",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      panelName = panel.name;
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildExportCommand({ write: (s) => { captured += s; } });
    await cmd.parseAsync(["node", "council-export", panelName, "--format", "adr"]);

    // Should contain the single-round fallback message
    expect(captured.toLowerCase()).toContain("single round");
    expect(captured.toLowerCase()).toContain("no further discussion");
    expect(captured).toMatch(/## Status\s+\s*Proposed/m);
    // Decision section should still render with expert positions
    expect(captured.toLowerCase()).toContain("decision");
    expect(captured).toContain("CTO");
    expect(captured).toContain("PM");
  });

  it("--format markdown: uses ASCII-safe separators without Unicode em-dash or mojibake", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({ write: (s) => { captured += s; } });
    await cmd.parseAsync(["node", "council-export", seed.panelName]);

    // Should NOT contain Unicode em-dash (U+2014)
    expect(captured).not.toContain("\u2014");
    // Should NOT contain common mojibake patterns for em-dash
    expect(captured).not.toContain("ΓÇö");
    expect(captured).not.toContain("\uFFFD"); // replacement character
    // Should use exact ASCII hyphen separator (issue #737)
    expect(captured).toContain("**CTO** (`cto`) - claude-sonnet-4");
    expect(captured).toContain("**PM** (`pm`) - claude-sonnet-4");
  });
});
