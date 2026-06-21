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
import { copyTemplateDb } from "../../../helpers/template-db.js";

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

async function seedPanelWithUnicodeDebate(
  testHome: string,
): Promise<{ panelName: string; readonly unicodeSnippet: string }> {
  const unicodeSnippet = "Roadmap — ship 2× faster ≥ baseline 🎉";
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "export-unicode",
      topic: unicodeSnippet,
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const cto = await expertRepo.create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO 🎯",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    const debate = await debateRepo.create({
      panelId: panel.id,
      prompt: unicodeSnippet,
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: `CTO position: ${unicodeSnippet}`,
    });
    await debateRepo.update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: panel.name, unicodeSnippet };
  } finally {
    await db.destroy();
  }
}

async function seedPanelWithMultipleDebates(testHome: string): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
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

    const sharedStartedAt = "2026-01-01T00:00:00.000Z";
    await db
      .insertInto("debates")
      .values([
        {
          id: "debate-c-original",
          panel_id: panel.id,
          prompt: "Original first debate prompt",
          status: "completed",
          moderator: "round-robin",
          started_at: sharedStartedAt,
          ended_at: "2026-01-01T00:01:00.000Z",
          cost_estimate: null,
        },
        {
          id: "debate-b-substantive",
          panel_id: panel.id,
          prompt: "Substantive follow-up debate prompt",
          status: "completed",
          moderator: "round-robin",
          started_at: sharedStartedAt,
          ended_at: "2026-01-01T00:02:00.000Z",
          cost_estimate: null,
        },
        {
          id: "debate-a-latest",
          panel_id: panel.id,
          prompt: "Latest but less substantive prompt",
          status: "completed",
          moderator: "round-robin",
          started_at: sharedStartedAt,
          ended_at: "2026-01-01T00:03:00.000Z",
          cost_estimate: null,
        },
      ])
      .execute();
    const firstDebate = { id: "debate-c-original" };
    await turnRepo.create({
      debateId: firstDebate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "First debate opening note.",
    });
    const substantiveDebate = { id: "debate-b-substantive" };
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
    const latestShortDebate = { id: "debate-a-latest" };
    await turnRepo.create({
      debateId: latestShortDebate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: pm.id,
      content: "Latest short debate note.",
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
  let originalDataHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-export-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    originalDataHome = process.env["COUNCIL_DATA_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    process.env["COUNCIL_DATA_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
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

  it("explains when a panel template exists but no debates have been created", async () => {
    const panelsDir = path.join(testHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(
      path.join(panelsDir, "empty-panel.yaml"),
      [
        "name: empty-panel",
        "description: Empty panel template",
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

    const cmd = buildExportCommand({ write: () => undefined });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-export", "empty-panel"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).toMatch(/exists but has no debates yet/i);
    expect(thrown).toMatch(/convene --template empty-panel/i);
  });

  it("checks the separate data home before reporting a template-only panel as missing", async () => {
    const dataHomeBeforeOverride = process.env["COUNCIL_DATA_HOME"];
    const libraryHome = path.join(testHome, "library-home");
    const panelsDir = path.join(libraryHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(
      path.join(panelsDir, "data-home-template.yaml"),
      [
        "name: data-home-template",
        "description: Template stored in the separate data home",
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
      const cmd = buildExportCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync(["node", "council-export", "data-home-template"]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown).toMatch(/exists but has no debates yet/i);
      expect(thrown).toMatch(/convene --template data-home-template/i);
    } finally {
      if (dataHomeBeforeOverride === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = dataHomeBeforeOverride;
    }
  });

  it("uses config.paths.dataHome when resolving template-only panel errors", async () => {
    const dataHomeBeforeOverride = process.env["COUNCIL_DATA_HOME"];
    const libraryHome = path.join(testHome, "config-data-home");
    const panelsDir = path.join(libraryHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(
      path.join(panelsDir, "config-export-template.yaml"),
      [
        "name: config-export-template",
        "description: Template stored in config.paths.dataHome",
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
      const cmd = buildExportCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync(["node", "council-export", "config-export-template"]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown).toMatch(/exists but has no debates yet/i);
      expect(thrown).toMatch(/convene --template config-export-template/i);
    } finally {
      if (dataHomeBeforeOverride === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = dataHomeBeforeOverride;
    }
  });

  it("does not emit the contradictory 'No panel found matching' diagnostic on the config-dataHome retry path", async () => {
    const dataHomeBeforeOverride = process.env["COUNCIL_DATA_HOME"];
    const libraryHome = path.join(testHome, "config-data-home-silent");
    const panelsDir = path.join(libraryHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(
      path.join(panelsDir, "silent-probe-template.yaml"),
      [
        "name: silent-probe-template",
        "description: Template stored only in config.paths.dataHome",
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
      let stderr = "";
      const cmd = buildExportCommand({
        write: () => undefined,
        writeError: (s) => {
          stderr += s;
        },
      });
      cmd.exitOverride();
      try {
        await cmd.parseAsync(["node", "council-export", "silent-probe-template"]);
      } catch {
        /* expected */
      }
      expect(stderr).toMatch(/exists but has no debates yet/i);
      expect(stderr).toMatch(/convene --template silent-probe-template/i);
      expect(stderr).not.toMatch(/No panel found matching/i);
    } finally {
      if (dataHomeBeforeOverride === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = dataHomeBeforeOverride;
    }
  });

  it("--format markdown (default): includes topic, status, expert displayNames, content", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
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
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
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
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
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

  it("--format adr: uses the first debate prompt for Context and includes content from all debates", async () => {
    const seed = await seedPanelWithMultipleDebates(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    // Context is always the FIRST debate's prompt (original question).
    expect(captured).toContain("Original first debate prompt");
    // All resumed debate turns must appear in the Discussion section.
    expect(captured).toContain("First debate opening note.");
    expect(captured).toContain("CTO analysis: shipping behind a feature flag balances risk.");
    expect(captured).toContain("CTO conclusion: ship behind a feature flag after checklist.");
    expect(captured).toContain("PM conclusion: agree to phased launch after checklist.");
    // The latest debate's turn must also be present now.
    expect(captured).toContain("Latest short debate note.");
  });

  it("--format adr: marks a completed debate with very short turns as Proposed", async () => {
    const seed = await seedPanelWithShortTurns(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    expect(captured).toMatch(/## Status\s+\s*Proposed/m);
    expect(captured).not.toContain("Accepted");
  });

  it("--output <path> writes to file instead of stdout", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const outPath = path.join(testHome, "transcript.md");
    let stdoutCaptured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        stdoutCaptured += s;
      },
    });
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

  it("--output <path> preserves UTF-8 punctuation and emoji in markdown exports", async () => {
    const seed = await seedPanelWithUnicodeDebate(testHome);
    const outPath = path.join(testHome, "transcript-unicode.md");
    const cmd = buildExportCommand({ write: () => undefined });
    await cmd.parseAsync([
      "node",
      "council-export",
      seed.panelName,
      "--format",
      "markdown",
      "--output",
      outPath,
    ]);

    const fileBytes = await fs.readFile(outPath);
    expect(fileBytes.includes(Buffer.from(seed.unicodeSnippet, "utf8"))).toBe(true);
    expect(fileBytes.toString("utf8")).toContain(seed.unicodeSnippet);
    expect(fileBytes.toString("utf8")).toContain("CTO 🎯");
  });

  it("--format garbage rejects with clear error", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const cmd = buildExportCommand({ write: () => undefined });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "yaml"]);
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
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
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

  it("matches a panel by unique name prefix (parity with `council resume`)", async () => {
    const seed = await seedPanelWithDebate(testHome); // name = "export-test"
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    // Use a short unambiguous prefix instead of the full name.
    await cmd.parseAsync(["node", "council-export", "export-te"]);

    expect(captured).toContain("CTO");
    expect(captured).toContain("ship now to get user feedback fast");
    // Header should use the full resolved panel name.
    expect(captured).toContain(`# ${seed.panelName}`);
  });

  it("rejects ambiguous prefix and lists matching panels", async () => {
    // Two panels both starting with "export-".
    await seedPanelWithDebate(testHome); // "export-test"
    await seedPanelWithMultipleDebates(testHome); // "export-multi-debate"

    let errCaptured = "";
    const cmd = buildExportCommand({
      write: () => undefined,
      writeError: (s) => {
        errCaptured += s;
      },
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-export", "export"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/ambiguous|multiple/);
    expect(errCaptured).toContain("export-test");
    expect(errCaptured).toContain("export-multi-debate");
  });

  it("exact name match still works when a longer name shares the same prefix (backward compatible)", async () => {
    // Seed two panels: "export-test" and "export-test-extended".
    await seedPanelWithDebate(testHome); // "export-test"
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panel = await new PanelRepository(db).create({
        name: "export-test-extended",
        topic: "Different topic",
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
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "Different prompt",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: "Extended panel content marker.",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    // Exact name "export-test" must resolve to the export-test panel,
    // NOT trigger an ambiguous-prefix error against "export-test-extended".
    await cmd.parseAsync(["node", "council-export", "export-test"]);

    expect(captured).toContain("ship now to get user feedback fast");
    expect(captured).not.toContain("Extended panel content marker.");
  });

  it("--format markdown: includes turns from ALL debates of a resumed panel", async () => {
    const seed = await seedPanelWithMultipleDebates(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName]);

    // Every debate's content must appear.
    expect(captured).toContain("First debate opening note.");
    expect(captured).toContain("CTO analysis: shipping behind a feature flag balances risk.");
    expect(captured).toContain("PM analysis: auth checklist must be complete first.");
    expect(captured).toContain("CTO conclusion: ship behind a feature flag after checklist.");
    expect(captured).toContain("PM conclusion: agree to phased launch after checklist.");
    expect(captured).toContain("Latest short debate note.");
  });

  it("--format json: NDJSON includes turn.end events from ALL debates of a resumed panel", async () => {
    const seed = await seedPanelWithMultipleDebates(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "json"]);

    const events = captured
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => JSON.parse(l) as { kind: string; content?: string });
    const turnEnds = events.filter((e) => e.kind === "turn.end");
    // 1 + 4 + 1 = 6 turns across the three debates.
    expect(turnEnds).toHaveLength(6);
    const contents = turnEnds.map((e) => e.content);
    expect(contents).toContain("First debate opening note.");
    expect(contents).toContain("CTO conclusion: ship behind a feature flag after checklist.");
    expect(contents).toContain("Latest short debate note.");
  });

  it("--format markdown: uses ASCII-safe separators without Unicode em-dash or mojibake", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
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
